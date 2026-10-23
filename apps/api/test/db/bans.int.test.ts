import { randomUUID } from "node:crypto";
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

/**
 * Bans, the exclusion list and the organizer's view of players in the database (T-208, migration 0019): organizers
 * read players only through event_players; status changes from the organizer seat only through set_enrollment_ban;
 * the exclusion list takes players off the boards in both forms of the ranking rule.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("bans and exclusions (database)", () => {
  let db: TestDatabase;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let ownerA: string;
  let editorA: string;
  let ownerB: string;
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    ids = await seedTwoTenants(db.owner);
    ownerA = await addMember(db.owner, ids.orgA, "owner");
    editorA = await addMember(db.owner, ids.orgA, "editor");
    ownerB = await addMember(db.owner, ids.orgB, "owner");
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
  const seatA = () => ({ organizerId: ids.orgA, staffUserId: ownerA });
  const editorSeat = () => ({ organizerId: ids.orgA, staffUserId: editorA });
  const seatB = () => ({ organizerId: ids.orgB, staffUserId: ownerB });

  const newEvent = async (): Promise<string> => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Ban Fest', 'live', now() - interval '1 hour', now() + interval '1 day') RETURNING id`,
      [ids.orgA, `BAN${counter}`],
    );
    return event?.id ?? "";
  };

  /** A player in the event with points from a real completion, and their contact. */
  const newPlayer = async (
    event: string,
    contact: { phone?: string; email?: string } = {},
    name?: string,
  ): Promise<{ player: string; enrollment: string }> => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username, birth_year) VALUES ($1, 1990) RETURNING id",
      [name ?? `banned_${counter}`],
    );
    await owner("INSERT INTO player_contact (player_id, phone_e164, email) VALUES ($1, $2, $3)", [
      player?.id,
      contact.phone ?? null,
      contact.email ?? `p${counter}@najd.sa`,
    ]);
    const [enrollment] = await owner<{ id: string }>(
      "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3) RETURNING id",
      [ids.orgA, event, player?.id],
    );
    return { player: player?.id ?? "", enrollment: enrollment?.id ?? "" };
  };

  const newQuest = async (event: string): Promise<string> => {
    const [general] = await owner<{ id: string }>("SELECT id FROM category WHERE event_id = $1", [
      event,
    ]);
    const [quest] = await owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, type_config)
       VALUES ($1, $2, 'enter_code', 'Ban', 10, 50, '{"code":"BAN"}') RETURNING id`,
      [event, general?.id],
    );
    return quest?.id ?? "";
  };

  const complete = (player: string, quest: string) =>
    as({ playerId: player }, "SELECT * FROM complete_quest($1, 'code', NULL, 'BAN', $2, NULL)", [
      quest,
      randomUUID(),
    ]);

  /** Whether each form of the ranking rule ranks this enrollment; they must always agree. */
  const ranked = async (event: string, enrollment: string): Promise<boolean> => {
    const [set] = await owner<{ ranked: boolean }>(
      "SELECT ranked FROM ranked_enrollments($1) WHERE id = $2",
      [event, enrollment],
    );
    const [row] = await owner<{ ranked: boolean }>(
      "SELECT ranking_eligible(e) AS ranked FROM enrollment e WHERE e.id = $1",
      [enrollment],
    );
    expect(set?.ranked, "the set form agrees with the row form").toBe(row?.ranked);
    return row?.ranked === true;
  };

  const ban = (
    event: string,
    enrollment: string,
    banned: boolean | null,
    seat: RequestContext = seatA(),
  ) =>
    as<{ set_enrollment_ban: string }>(seat, "SELECT set_enrollment_ban($1, $2, $3, $4)", [
      event,
      enrollment,
      banned,
      randomUUID(),
    ]).then((rows) => rows[0]?.set_enrollment_ban);

  const statusOf = async (enrollment: string) =>
    (
      await owner<{ status: string }>("SELECT status FROM enrollment WHERE id = $1", [enrollment])
    )[0]?.status;

  const add = (event: string, kind: string, value: string, seat: RequestContext = seatA()) =>
    as<{ outcome: string; id: string | null }>(
      seat,
      "SELECT * FROM add_exclusion($1, $2, $3, $4)",
      [event, kind, value, randomUUID()],
    ).then((rows) => rows[0]);
  const remove = (event: string, id: string, seat: RequestContext = seatA()) =>
    as<{ remove_exclusion: string }>(seat, "SELECT remove_exclusion($1, $2, $3)", [
      event,
      id,
      randomUUID(),
    ]).then((rows) => rows[0]?.remove_exclusion);

  describe("what organizers see of players", () => {
    it("reads no player row directly, from any seat", async () => {
      for (const seat of [seatA(), editorSeat(), seatB()]) {
        expect(await as(seat, "SELECT * FROM player")).toEqual([]);
      }
    });

    it("lists an event's players with the disclosed columns only, in join order, page by page", async () => {
      const event = await newEvent();
      const made = [await newPlayer(event), await newPlayer(event), await newPlayer(event)];
      const list = (after: string | null = null, page = 100) =>
        as<Row>(seatA(), "SELECT * FROM event_players($1, $2, $3, NULL)", [event, after, page]);
      const all = await list();
      expect(all.map((row) => row["enrollment_id"])).toEqual(made.map((m) => m.enrollment));
      expect(Object.keys(all[0] ?? {}).toSorted()).toEqual(
        [
          "avatar",
          "enrollment_id",
          "joined_at",
          "open_flag",
          "redeem_paused",
          "rehearsal",
          "score",
          "status",
          "username",
        ].toSorted(),
      );
      expect(JSON.stringify(all)).not.toContain("1990");
      const first = await list(null, 2);
      const rest = await list(String(first[1]?.["enrollment_id"]));
      expect([...first, ...rest].map((row) => row["enrollment_id"])).toEqual(
        made.map((m) => m.enrollment),
      );
      expect(await list(randomUUID())).toHaveLength(3);
      expect(await list(null, 0)).toHaveLength(1);
    });

    it("finds players by a username prefix, any case and Arabic look-alike, with wildcards taken literally", async () => {
      const event = await newEvent();
      const sara = await newPlayer(event, {}, "Sara_Q");
      await newPlayer(event, {}, "saraXq");
      const arabic = await newPlayer(event, {}, "أحمد");
      const search = async (prefix: string) =>
        (
          await as<Row>(seatA(), "SELECT * FROM event_players($1, NULL, 100, $2)", [event, prefix])
        ).map((row) => row["enrollment_id"]);
      expect(await search("sara_")).toEqual([sara.enrollment]);
      expect(await search("%")).toEqual([]);
      expect(await search("_")).toEqual([]);
      expect(await search("احم")).toEqual([arabic.enrollment]);
      expect(await search("SARA")).toHaveLength(2);
    });

    it("shows nothing to another organizer, an editor outside their events, a player or an outsider", async () => {
      const event = await newEvent();
      const { player } = await newPlayer(event);
      const limited = await addMember(db.owner, ids.orgA, "editor", [ids.eventA]);
      for (const seat of [
        seatB(),
        { organizerId: ids.orgA, staffUserId: limited },
        { playerId: player },
        {},
      ]) {
        expect(await as(seat, "SELECT * FROM event_players($1, NULL, 100, NULL)", [event])).toEqual(
          [],
        );
      }
      await expect(
        db.outsider.query("SELECT * FROM public.event_players($1, NULL, 1, NULL)", [event]),
      ).rejects.toThrow(/permission denied/);
    });
  });

  describe("banning", () => {
    it("takes a player off the board, stops their scans and their rejoining, keeps their record, and lifts", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const a = await newPlayer(event);
      await complete(a.player, quest);
      const ledger = await owner("SELECT id FROM ledger_entry WHERE enrollment_id = $1", [
        a.enrollment,
      ]);
      expect(await ranked(event, a.enrollment)).toBe(true);

      expect(await ban(event, a.enrollment, true)).toBe("changed");
      expect(await statusOf(a.enrollment)).toBe("banned");
      expect(await ranked(event, a.enrollment)).toBe(false);
      await expect(complete(a.player, quest)).rejects.toThrow(/enrollment not active/);
      const [code] = await owner<{ join_code: string }>(
        "SELECT join_code FROM event WHERE id = $1",
        [event],
      );
      expect(
        (
          await as<{ outcome: string }>(
            { playerId: a.player },
            "SELECT outcome FROM join_event($1, 'code', '0.1')",
            [code?.join_code],
          )
        )[0]?.outcome,
      ).toBe("not_allowed");
      expect(
        await owner("SELECT id FROM ledger_entry WHERE enrollment_id = $1", [a.enrollment]),
      ).toEqual(ledger);
      expect(await owner("SELECT 1 FROM ranking_repair WHERE event_id = $1", [event])).toHaveLength(
        1,
      );

      expect(await ban(event, a.enrollment, true)).toBe("unchanged");
      expect(await ban(event, a.enrollment, false)).toBe("changed");
      expect(await statusOf(a.enrollment)).toBe("active");
      expect(await ban(event, a.enrollment, false)).toBe("unchanged");
      await complete(a.player, quest);
    });

    it("never bans or lifts a player who left (no seat without the limit, no return without consent), nor a removed one", async () => {
      const event = await newEvent();
      const a = await newPlayer(event);
      await as({ playerId: a.player }, "UPDATE enrollment SET status = 'left' WHERE id = $1", [
        a.enrollment,
      ]);
      expect(await ban(event, a.enrollment, true)).toBe("not_allowed");
      expect(await ban(event, a.enrollment, false)).toBe("not_allowed");
      expect(await statusOf(a.enrollment)).toBe("left");
      const [code] = await owner<{ join_code: string }>(
        "SELECT join_code FROM event WHERE id = $1",
        [event],
      );
      expect(
        (
          await as<{ outcome: string }>(
            { playerId: a.player },
            "SELECT outcome FROM join_event($1, 'code', '0.1')",
            [code?.join_code],
          )
        )[0]?.outcome,
      ).toBe("joined");
      expect(await ban(event, a.enrollment, true)).toBe("changed");
      const removed = await newPlayer(event);
      await owner("UPDATE enrollment SET status = 'removed' WHERE id = $1", [removed.enrollment]);
      expect(await ban(event, removed.enrollment, true)).toBe("not_allowed");
      expect(await ban(event, removed.enrollment, false)).toBe("not_allowed");
    });

    it("writes one audit entry per change, with statuses only", async () => {
      const event = await newEvent();
      const a = await newPlayer(event);
      await ban(event, a.enrollment, true);
      await ban(event, a.enrollment, true);
      await ban(event, a.enrollment, false);
      expect(
        await owner(
          `SELECT actor_id, organizer_id, event_id, action, target_id, before, after FROM audit_log
           WHERE target_id = $1 ORDER BY id`,
          [a.enrollment],
        ),
      ).toEqual([
        {
          actor_id: ownerA,
          organizer_id: ids.orgA,
          event_id: event,
          action: "event.player_ban",
          target_id: a.enrollment,
          before: { status: "active" },
          after: { status: "banned" },
        },
        {
          actor_id: ownerA,
          organizer_id: ids.orgA,
          event_id: event,
          action: "event.player_unban",
          target_id: a.enrollment,
          before: { status: "banned" },
          after: { status: "active" },
        },
      ]);
    });

    it("is the owner's alone, for an enrollment of the named event", async () => {
      const event = await newEvent();
      const other = await newEvent();
      const a = await newPlayer(event);
      expect(await ban(event, a.enrollment, true, editorSeat())).toBe("not_owner");
      expect(await ban(event, a.enrollment, true, seatB())).toBe("not_found");
      expect(await ban(other, a.enrollment, true)).toBe("not_found");
      expect(await ban(event, randomUUID(), true)).toBe("not_found");
      expect(await ban(event, a.enrollment, true, { playerId: a.player })).toBe("not_found");
      expect(await statusOf(a.enrollment)).toBe("active");
      await expect(ban(event, a.enrollment, null)).rejects.toThrow(/true or false/);
      await expect(
        db.outsider.query("SELECT public.set_enrollment_ban($1, $2, true, NULL)", [
          event,
          a.enrollment,
        ]),
      ).rejects.toThrow(/permission denied/);
    });

    it("cannot be done with a bare statement from any organizer seat", async () => {
      const event = await newEvent();
      const a = await newPlayer(event);
      for (const seat of [seatA(), editorSeat()]) {
        expect(
          await as(seat, "UPDATE enrollment SET status = 'banned' WHERE id = $1 RETURNING id", [
            a.enrollment,
          ]),
        ).toEqual([]);
      }
      expect(await statusOf(a.enrollment)).toBe("active");
    });
  });

  describe("the exclusion list", () => {
    it("takes a player off the board by phone or by email domain, and back on when removed", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const byPhone = await newPlayer(event, { phone: "+966551230001" });
      const byDomain = await newPlayer(event, { email: "staff@sponsor.sa" });
      const subdomain = await newPlayer(event, { email: "x@mail.sponsor.sa" });
      for (const p of [byPhone, byDomain, subdomain]) {
        await complete(p.player, quest);
      }
      await owner("DELETE FROM ranking_repair");
      const phone = await add(event, "phone", "+966551230001");
      const domain = await add(event, "email_domain", "sponsor.sa");
      expect((await add(event, "email_domain", "nic.xn--mgberp4a5d4ar"))?.outcome).toBe("added");
      expect([phone?.outcome, domain?.outcome]).toEqual(["added", "added"]);
      expect(await owner("SELECT 1 FROM ranking_repair WHERE event_id = $1", [event])).toHaveLength(
        1,
      );
      expect(await ranked(event, byPhone.enrollment)).toBe(false);
      expect(await ranked(event, byDomain.enrollment)).toBe(false);
      expect(await ranked(event, subdomain.enrollment)).toBe(true);
      await complete(byPhone.player, quest);

      await owner("DELETE FROM ranking_repair");
      expect(await remove(event, phone?.id ?? "")).toBe("removed");
      expect(await owner("SELECT 1 FROM ranking_repair WHERE event_id = $1", [event])).toHaveLength(
        1,
      );
      expect(await ranked(event, byPhone.enrollment)).toBe(true);
      expect(await remove(event, phone?.id ?? "")).toBe("not_found");
    });

    it("marks the board when an excluded player's phone changes", async () => {
      const event = await newEvent();
      const quest = await newQuest(event);
      const a = await newPlayer(event, { phone: "+966551230002" });
      await complete(a.player, quest);
      await add(event, "phone", "+966551230009");
      await owner("DELETE FROM ranking_repair");
      await owner("UPDATE player_contact SET phone_e164 = '+966551230009' WHERE player_id = $1", [
        a.player,
      ]);
      expect(await owner("SELECT 1 FROM ranking_repair WHERE event_id = $1", [event])).toHaveLength(
        1,
      );
      expect(await ranked(event, a.enrollment)).toBe(false);
    });

    it("answers a duplicate with the entry already there, and audits the kind without the value", async () => {
      const event = await newEvent();
      const first = await add(event, "phone", "+966551230003");
      expect(await add(event, "phone", "+966551230003")).toEqual({
        outcome: "existing",
        id: first?.id,
      });
      await remove(event, first?.id ?? "");
      const audit = await owner<{ action: string; after: unknown; before: unknown }>(
        "SELECT action, after, before FROM audit_log WHERE target_id = $1 ORDER BY id",
        [first?.id],
      );
      expect(audit).toEqual([
        { action: "event.exclusion_add", after: { kind: "phone" }, before: null },
        { action: "event.exclusion_remove", after: null, before: { kind: "phone" } },
      ]);
      expect(
        JSON.stringify(await owner("SELECT * FROM audit_log WHERE event_id = $1", [event])),
      ).not.toContain("551230003");
    });

    it("refuses malformed values in the table itself", async () => {
      const event = await newEvent();
      for (const [kind, value] of [
        ["phone", "0551230004"],
        ["phone", "+966151230004"],
        ["email_domain", "Sponsor.sa"],
        ["email_domain", "a@sponsor.sa"],
        ["email_domain", "sponsor"],
        ["email_domain", "-x.sa"],
        ["fax", "1"],
      ]) {
        await expect(add(event, kind ?? "", value ?? ""), `${kind} ${value}`).rejects.toThrow(
          /check constraint/,
        );
      }
    });

    it("is the owner's to change and the team's to read, in their own organizer only", async () => {
      const event = await newEvent();
      const entry = await add(event, "email_domain", "team.sa");
      expect(await add(event, "email_domain", "other.sa", editorSeat())).toEqual({
        outcome: "not_owner",
        id: null,
      });
      expect(await add(event, "email_domain", "other.sa", seatB())).toEqual({
        outcome: "not_found",
        id: null,
      });
      expect(await remove(event, entry?.id ?? "", editorSeat())).toBe("not_owner");
      expect(await remove(event, entry?.id ?? "", seatB())).toBe("not_found");
      expect(
        await as(editorSeat(), "SELECT id FROM event_exclusion WHERE event_id = $1", [event]),
      ).toEqual([{ id: entry?.id }]);
      expect(await as(seatB(), "SELECT id FROM event_exclusion")).toEqual([]);
      const { player } = await newPlayer(event);
      expect(await as({ playerId: player }, "SELECT id FROM event_exclusion")).toEqual([]);
      await expect(
        as(
          seatA(),
          "INSERT INTO event_exclusion (organizer_id, event_id, kind, value, created_by) VALUES ($1, $2, 'email_domain', 'x.sa', $3)",
          [ids.orgA, event, ownerA],
        ),
      ).rejects.toThrow(/permission denied/);
      for (const sql of [
        "SELECT * FROM public.event_exclusion",
        "SELECT * FROM public.add_exclusion(gen_random_uuid(), 'phone', '+966551230000', NULL)",
        "SELECT public.remove_exclusion(gen_random_uuid(), gen_random_uuid(), NULL)",
      ]) {
        await expect(db.outsider.query(sql)).rejects.toThrow(/permission denied/);
      }
    });

    it("holds at most 500 entries an event, even when two adds race at 499", async () => {
      const event = await newEvent();
      await owner(
        `INSERT INTO event_exclusion (organizer_id, event_id, kind, value, created_by)
         SELECT $1, $2, 'email_domain', 'd' || n || '.sa', $3 FROM generate_series(1, 499) n`,
        [ids.orgA, event, ownerA],
      );
      const second = new Client({ connectionString: db.appUrl });
      await second.connect();
      try {
        const answers = await Promise.all([
          as<{ outcome: string }>(
            seatA(),
            "SELECT outcome FROM add_exclusion($1, 'email_domain', 'r1.sa', NULL)",
            [event],
          ),
          as<{ outcome: string }>(
            seatA(),
            "SELECT outcome FROM add_exclusion($1, 'email_domain', 'r2.sa', NULL)",
            [event],
            second,
          ),
        ]);
        expect(answers.map((rows) => rows[0]?.outcome).toSorted()).toEqual(["added", "full"]);
      } finally {
        await second.end();
      }
      expect(
        await owner("SELECT 1 FROM event_exclusion WHERE event_id = $1", [event]),
      ).toHaveLength(500);
    });

    it("goes with its event when the event is deleted", async () => {
      const [draft] = await owner<{ id: string }>(
        "INSERT INTO event (organizer_id, join_code, name_en) VALUES ($1, 'DELX1', 'Gone') RETURNING id",
        [ids.orgA],
      );
      await add(draft?.id ?? "", "email_domain", "gone.sa");
      await owner("DELETE FROM event WHERE id = $1", [draft?.id]);
      expect(await owner("SELECT 1 FROM event_exclusion WHERE event_id = $1", [draft?.id])).toEqual(
        [],
      );
    });
  });
});
