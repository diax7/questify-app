import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EmailMessage, EmailSender } from "#src/auth/email/sender";
import { startOrganizerAlertWorker } from "#src/organizer-alerts/worker";
import { pushFixture, sqlstate, type PushFixture } from "#test/support/push";
import { TEST_DATABASE_URL, addMember } from "#test/support/test-db";

type AlertRow = {
  staff_user_id: string;
  alert_type: string;
  state: string;
  code: string | null;
  event_id: string | null;
};
type Team = Readonly<{ org: string; owner: string; editor: string; scoped: string; event: string }>;

const ALL_ON = {
  activated: true,
  stock_low: true,
  codes_low: true,
  new_flags: true,
  content_unpublished: true,
  support_access: true,
  size_limit: true,
};

const mailer = (failing: (to: string) => boolean = () => false) => {
  const sent: EmailMessage[] = [];
  const attempts: string[] = [];
  const sender: EmailSender = {
    name: "fake",
    send: (message) => {
      attempts.push(message.to);
      if (failing(message.to)) return Promise.reject(new Error("provider down"));
      sent.push(message);
      return Promise.resolve();
    },
  };
  return { sender, sent, attempts };
};

/**
 * The organizer alert switches, outbox, producers and sender in the database (T-503, FR-1727, migration 0082, ADR-362):
 * a member sets only their own seven switches; each wired source writes one row per eligible member at the moment it
 * happens; the sender re-checks the member, the account, the event limit and the switch when it sends; a fake transport
 * stands in for the mail provider, which stays off.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("organizer alerts (database)", () => {
  let f: PushFixture;
  beforeAll(async () => {
    f = await pushFixture();
  });
  afterAll(async () => {
    await f.close();
  });

  /** A new organizer with an owner, an editor, an editor limited to one other event, and a live event. */
  const newTeam = async (phase: "live" | "scheduled" = "live"): Promise<Team> => {
    const [made] = await f.owner<{ id: string }>(
      "INSERT INTO organizer (name, slug) VALUES ('Alert Org', $1) RETURNING id",
      [`alert-${randomUUID().slice(0, 8)}`],
    );
    const org = made?.id ?? "";
    const owner = await addMember(f.db.owner, org, "owner");
    const editor = await addMember(f.db.owner, org, "editor");
    const other = await f.newEvent({ phase: "live", organizer: org });
    const scoped = await addMember(f.db.owner, org, "editor", [other]);
    const event = await f.newEvent({ phase, organizer: org });
    return { org, owner, editor, scoped, event };
  };
  const alerts = (org: string, type?: string) =>
    f.owner<AlertRow>(
      `SELECT staff_user_id, alert_type, state, code, event_id FROM organizer_alert
       WHERE organizer_id = $1 AND ($2::text IS NULL OR alert_type = $2) ORDER BY id`,
      [org, type ?? null],
    );
  const staffOf = async (org: string, type?: string) =>
    (await alerts(org, type)).map((row) => row.staff_user_id).toSorted();
  const switches = (team: Team, staff: string) =>
    f
      .run<{ r: Record<string, boolean> }>(
        f.team(staff, team.org),
        "SELECT own_alert_switches($1) AS r",
        [team.org],
      )
      .then((rows) => rows[0]?.r);
  const setSwitches = (team: Team, staff: string, body: unknown) =>
    f.run<{ r: Record<string, boolean> }>(
      f.team(staff, team.org),
      "SELECT set_own_alert_switches($1, $2::jsonb, $3) AS r",
      [team.org, JSON.stringify(body), randomUUID()],
    );
  const switchOff = (team: Team, staff: string, type: string) =>
    setSwitches(team, staff, { ...ALL_ON, [type]: false });

  const draftEvent = async (org: string) => {
    const [made] = await f.owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at, kind)
       VALUES ($1, $2, 'Draft', 'draft', now() + interval '1 day', now() + interval '2 days', 'virtual')
       RETURNING id`,
      [org, `DRF${randomUUID().slice(0, 8).toUpperCase()}`],
    );
    return made?.id ?? "";
  };

  const reward = async (event: string, kind: string, total: number, out: number) => {
    const [made] = await f.owner<{ id: string }>(
      `INSERT INTO reward (event_id, kind, name_en, price, stock_total, units_out)
       VALUES ($1, $2, 'Cap', 5, $3, $4) RETURNING id`,
      [event, kind, total, out],
    );
    return made?.id ?? "";
  };
  const stock = (id: string, total: number, out: number) =>
    f.owner("UPDATE reward SET stock_total = $2, units_out = $3 WHERE id = $1", [id, total, out]);

  const flagFor = async (event: string, via: string | null = null) => {
    const player = await f.newPlayer();
    const enrollment = await f.join(event, player, via);
    await f.owner(
      `INSERT INTO flag (organizer_id, event_id, enrollment_id, kind)
       SELECT organizer_id, id, $2, 'burst' FROM event WHERE id = $1`,
      [event, enrollment],
    );
  };
  const scan = () => f.one<number>(f.system, "SELECT alert_scan_flags(2000) AS r");

  const worker = (transport?: EmailSender, sendDeadlineMs?: number) =>
    startOrganizerAlertWorker({
      pool: f.pool,
      ...(transport === undefined ? {} : { transport }),
      ...(sendDeadlineMs === undefined ? {} : { sendDeadlineMs }),
      dashboardOrigin: "https://dashboard.test",
      intervalMs: 3_600_000,
      log: () => undefined,
    });
  const run = async (transport?: EmailSender, sendDeadlineMs?: number) => {
    const instance = worker(transport, sendDeadlineMs);
    try {
      return await instance.runOnce();
    } finally {
      await instance.stop();
    }
  };
  const addressOf = async (staff: string) =>
    (await f.owner<{ email: string }>("SELECT email FROM staff_user WHERE id = $1", [staff]))[0]
      ?.email ?? "";
  const queue = async (team: Team) => {
    await f.owner("DELETE FROM organizer_alert");
    await f.owner(
      "UPDATE flag SET raised_at = now() - interval '1 hour' WHERE raised_at > now() - interval '30 minutes'",
    );
    await f.owner(
      `INSERT INTO event_limit_alert (event_id, organizer_id, level, players)
       VALUES ($1, $2, 100, 10) ON CONFLICT DO NOTHING`,
      [team.event, team.org],
    );
  };
  const stateOf = async (team: Team, staff: string) =>
    (await alerts(team.org)).find((row) => row.staff_user_id === staff);

  describe("the switches", () => {
    it("are all on until the member saves them, and only the member's own change", async () => {
      const team = await newTeam();
      expect(await switches(team, team.owner)).toEqual(ALL_ON);
      await switchOff(team, team.editor, "new_flags");
      expect(await switches(team, team.editor)).toEqual({ ...ALL_ON, new_flags: false });
      expect(await switches(team, team.owner)).toEqual(ALL_ON);
      expect(await switches(team, team.scoped)).toEqual(ALL_ON);
    });

    it("take the whole set of seven booleans and nothing else", async () => {
      const team = await newTeam();
      const { activated: _dropped, ...partial } = ALL_ON;
      for (const body of [
        partial,
        { ...ALL_ON, marketing: true },
        { ...ALL_ON, activated: "true" },
        { ...ALL_ON, activated: null },
        [true],
        "on",
        null,
      ]) {
        expect(await sqlstate(setSwitches(team, team.owner, body)), JSON.stringify(body)).toBe(
          "AL422",
        );
      }
      expect(await switches(team, team.owner)).toEqual(ALL_ON);
    });

    it("audit a change with the booleans only, and a repeat of the same body writes nothing", async () => {
      const team = await newTeam();
      await switchOff(team, team.editor, "support_access");
      await switchOff(team, team.editor, "support_access");
      const log = await f.owner<{ actor_id: string; before: unknown; after: unknown }>(
        `SELECT actor_id, before, after FROM audit_log
         WHERE organizer_id = $1 AND action = 'organizer.alerts_set'`,
        [team.org],
      );
      expect(log).toEqual([
        { actor_id: team.editor, before: ALL_ON, after: { ...ALL_ON, support_access: false } },
      ]);
    });

    it("refuse everyone but the calling member of that organizer", async () => {
      const team = await newTeam();
      const other = await newTeam();
      const stranger = await f.newPlayer();
      const seats = [
        f.team(other.owner, other.org),
        { organizerId: team.org, staffUserId: other.owner },
        { playerId: stranger },
        { isAdmin: true },
        {},
      ];
      for (const seat of seats) {
        expect(await sqlstate(f.run(seat, "SELECT own_alert_switches($1)", [team.org]))).toBe(
          "AL404",
        );
        expect(
          await sqlstate(
            f.run(seat, "SELECT set_own_alert_switches($1, $2::jsonb, NULL)", [
              team.org,
              JSON.stringify(ALL_ON),
            ]),
          ),
        ).toBe("AL404");
      }
      // A member asking for another organizer's switches is refused too.
      expect(
        await sqlstate(
          f.run(f.team(team.owner, team.org), "SELECT own_alert_switches($1)", [other.org]),
        ),
      ).toBe("AL404");
      await f.owner("UPDATE staff_user SET status = 'disabled' WHERE id = $1", [team.editor]);
      expect(
        await sqlstate(
          f.run(f.team(team.editor, team.org), "SELECT own_alert_switches($1)", [team.org]),
        ),
      ).toBe("AL404");
    });

    it("go with the membership, and a member invited again starts from on", async () => {
      const team = await newTeam();
      await switchOff(team, team.editor, "activated");
      await f.owner("DELETE FROM organizer_member WHERE organizer_id = $1 AND staff_user_id = $2", [
        team.org,
        team.editor,
      ]);
      expect(
        await f.owner("SELECT 1 FROM organizer_alert_switch WHERE staff_user_id = $1", [
          team.editor,
        ]),
      ).toEqual([]);
      await f.owner(
        "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'editor')",
        [team.org, team.editor],
      );
      expect(await switches(team, team.editor)).toEqual(ALL_ON);
    });
  });

  describe("the producers", () => {
    it("write one row per eligible member when an event is activated, once per event", async () => {
      const team = await newTeam();
      const gone = await addMember(f.db.owner, team.org, "editor");
      await f.owner("UPDATE staff_user SET status = 'disabled' WHERE id = $1", [gone]);
      await switchOff(team, team.editor, "activated");
      const event = await draftEvent(team.org);
      await f.owner("UPDATE event SET status = 'scheduled' WHERE id = $1", [event]);
      // The editor limited to another event and the one who switched it off get nothing, nor does a disabled account.
      expect(await staffOf(team.org, "activated")).toEqual([team.owner].toSorted());
      await f.owner("UPDATE event SET status = 'draft' WHERE id = $1", [event]);
      await f.owner("UPDATE event SET status = 'scheduled' WHERE id = $1", [event]);
      expect(await alerts(team.org, "activated")).toHaveLength(1);
      expect((await alerts(team.org, "activated"))[0]?.event_id).toBe(event);
    });

    it("write nothing for another organizer's team", async () => {
      const team = await newTeam();
      const other = await newTeam();
      await f.owner(
        "INSERT INTO event_limit_alert (event_id, organizer_id, level, players) VALUES ($1, $2, 80, 8)",
        [team.event, team.org],
      );
      expect(await alerts(other.org)).toEqual([]);
      expect(await staffOf(team.org, "size_limit")).toEqual([team.owner, team.editor].toSorted());
    });

    it("write a row for each size mark as it is recorded, and again when an activation records it anew", async () => {
      const team = await newTeam();
      await f.owner(
        "INSERT INTO event_limit_alert (event_id, organizer_id, level, players) VALUES ($1, $2, 80, 8), ($1, $2, 100, 10)",
        [team.event, team.org],
      );
      expect(await alerts(team.org, "size_limit")).toHaveLength(4);
      await f.owner("DELETE FROM event_limit_alert WHERE event_id = $1", [team.event]);
      await f.owner(
        "INSERT INTO event_limit_alert (event_id, organizer_id, level, players) VALUES ($1, $2, 80, 8)",
        [team.event, team.org],
      );
      expect(await alerts(team.org, "size_limit")).toHaveLength(6);
    });

    it("open a stock alert only when a reward crosses into low, and again only after it recovered", async () => {
      const team = await newTeam();
      const id = await reward(team.event, "item", 100, 80);
      await stock(id, 100, 89);
      expect(await alerts(team.org)).toEqual([]);
      await stock(id, 100, 90);
      expect(await alerts(team.org, "stock_low")).toHaveLength(2);
      // Deeper into the same episode, and a total change that keeps it low, add nothing.
      await stock(id, 100, 95);
      await stock(id, 101, 90);
      await stock(id, 101, 101);
      expect(await alerts(team.org, "stock_low")).toHaveLength(2);
      // Recovery closes the episode without a mail; the next fall opens a new one.
      await stock(id, 102, 90);
      expect(await alerts(team.org)).toHaveLength(2);
      await stock(id, 102, 91);
      expect(await alerts(team.org, "stock_low")).toHaveLength(4);
    });

    it("count a digital reward as codes, and skip a reward that cannot run low or is not in play", async () => {
      const team = await newTeam();
      const digital = await reward(team.event, "digital", 50, 0);
      await stock(digital, 50, 45);
      expect(await alerts(team.org, "codes_low")).toHaveLength(2);
      expect(await alerts(team.org, "stock_low")).toEqual([]);
      const none = await reward(team.event, "item", 0, 0);
      await f.owner("UPDATE reward SET name_en = 'Cap 2' WHERE id = $1", [none]);
      const removed = await reward(team.event, "item", 10, 0);
      await f.owner("UPDATE reward SET status = 'removed' WHERE id = $1", [removed]);
      await stock(removed, 10, 10);
      expect(await alerts(team.org)).toHaveLength(2);
      // Before the start only rehearsal accounts reserve: no alert.
      const early = await newTeam("scheduled");
      const rehearsed = await reward(early.event, "item", 10, 0);
      await stock(rehearsed, 10, 10);
      expect(await alerts(early.org)).toEqual([]);
    });

    it("write one row per admin, event and day when support reads the event's tickets", async () => {
      const team = await newTeam();
      const admin = randomUUID();
      const read = (actor: string) =>
        f.owner(
          `INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id)
           VALUES ('admin', $3, $1, $2, 'console.ticket_read', 'ticket', '7')`,
          [team.org, team.event, actor],
        );
      await read(admin);
      await read(admin);
      expect(await staffOf(team.org, "support_access")).toEqual(
        [team.owner, team.editor].toSorted(),
      );
      await read(randomUUID());
      expect(await alerts(team.org, "support_access")).toHaveLength(4);
      await f.owner(
        `INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id)
         VALUES ('admin', $3, $1, $2, 'console.ticket_list', 'ticket', '7')`,
        [team.org, team.event, admin],
      );
      expect(await alerts(team.org, "support_access")).toHaveLength(4);
    });

    it("find new flags by a scan, once each, never a rehearsal account's or an old one", async () => {
      const team = await newTeam();
      await flagFor(team.event);
      await flagFor(team.event, "rehearsal");
      expect(await alerts(team.org)).toEqual([]);
      expect(await scan()).toBe(2);
      expect(await staffOf(team.org, "new_flags")).toEqual([team.owner, team.editor].toSorted());
      expect(await scan()).toBe(0);
      expect(await alerts(team.org, "new_flags")).toHaveLength(2);
      await flagFor(team.event);
      await scan();
      expect(await alerts(team.org, "new_flags")).toHaveLength(4);
      await f.owner(
        "UPDATE flag SET raised_at = now() - interval '20 minutes' WHERE event_id = $1",
        [team.event],
      );
      await flagFor(team.event);
      await f.owner("DELETE FROM organizer_alert WHERE organizer_id = $1", [team.org]);
      await scan();
      expect(await alerts(team.org, "new_flags")).toHaveLength(2);
    });
  });

  describe("the sender", () => {
    it("sends one email to each eligible member, fixed and bilingual, with ids in the links only", async () => {
      const team = await newTeam();
      await queue(team);
      const { sender, sent } = mailer();
      expect(await run(sender)).toEqual({ sent: 2, uncertain: 0, flags: 0 });
      expect(sent.map((mail) => mail.to).toSorted()).toEqual(
        [await addressOf(team.owner), await addressOf(team.editor)].toSorted(),
      );
      const [mail] = sent;
      expect(mail?.subject).toBe("حد اللاعبين | Player limit");
      expect(mail?.text).toContain(
        `https://dashboard.test/ar/organizers/${team.org}/events/${team.event}`,
      );
      expect(mail?.text).toContain(`https://dashboard.test/en/organizers/${team.org}/team`);
      expect(mail?.text).not.toMatch(/Tech Fest|Alert Org|Draft/);
      expect((await alerts(team.org)).map((row) => row.state)).toEqual(["sent", "sent"]);
      expect(await run(sender)).toEqual({ sent: 0, uncertain: 0, flags: 0 });
    });

    it("sends nothing and reads no address while the transport is off", async () => {
      const team = await newTeam();
      await queue(team);
      expect(await run()).toEqual({ sent: 0, uncertain: 0, flags: 0 });
      expect(await alerts(team.org)).toEqual([
        expect.objectContaining({ state: "skipped", code: "transport_off" }),
        expect.objectContaining({ state: "skipped", code: "transport_off" }),
      ]);
    });

    it("checks the member again when it sends: removed, disabled, rejoined, out of scope, switched off since", async () => {
      const team = await newTeam();
      const removed = await addMember(f.db.owner, team.org, "editor");
      const disabled = await addMember(f.db.owner, team.org, "editor");
      const rejoined = await addMember(f.db.owner, team.org, "editor");
      const narrowed = await addMember(f.db.owner, team.org, "editor");
      const muted = await addMember(f.db.owner, team.org, "editor");
      await queue(team);
      await f.owner("DELETE FROM organizer_member WHERE staff_user_id = $1", [removed]);
      await f.owner("UPDATE staff_user SET status = 'disabled' WHERE id = $1", [disabled]);
      await f.owner("DELETE FROM organizer_member WHERE staff_user_id = $1", [rejoined]);
      await f.owner(
        "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'editor')",
        [team.org, rejoined],
      );
      const elsewhere = await f.newEvent({ phase: "live", organizer: team.org });
      await f.owner("UPDATE organizer_member SET event_scope = $2 WHERE staff_user_id = $1", [
        narrowed,
        [elsewhere],
      ]);
      await switchOff(team, muted, "size_limit");
      const { sender, sent } = mailer();
      // The rows are numbered in the order of the members' random ids, five rows are claimed at a time, and a claim that
      // finds only rows to skip ends a run (FOLLOWUPS, T-503): about one run in twenty ends before the two sendable rows
      // are reached. The second run reaches them in every order.
      const first = await run(sender);
      const second = await run(sender);
      expect(first.sent + second.sent).toBe(2);
      expect(sent.map((mail) => mail.to).toSorted()).toEqual(
        [await addressOf(team.owner), await addressOf(team.editor)].toSorted(),
      );
      const reasons: Record<string, string | undefined> = {
        [removed]: "member",
        [disabled]: "staff",
        [rejoined]: "member",
        [narrowed]: "scope",
        [muted]: "switch",
      };
      for (const [staff, code] of Object.entries(reasons)) {
        expect(await stateOf(team, staff), staff).toMatchObject({ state: "skipped", code });
      }
    });

    it("records a failed send as not known and never sends it again", async () => {
      const team = await newTeam();
      await queue(team);
      const down = await addressOf(team.editor);
      const { sender, sent, attempts } = mailer((to) => to === down);
      expect(await run(sender)).toEqual({ sent: 1, uncertain: 1, flags: 0 });
      expect(await stateOf(team, team.editor)).toMatchObject({
        state: "uncertain",
        code: "send_failed",
      });
      expect(await run(sender)).toEqual({ sent: 0, uncertain: 0, flags: 0 });
      expect(attempts.filter((to) => to === down)).toHaveLength(1);
      expect(sent).toHaveLength(1);
    });

    it("records a send that never answers as not known once its deadline passes, and does not send it again", async () => {
      const team = await newTeam();
      await queue(team);
      const attempts: string[] = [];
      const silent: EmailSender = {
        name: "silent",
        send: (message) => {
          attempts.push(message.to);
          return new Promise<void>(() => undefined);
        },
      };
      expect(await run(silent, 30)).toEqual({ sent: 0, uncertain: 2, flags: 0 });
      expect((await alerts(team.org)).map((row) => [row.state, row.code])).toEqual([
        ["uncertain", "send_failed"],
        ["uncertain", "send_failed"],
      ]);
      expect(await run(silent, 30)).toEqual({ sent: 0, uncertain: 0, flags: 0 });
      expect(attempts).toHaveLength(2);
    });

    it("expires a lease that ran out and a row that waited a day, and ignores a stale acknowledgement", async () => {
      const team = await newTeam();
      await queue(team);
      const leased = await f.run<{ alert_id: string; lease: string }>(
        f.system,
        "SELECT * FROM alert_claim(1)",
      );
      const [row] = leased;
      expect(row?.lease).toBeDefined();
      const wrong = await f.one<number>(
        f.system,
        "SELECT alert_ack($1::bigint[], $2::uuid[], '{sent}', '{null}') AS r",
        [[row?.alert_id], [randomUUID()]],
      );
      expect(wrong).toBe(0);
      await f.owner(
        "UPDATE organizer_alert SET lease_until = now() - interval '1 second' WHERE id = $1",
        [row?.alert_id],
      );
      await f.owner(
        "UPDATE organizer_alert SET created_at = now() - interval '25 hours' WHERE state = 'queued'",
      );
      await f.one(f.system, "SELECT alert_settle(true) AS r");
      const states = (await alerts(team.org)).map((one) => [one.state, one.code]);
      expect(states.toSorted()).toEqual([
        ["skipped", "expired"],
        ["uncertain", "lease_expired"],
      ]);
      const late = await f.one<number>(
        f.system,
        "SELECT alert_ack($1::bigint[], $2::uuid[], '{sent}', '{null}') AS r",
        [[row?.alert_id], [row?.lease]],
      );
      expect(late).toBe(0);
    });

    it("deletes finished rows after 30 days", async () => {
      const team = await newTeam();
      await queue(team);
      await run();
      await f.owner("UPDATE organizer_alert SET finished_at = now() - interval '31 days'");
      await f.one(f.system, "SELECT alert_settle(false) AS r");
      expect(await alerts(team.org)).toEqual([]);
    });

    it("answers the system seat only", async () => {
      const team = await newTeam();
      for (const seat of [
        f.team(team.owner, team.org),
        { playerId: await f.newPlayer() },
        { isAdmin: true },
      ]) {
        for (const call of [
          "SELECT * FROM alert_claim(5)",
          "SELECT alert_settle(true)",
          "SELECT alert_scan_flags(10)",
          "SELECT alert_ack('{}'::bigint[], '{}'::uuid[], '{}'::text[], '{}'::text[])",
        ]) {
          expect(await sqlstate(f.run(seat, call)), call).toBe("PN403");
        }
      }
    });
  });
});
