import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withRequestContext, type RequestContext } from "#src/db/context";
import {
  TEST_DATABASE_URL,
  addMember,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

type Row = Record<string, unknown>;
type Joined = {
  outcome: string;
  enrollment_id: string | null;
  event_id: string | null;
  status: string | null;
  welcome: number;
};

/**
 * Join fields, the guest list, the email-domain lock and the welcome reward in the database (T-212, migration 0028).
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("join fields and locks (database)", () => {
  let db: TestDatabase;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let staffA: string;
  let staffB: string;
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    ids = await seedTwoTenants(db.owner);
    staffA = await addMember(db.owner, ids.orgA);
    staffB = await addMember(db.owner, ids.orgB);
  });
  afterAll(async () => {
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const as = async <T extends Row>(
    context: RequestContext,
    sql: string,
    values: unknown[] = [],
    client: Client = db.app,
  ) => withRequestContext(client, context, async () => (await client.query<T>(sql, values)).rows);
  const teamA = (): RequestContext => ({ organizerId: ids.orgA, staffUserId: staffA });
  const teamB = (): RequestContext => ({ organizerId: ids.orgB, staffUserId: staffB });
  const setWelcome = (event: string, amount: number | null) =>
    as(teamA(), "UPDATE event SET welcome_points = $2 WHERE id = $1", [event, amount]);

  type EventSpec = {
    access?: "public" | "unlisted" | "private";
    status?: string;
    methods?: string[];
    startsIn?: string;
    endsIn?: string;
    guestListOnly?: boolean;
    domains?: string[];
    welcome?: number | null;
  };

  const newEvent = async (spec: EventSpec = {}): Promise<{ id: string; code: string }> => {
    counter += 1;
    const code = `JF${String(counter).padStart(4, "0")}`;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, access, join_methods, starts_at, ends_at,
                          guest_list_only, email_domains, welcome_points)
       VALUES ($1, $2, 'Field Day', $3, $4, $5, now() + $6::interval, now() + $7::interval, $8, $9, $10)
       RETURNING id`,
      [
        ids.orgA,
        code,
        spec.status ?? "live",
        spec.access ?? "public",
        spec.methods ?? ["code", "qr", "link"],
        spec.startsIn ?? "-1 hour",
        spec.endsIn ?? "1 day",
        spec.guestListOnly ?? false,
        spec.domains ?? [],
        spec.welcome ?? null,
      ],
    );
    return { id: event?.id ?? "", code };
  };

  const newPlayer = async (contact: { phone?: string; email?: string } = {}): Promise<string> => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`fielder_${counter}`],
    );
    const id = player?.id ?? "";
    await owner("INSERT INTO player_contact (player_id, phone_e164, email) VALUES ($1, $2, $3)", [
      id,
      contact.phone ?? null,
      contact.email ?? `p${counter}@example.com`,
    ]);
    return id;
  };

  const addField = async (
    event: string,
    kind: string,
    options: { required?: boolean; position?: number; label?: string } = {},
  ) =>
    (
      await as<{ id: string }>(
        teamA(),
        `INSERT INTO event_join_field (event_id, kind, label_en, required, position)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [
          event,
          kind,
          options.label ?? (kind === "custom" ? "Section" : null),
          options.required ?? false,
          options.position ?? 0,
        ],
      )
    )[0]?.id ?? "";

  const addGuest = (event: string, kind: string, value: string) =>
    as(teamA(), "INSERT INTO event_guest (event_id, kind, value) VALUES ($1, $2, $3)", [
      event,
      kind,
      value,
    ]);

  const join = async (
    player: string,
    code: string,
    answers: unknown = {},
    client: Client = db.app,
  ): Promise<Joined | undefined> =>
    (
      await as<Joined>(
        { playerId: player },
        "SELECT * FROM join_event($1, 'code', '0.2', $2::jsonb)",
        [code, JSON.stringify(answers)],
        client,
      )
    )[0];

  const joinInvited = async (player: string, event: string, answers: unknown = {}) =>
    (
      await as<Joined>({ playerId: player }, "SELECT * FROM join_invited($1, '0.2', $2::jsonb)", [
        event,
        JSON.stringify(answers),
      ])
    )[0];

  const welcomeEntries = async (player: string, event: string) =>
    owner<{ score_delta: string; balance_delta: string; actor: string }>(
      `SELECT l.score_delta, l.balance_delta, l.actor FROM ledger_entry l
       JOIN enrollment n ON n.id = l.enrollment_id
       WHERE n.player_id = $1 AND n.event_id = $2 AND l.kind = 'welcome'`,
      [player, event],
    );

  const enrollmentOf = async (player: string, event: string) =>
    (
      await owner<{
        id: string;
        status: string;
        score: string;
        balance: string;
        joined_via: string;
      }>(
        "SELECT id, status, score, balance, joined_via FROM enrollment WHERE player_id = $1 AND event_id = $2",
        [player, event],
      )
    )[0];

  describe("join fields", () => {
    it("lets the team add up to five, one of each kind but custom, a custom one with a label", async () => {
      const event = await newEvent();
      await addField(event.id, "full_name", { position: 0 });
      await expect(addField(event.id, "full_name", { position: 1 })).rejects.toThrow(
        /event_join_field_kind_key/,
      );
      await expect(
        as(
          teamA(),
          "INSERT INTO event_join_field (event_id, kind, position) VALUES ($1, 'custom', 1)",
          [event.id],
        ),
      ).rejects.toThrow(/check constraint/);
      await expect(
        as(
          teamA(),
          "INSERT INTO event_join_field (event_id, kind, label_en, position) VALUES ($1, 'company', 'Firm', 1)",
          [event.id],
        ),
      ).rejects.toThrow(/check constraint/);
      for (const [position, kind] of ["company", "job_title", "department", "custom"].entries()) {
        await addField(event.id, kind, { position: position + 1 });
      }
      await expect(addField(event.id, "custom", { position: 4 })).rejects.toMatchObject({
        code: "QF409",
      });
      expect(
        await owner("SELECT 1 FROM event_join_field WHERE event_id = $1", [event.id]),
      ).toHaveLength(5);
    });

    it("refuses five rows in one statement past the cap", async () => {
      const event = await newEvent();
      await addField(event.id, "custom", { position: 0 });
      await expect(
        as(
          teamA(),
          `INSERT INTO event_join_field (event_id, kind, label_en, position)
           SELECT $1, 'custom', 'Extra ' || n, n % 5 FROM generate_series(1, 5) n`,
          [event.id],
        ),
      ).rejects.toMatchObject({ code: "QF409" });
    });

    it("hides an event's fields from another organizer and from players, and refuses a write in its name", async () => {
      const event = await newEvent();
      await addField(event.id, "company");
      expect(
        await as(teamB(), "SELECT * FROM event_join_field WHERE event_id = $1", [event.id]),
      ).toEqual([]);
      expect(
        await as({ playerId: ids.playerA }, "SELECT * FROM event_join_field WHERE event_id = $1", [
          event.id,
        ]),
      ).toEqual([]);
      await expect(
        as(
          teamB(),
          "INSERT INTO event_join_field (event_id, kind, position) VALUES ($1, 'department', 1)",
          [event.id],
        ),
      ).rejects.toThrow(/row-level security/);
      await expect(
        as(teamA(), "UPDATE event_join_field SET kind = 'custom' WHERE event_id = $1", [event.id]),
      ).rejects.toThrow(/permission denied/);
    });
  });

  describe("join answers", () => {
    it("joins with every required answer and keeps them; refuses a missing, blank, long or unknown one", async () => {
      const event = await newEvent();
      const company = await addField(event.id, "company", { required: true, position: 0 });
      const title = await addField(event.id, "job_title", { position: 1 });
      const other = await newEvent();
      const otherField = await addField(other.id, "company");
      const player = await newPlayer();

      for (const [answers, detail] of [
        [{}, `field:${company}`],
        [{ [title]: "Engineer" }, `field:${company}`],
        [{ [company]: "" }, `field:${company}`],
        [{ [company]: " Acme" }, `field:${company}`],
        [{ [company]: "x".repeat(201) }, `field:${company}`],
        [{ [company]: "Ac\u0007me" }, `field:${company}`],
        [{ [company]: 7 }, `field:${company}`],
        [{ [company]: "Acme", [otherField]: "Acme" }, `field:${otherField}`],
        [{ [company]: "Acme", nope: "x" }, "field:nope"],
        [["Acme"], "shape"],
      ] as const) {
        await expect(join(player, event.code, answers)).rejects.toMatchObject({
          code: "JA422",
          detail,
        });
      }
      expect(await enrollmentOf(player, event.id)).toBeUndefined();

      expect(
        await join(player, event.code, { [company]: "Acme", [title]: "x".repeat(200) }),
      ).toMatchObject({
        outcome: "joined",
        status: "active",
      });
      expect(
        await owner<{ field_id: string; value: string }>(
          "SELECT field_id, value FROM join_answer ORDER BY value",
          [],
        ).then((rows) => rows.filter((row) => [company, title].includes(row.field_id))),
      ).toEqual([
        { field_id: company, value: "Acme" },
        { field_id: title, value: "x".repeat(200) },
      ]);
    });

    it("lets the event's team and the player read the answers, nobody else", async () => {
      const event = await newEvent();
      const company = await addField(event.id, "company", { required: true });
      const player = await newPlayer();
      await join(player, event.code, { [company]: "Acme" });
      const read = (context: RequestContext) =>
        as<{ value: string }>(context, "SELECT value FROM join_answer WHERE event_id = $1", [
          event.id,
        ]);
      expect(await read(teamA())).toEqual([{ value: "Acme" }]);
      expect(await read({ playerId: player })).toEqual([{ value: "Acme" }]);
      expect(await read(teamB())).toEqual([]);
      expect(await read({ playerId: ids.playerA })).toEqual([]);
      expect(await read({})).toEqual([]);
      const editorElsewhere = await addMember(db.owner, ids.orgA, "editor", [ids.eventA]);
      expect(await read({ organizerId: ids.orgA, staffUserId: editorElsewhere })).toEqual([]);
      await expect(
        as({ playerId: player }, "UPDATE join_answer SET value = 'Forged'", []),
      ).rejects.toThrow(/permission denied/);
      await expect(
        as(teamA(), "DELETE FROM join_answer WHERE event_id = $1", [event.id]),
      ).rejects.toThrow(/permission denied/);
    });

    it("lets a member who left come back with new answers; deleting a field takes its answers", async () => {
      const event = await newEvent();
      const company = await addField(event.id, "company", { required: true });
      const player = await newPlayer();
      await join(player, event.code, { [company]: "Old Co" });
      await as({ playerId: player }, "UPDATE enrollment SET status = 'left' WHERE event_id = $1", [
        event.id,
      ]);
      expect((await join(player, event.code, { [company]: "New Co" }))?.outcome).toBe("joined");
      expect(await owner("SELECT value FROM join_answer WHERE event_id = $1", [event.id])).toEqual([
        { value: "New Co" },
      ]);
      await as(teamA(), "DELETE FROM event_join_field WHERE id = $1", [company]);
      expect(await owner("SELECT 1 FROM join_answer WHERE event_id = $1", [event.id])).toEqual([]);
    });

    it("answers already to a member without asking for answers added later", async () => {
      const event = await newEvent();
      const player = await newPlayer();
      await join(player, event.code);
      await addField(event.id, "ticket_number", { required: true });
      expect(await join(player, event.code)).toMatchObject({ outcome: "already", welcome: 0 });
    });
  });

  describe("the guest list", () => {
    it("takes Saudi mobiles and lower-case emails once each, from the team only", async () => {
      const event = await newEvent();
      await addGuest(event.id, "phone", "+966512345678");
      await addGuest(event.id, "email", "guest@acme.sa");
      await expect(addGuest(event.id, "phone", "+966512345678")).rejects.toThrow(/duplicate key/);
      for (const [kind, value] of [
        ["phone", "0512345678"],
        ["phone", "+14155550100"],
        ["email", "Guest@acme.sa"],
        ["email", "no-at-sign"],
        ["fax", "123"],
      ] as const) {
        await expect(addGuest(event.id, kind, value), value).rejects.toThrow(/check constraint/);
      }
      await expect(
        as(
          teamB(),
          "INSERT INTO event_guest (event_id, kind, value) VALUES ($1, 'email', 'x@y.sa')",
          [event.id],
        ),
      ).rejects.toThrow(/row-level security/);
      expect(
        await as(teamB(), "SELECT * FROM event_guest WHERE event_id = $1", [event.id]),
      ).toEqual([]);
      expect(
        await as({ playerId: ids.playerA }, "SELECT * FROM event_guest WHERE event_id = $1", [
          event.id,
        ]),
      ).toEqual([]);
      expect(
        await owner<{ created_by: string }>(
          "SELECT created_by FROM event_guest WHERE event_id = $1",
          [event.id],
        ),
      ).toEqual([{ created_by: staffA }, { created_by: staffA }]);
    });

    it("holds at most 10 000 entries an event", async () => {
      const event = await newEvent();
      await owner(
        `INSERT INTO event_guest (event_id, kind, value)
         SELECT $1, 'email', 'g' || n || '@bulk.sa' FROM generate_series(1, 9999) n`,
        [event.id],
      );
      await addGuest(event.id, "email", "last@bulk.sa");
      await expect(addGuest(event.id, "email", "over@bulk.sa")).rejects.toMatchObject({
        code: "QG409",
      });
    });
  });

  describe("locks and invitations at the join", () => {
    it("refuses a guest-list-only event to anyone not on the list, by phone or email", async () => {
      const event = await newEvent({ guestListOnly: true });
      await addGuest(event.id, "phone", "+966511111111");
      await addGuest(event.id, "email", "listed@acme.sa");
      const stranger = await newPlayer();
      expect(await join(stranger, event.code)).toMatchObject({
        outcome: "invite_only",
        enrollment_id: null,
      });
      expect(await enrollmentOf(stranger, event.id)).toBeUndefined();
      const byPhone = await newPlayer({ phone: "+966511111111" });
      const byEmail = await newPlayer({ email: "listed@acme.sa" });
      expect((await join(byPhone, event.code))?.outcome).toBe("joined");
      expect((await join(byEmail, event.code))?.outcome).toBe("joined");
    });

    it("lets a guest skip a private event's approval, and holds anyone else as pending", async () => {
      const event = await newEvent({ access: "private" });
      await addGuest(event.id, "email", "vip@acme.sa");
      const guest = await newPlayer({ email: "vip@acme.sa" });
      expect(await join(guest, event.code)).toMatchObject({ outcome: "joined", status: "active" });
      expect(await join(await newPlayer(), event.code)).toMatchObject({ status: "pending" });
    });

    it("locks an event to verified email domains, letting guests through", async () => {
      const event = await newEvent({ domains: ["acme.sa", "acme.com"] });
      await addGuest(event.id, "phone", "+966522222222");
      expect((await join(await newPlayer({ email: "a@acme.com" }), event.code))?.outcome).toBe(
        "joined",
      );
      for (const contact of [
        { email: "a@mail.acme.sa" },
        { email: "a@other.sa" },
        { phone: "+966533333333" },
      ]) {
        const player = await newPlayer(contact);
        if (!("email" in contact)) {
          await owner("UPDATE player_contact SET email = NULL WHERE player_id = $1", [player]);
        }
        expect((await join(player, event.code))?.outcome, JSON.stringify(contact)).toBe(
          "domain_required",
        );
      }
      const guest = await newPlayer({ phone: "+966522222222" });
      await owner("UPDATE player_contact SET email = NULL WHERE player_id = $1", [guest]);
      expect((await join(guest, event.code))?.outcome).toBe("joined");
    });

    it("checks the event.s state and its join methods before the locks", async () => {
      const event = await newEvent({ guestListOnly: true, methods: ["qr"] });
      const player = await newPlayer();
      expect((await join(player, event.code))?.outcome).toBe("method_off");
      const ended = await newEvent({ guestListOnly: true, startsIn: "-2 days", endsIn: "-1 day" });
      expect((await join(player, ended.code))?.outcome).toBe("ended");
    });

    it("joins an invited person without a code, through no other door", async () => {
      const event = await newEvent({ methods: ["qr"], access: "private" });
      await addGuest(event.id, "email", "invited@acme.sa");
      const invited = await newPlayer({ email: "invited@acme.sa" });
      const stranger = await newPlayer();
      expect(await joinInvited(stranger, event.id)).toMatchObject({
        outcome: "not_found",
        event_id: null,
      });
      expect(await joinInvited(invited, ids.eventB)).toMatchObject({ outcome: "not_found" });
      expect(await joinInvited(invited, event.id)).toMatchObject({
        outcome: "joined",
        status: "active",
      });
      expect((await enrollmentOf(invited, event.id))?.joined_via).toBe("invite");
      expect(await joinInvited(invited, event.id)).toMatchObject({ outcome: "already" });
      const ended = await newEvent({ startsIn: "-2 days", endsIn: "-1 day" });
      await addGuest(ended.id, "email", "invited@acme.sa");
      expect(await joinInvited(invited, ended.id)).toMatchObject({ outcome: "ended" });
    });

    it("holds an invited join to a full hard limit (T-210)", async () => {
      const event = await newEvent({ access: "private" });
      await addGuest(event.id, "email", "late@acme.sa");
      const invited = await newPlayer({ email: "late@acme.sa" });
      await owner("UPDATE event SET player_limit_mode = 'hard', player_limit = 1 WHERE id = $1", [
        event.id,
      ]);
      await owner(
        "INSERT INTO enrollment (organizer_id, event_id, player_id) SELECT organizer_id, id, $2 FROM event WHERE id = $1",
        [event.id, await newPlayer()],
      );
      await expect(joinInvited(invited, event.id)).rejects.toMatchObject({ code: "QL409" });
      expect(await enrollmentOf(invited, event.id)).toBeUndefined();
    });

    it("lists the player's own invitations only, with the fields, until they join", async () => {
      const email = "list.me@acme.sa";
      const event = await newEvent({ access: "private", welcome: 50 });
      const field = await addField(event.id, "full_name", { required: true });
      await addGuest(event.id, "email", email);
      const draft = await newEvent({ status: "draft" });
      await addGuest(draft.id, "email", email);
      const player = await newPlayer({ email });
      const invitations = () =>
        as<{
          id: string;
          fields: { id: string; kind: string; required: boolean }[];
          welcome_points: number;
        }>({ playerId: player }, "SELECT id, fields, welcome_points FROM my_invitations()");
      expect(await invitations()).toEqual([
        {
          id: event.id,
          welcome_points: 50,
          fields: [{ id: field, kind: "full_name", labelAr: null, labelEn: null, required: true }],
        },
      ]);
      expect(await as({ playerId: await newPlayer() }, "SELECT * FROM my_invitations()")).toEqual(
        [],
      );
      expect(await as({}, "SELECT * FROM my_invitations()")).toEqual([]);
      await joinInvited(player, event.id, { [field]: "Sara K" });
      expect(await invitations()).toEqual([]);
      await as({ playerId: player }, "UPDATE enrollment SET status = 'left' WHERE event_id = $1", [
        event.id,
      ]);
      expect(await invitations()).toHaveLength(1);
    });

    it("shows anyone with the code the fields, locks and welcome, never the guest list", async () => {
      const event = await newEvent({ guestListOnly: true, domains: ["acme.sa"], welcome: 25 });
      const field = await addField(event.id, "custom", { label: "Section", required: false });
      await addGuest(event.id, "email", "secret@acme.sa");
      const { rows } = await db.app.query("SELECT * FROM public_event_join_rules($1)", [
        event.code.toLowerCase(),
      ]);
      expect(rows).toEqual([
        {
          guest_list_only: true,
          email_domains: ["acme.sa"],
          welcome_points: 25,
          fields: [
            { id: field, kind: "custom", labelAr: null, labelEn: "Section", required: false },
          ],
        },
      ]);
      const draft = await newEvent({ status: "draft" });
      expect(
        (await db.app.query("SELECT * FROM public_event_join_rules($1)", [draft.code])).rows,
      ).toEqual([]);
    });
  });

  describe("the welcome reward", () => {
    it("adds the amount to score and balance once, as a system entry, and says so", async () => {
      const event = await newEvent({ welcome: 40 });
      const player = await newPlayer();
      expect(await join(player, event.code)).toMatchObject({ outcome: "joined", welcome: 40 });
      expect(await welcomeEntries(player, event.id)).toEqual([
        { score_delta: "40", balance_delta: "40", actor: "system" },
      ]);
      expect(await enrollmentOf(player, event.id)).toMatchObject({ score: "40", balance: "40" });
      expect(
        await owner("SELECT 1 FROM ranking_repair WHERE event_id = $1", [event.id]),
      ).toHaveLength(1);

      await as({ playerId: player }, "UPDATE enrollment SET status = 'left' WHERE event_id = $1", [
        event.id,
      ]);
      expect(await join(player, event.code)).toMatchObject({ outcome: "joined", welcome: 0 });
      expect(await welcomeEntries(player, event.id)).toHaveLength(1);
    });

    it("gives nothing when it is off, and a pending member gets it at approval", async () => {
      const off = await newEvent();
      const player = await newPlayer();
      expect(await join(player, off.code)).toMatchObject({ welcome: 0 });
      expect(await welcomeEntries(player, off.id)).toEqual([]);

      const priv = await newEvent({ access: "private", welcome: 15 });
      const waiting = await newPlayer();
      expect(await join(waiting, priv.code)).toMatchObject({ status: "pending", welcome: 0 });
      expect(await welcomeEntries(waiting, priv.id)).toEqual([]);
      await owner(
        "UPDATE enrollment SET status = 'active' WHERE player_id = $1 AND event_id = $2",
        [waiting, priv.id],
      );
      expect(await welcomeEntries(waiting, priv.id)).toHaveLength(1);
      await owner(
        "UPDATE enrollment SET status = 'banned' WHERE player_id = $1 AND event_id = $2",
        [waiting, priv.id],
      );
      await owner(
        "UPDATE enrollment SET status = 'active' WHERE player_id = $1 AND event_id = $2",
        [waiting, priv.id],
      );
      expect(await welcomeEntries(waiting, priv.id)).toHaveLength(1);
    });

    it("makes one entry when the same first join runs twice at once", async () => {
      const event = await newEvent({ welcome: 10 });
      const player = await newPlayer();
      const second = new Client({ connectionString: db.appUrl });
      await second.connect();
      try {
        const results = await Promise.all([
          join(player, event.code),
          join(player, event.code, {}, second),
        ]);
        expect(results.map((row) => row?.outcome).toSorted()).toEqual(["already", "joined"]);
        expect(results.map((row) => row?.welcome).toSorted()).toEqual([0, 10]);
      } finally {
        await second.end();
      }
      expect(await welcomeEntries(player, event.id)).toHaveLength(1);
    });

    it("fixes the amount once anyone joined or the event is live, for the team's role", async () => {
      const scheduled = await newEvent({
        status: "scheduled",
        startsIn: "1 day",
        endsIn: "2 days",
      });
      await setWelcome(scheduled.id, 30);
      await setWelcome(scheduled.id, 30);
      await join(await newPlayer(), scheduled.code);
      await expect(setWelcome(scheduled.id, 60)).rejects.toMatchObject({ code: "QE409" });
      await expect(setWelcome(scheduled.id, null)).rejects.toMatchObject({ code: "QE409" });

      const live = await newEvent();
      await expect(setWelcome(live.id, 5)).rejects.toMatchObject({ code: "QE409" });
      const empty = await newEvent({ status: "scheduled", startsIn: "1 day", endsIn: "2 days" });
      await expect(setWelcome(empty.id, 0)).rejects.toThrow(/check constraint/);
    });

    it("refuses a welcome entry of any other shape or actor", async () => {
      const [enrolled] = await owner<{ id: string; organizer_id: string; event_id: string }>(
        "SELECT id, organizer_id, event_id FROM enrollment LIMIT 1",
      );
      for (const [score, balance, actor] of [
        [5, 4, "system"],
        [0, 0, "system"],
        [5, 5, "player"],
      ] as const) {
        await expect(
          owner(
            `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor)
             VALUES ($1, $2, $3, 'welcome', $4, $5, $6)`,
            [enrolled?.organizer_id, enrolled?.event_id, enrolled?.id, score, balance, actor],
          ),
        ).rejects.toThrow(/check constraint/);
      }
    });
  });

  describe("event settings", () => {
    it("takes up to ten exact lower-case domains", async () => {
      const event = await newEvent();
      const set = (domains: unknown) =>
        as(teamA(), "UPDATE event SET email_domains = $2 WHERE id = $1", [event.id, domains]);
      await set(["acme.sa", "xn--mgbh0fb.sa"]);
      for (const bad of [
        ["Acme.sa"],
        ["acme"],
        ["@acme.sa"],
        ["acme.sa", null],
        Array.from({ length: 11 }, (_, n) => `d${n}.sa`),
      ]) {
        await expect(set(bad), JSON.stringify(bad)).rejects.toThrow(/event_email_domains_shape/);
      }
    });
  });
});
