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
};

/**
 * Joining in the database (T-111, migration 0018): players join only through join_event, which checks the code, the
 * event's state, its join methods and its access type; nobody inserts an enrollment directly; anonymous reads return
 * public events and their quests by named columns only.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("joining an event (database)", () => {
  let db: TestDatabase;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    ids = await seedTwoTenants(db.owner);
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

  type EventSpec = {
    access?: "public" | "unlisted" | "private";
    status?: string;
    methods?: string[];
    startsIn?: string;
    endsIn?: string;
  };

  /** An event of organizer A with a fresh code; live by default, joinable every way. */
  const newEvent = async (spec: EventSpec = {}): Promise<{ id: string; code: string }> => {
    counter += 1;
    const code = `JN${String(counter).padStart(4, "0")}`;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, access, join_methods, starts_at, ends_at)
       VALUES ($1, $2, 'Join Fest', $3, $4, $5, now() + $6::interval, now() + $7::interval) RETURNING id`,
      [
        ids.orgA,
        code,
        spec.status ?? "live",
        spec.access ?? "public",
        spec.methods ?? ["code", "qr", "link"],
        spec.startsIn ?? "-1 hour",
        spec.endsIn ?? "1 day",
      ],
    );
    return { id: event?.id ?? "", code };
  };

  const newPlayer = async (): Promise<string> => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`joiner_${counter}`],
    );
    return player?.id ?? "";
  };

  const join = async (player: string, code: string, via = "code", client: Client = db.app) =>
    (
      await as<Joined>(
        { playerId: player },
        "SELECT * FROM join_event($1, $2, '0.1')",
        [code, via],
        client,
      )
    )[0];

  const enrollmentOf = async (player: string, event: string) =>
    (
      await owner<{ status: string; card_version: string | null; joined_via: string | null }>(
        "SELECT status, card_version, joined_via FROM enrollment WHERE player_id = $1 AND event_id = $2",
        [player, event],
      )
    )[0];

  const list = async (afterId: string | null = null, page = 50) =>
    (
      await db.app.query<{ id: string; join_code: string; status_now: string }>(
        "SELECT * FROM public_events($1, $2)",
        [afterId, page],
      )
    ).rows;
  const card = async (code: string) =>
    (
      await db.app.query<{ status_now: string; access: string }>("SELECT * FROM public_event($1)", [
        code,
      ])
    ).rows;
  const quests = async (code: string) =>
    (await db.app.query<Row>("SELECT * FROM public_event_quests($1)", [code])).rows;

  describe("no direct enrollment", () => {
    it("refuses a player enrolling themselves in any event, public or private", async () => {
      const player = await newPlayer();
      for (const [organizer, event] of [
        [ids.orgA, ids.eventA],
        [ids.orgB, ids.eventB],
      ]) {
        await expect(
          as(
            { playerId: player },
            "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)",
            [organizer, event, player],
          ),
        ).rejects.toThrow(/row-level security/);
      }
    });

    it("refuses an organizer enrolling another player in their own event", async () => {
      const staff = await addMember(db.owner, ids.orgA);
      const stranger = await newPlayer();
      await expect(
        as(
          { organizerId: ids.orgA, staffUserId: staff },
          "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3)",
          [ids.orgA, ids.eventA, stranger],
        ),
      ).rejects.toThrow(/row-level security/);
    });
  });

  describe("join_event", () => {
    it("makes an active member of a public or unlisted event, and a pending one of a private event", async () => {
      for (const [access, status] of [
        ["public", "active"],
        ["unlisted", "active"],
        ["private", "pending"],
      ] as const) {
        const event = await newEvent({ access });
        const player = await newPlayer();
        expect(await join(player, event.code.toLowerCase(), "qr")).toMatchObject({
          outcome: "joined",
          event_id: event.id,
          status,
        });
        expect(await enrollmentOf(player, event.id)).toEqual({
          status,
          card_version: "0.1",
          joined_via: "qr",
        });
      }
    });

    it("joins a scheduled event that has not started", async () => {
      const event = await newEvent({ status: "scheduled", startsIn: "1 day", endsIn: "2 days" });
      expect((await join(await newPlayer(), event.code))?.outcome).toBe("joined");
    });

    it("gives one answer for an unknown code and for draft and archived events", async () => {
      const player = await newPlayer();
      const draft = await newEvent({ status: "draft" });
      const archived = await newEvent({ status: "archived" });
      for (const code of ["NOPE99", draft.code, archived.code]) {
        expect(await join(player, code)).toEqual({
          outcome: "not_found",
          enrollment_id: null,
          event_id: null,
          status: null,
          welcome: 0,
        });
      }
      expect(await owner("SELECT 1 FROM enrollment WHERE player_id = $1", [player])).toEqual([]);
    });

    it("refuses an ended event and a way of joining the event turned off", async () => {
      const player = await newPlayer();
      const ended = await newEvent({ startsIn: "-2 days", endsIn: "-1 day" });
      expect((await join(player, ended.code))?.outcome).toBe("ended");
      const qrOnly = await newEvent({ methods: ["qr"] });
      expect((await join(player, qrOnly.code, "code"))?.outcome).toBe("method_off");
      expect((await join(player, qrOnly.code, "public_list"))?.outcome).toBe("method_off");
      expect(await owner("SELECT 1 FROM enrollment WHERE player_id = $1", [player])).toEqual([]);
    });

    it("answers a member's second join with the same enrollment", async () => {
      const event = await newEvent();
      const player = await newPlayer();
      const first = await join(player, event.code);
      expect(await join(player, event.code, "link")).toEqual({
        ...first,
        outcome: "already",
      });
      expect((await enrollmentOf(player, event.id))?.joined_via).toBe("code");
    });

    it("lets a player who left come back with the card accepted last, and never a removed or banned one", async () => {
      const event = await newEvent();
      const player = await newPlayer();
      await join(player, event.code);
      await owner("UPDATE enrollment SET status = 'left' WHERE player_id = $1", [player]);
      expect(await join(player, event.code, "link")).toMatchObject({
        outcome: "joined",
        status: "active",
      });
      expect((await enrollmentOf(player, event.id))?.joined_via).toBe("link");
      for (const status of ["removed", "banned"]) {
        await owner("UPDATE enrollment SET status = $2 WHERE player_id = $1", [player, status]);
        expect(await join(player, event.code)).toMatchObject({
          outcome: "not_allowed",
          enrollment_id: null,
        });
        expect((await enrollmentOf(player, event.id))?.status).toBe(status);
      }
    });

    it("makes one enrollment from two joins at the same moment", async () => {
      const event = await newEvent();
      const player = await newPlayer();
      const second = new Client({ connectionString: db.appUrl });
      await second.connect();
      try {
        const answers = await Promise.all([
          join(player, event.code, "code", db.app),
          join(player, event.code, "code", second),
        ]);
        expect(answers.map((answer) => answer?.outcome).toSorted()).toEqual(["already", "joined"]);
        expect(new Set(answers.map((answer) => answer?.enrollment_id)).size).toBe(1);
      } finally {
        await second.end();
      }
      expect(await owner("SELECT 1 FROM enrollment WHERE player_id = $1", [player])).toHaveLength(
        1,
      );
    });

    it("refuses an empty context, an inactive player, a missing or malformed card and an unknown way", async () => {
      const event = await newEvent();
      await expect(
        db.app.query("SELECT * FROM join_event($1, 'code', '0.1')", [event.code]),
      ).rejects.toThrow(/not an active player/);
      const banned = await newPlayer();
      await owner("UPDATE player SET status = 'banned' WHERE id = $1", [banned]);
      await expect(join(banned, event.code)).rejects.toThrow(/not an active player/);
      const player = await newPlayer();
      await expect(
        as({ playerId: player }, "SELECT * FROM join_event($1, 'code', 'v1')", [event.code]),
      ).rejects.toThrow(/check constraint/);
      await expect(join(player, event.code, "sms")).rejects.toThrow(/unknown way of joining/);
      await expect(
        as({ playerId: player }, "SELECT * FROM join_event($1, 'code', NULL)", [event.code]),
      ).rejects.toThrow(/join card version is required/);
    });

    it("is closed to outsiders", async () => {
      await expect(
        db.outsider.query("SELECT * FROM public.join_event('X', 'code', '0.1')"),
      ).rejects.toThrow(/permission denied/);
    });
  });

  describe("browsing", () => {
    it("lists only public events that list themselves, scheduled or live, soonest first", async () => {
      const listed = await newEvent({
        methods: ["code", "public_list"],
        startsIn: "1 hour",
        status: "scheduled",
      });
      const later = await newEvent({
        methods: ["public_list"],
        startsIn: "2 hours",
        status: "scheduled",
      });
      const live = await newEvent({ methods: ["public_list"] });
      const unlisted = await newEvent({ access: "unlisted" });
      const notListed = await newEvent();
      const ended = await newEvent({
        methods: ["public_list"],
        startsIn: "-2 days",
        endsIn: "-1 day",
      });
      const draft = await newEvent({ methods: ["public_list"], status: "draft" });
      const seen = (await list()).map((row) => row.id);
      expect(seen.filter((id) => [listed.id, later.id, live.id].includes(id))).toEqual([
        live.id,
        listed.id,
        later.id,
      ]);
      for (const hidden of [unlisted, notListed, ended, draft, { id: ids.eventB }]) {
        expect(seen).not.toContain(hidden.id);
      }
    });

    it("pages by a cursor over the start time and id", async () => {
      const all = await list();
      expect(all.length).toBeGreaterThan(2);
      const first = await list(null, 2);
      expect(first).toHaveLength(2);
      const rest = await list(first[1]?.id ?? null);
      expect([...first, ...rest].map((row) => row.id)).toEqual(all.map((row) => row.id));
      expect((await list(null, 0)).length).toBe(1);
    });

    it("shows any access type by its code, an ended event as ended, and nothing for draft or archived", async () => {
      const hidden = await newEvent({ access: "private" });
      expect(await card(hidden.code.toLowerCase())).toMatchObject([
        { access: "private", status_now: "live" },
      ]);
      const ended = await newEvent({ startsIn: "-2 days", endsIn: "-1 day" });
      expect(await card(ended.code)).toMatchObject([{ status_now: "ended" }]);
      for (const status of ["draft", "archived"]) {
        expect(await card((await newEvent({ status })).code)).toEqual([]);
      }
      expect(await card("NOPE99")).toEqual([]);
    });

    it("lists a public or unlisted event's visible quests by named columns, never a private event's", async () => {
      for (const access of ["public", "unlisted", "private"] as const) {
        const event = await newEvent({ access });
        const [general] = await owner<{ id: string }>(
          "SELECT id FROM category WHERE event_id = $1",
          [event.id],
        );
        await owner(
          `INSERT INTO quest (event_id, category_id, type, title_en, points, visible, type_config)
           VALUES ($1, $2, 'enter_code', 'Say the word', 50, true, '{"code": "FALCON42"}'),
                  ($1, $2, 'scan_qr', 'Secret', 10, false, '{}')`,
          [event.id, general?.id],
        );
        const rows = await quests(event.code);
        if (access === "private") {
          expect(rows).toEqual([]);
          continue;
        }
        expect(rows).toMatchObject([{ title_en: "Say the word", points: 50, type: "enter_code" }]);
        expect(JSON.stringify(rows)).not.toContain("FALCON42");
        expect(Object.keys(rows[0] ?? {})).not.toContain("type_config");
      }
    });

    it("is closed to outsiders", async () => {
      for (const sql of [
        "SELECT * FROM public.public_events(NULL, 10)",
        "SELECT * FROM public.public_event('X')",
        "SELECT * FROM public.public_event_quests('X')",
      ]) {
        await expect(db.outsider.query(sql)).rejects.toThrow(/permission denied/);
      }
    });
  });
});
