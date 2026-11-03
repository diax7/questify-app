import { randomBytes, randomUUID } from "node:crypto";
import { FEATURES } from "@questify/shared";
import { Pool, type Client, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withRequestContext, type RequestContext } from "#src/db/context";
import { eventFeatureOn } from "#src/settings/feature-guard";
import { createSettingsService } from "#src/settings/service";
import {
  TEST_DATABASE_URL,
  addMember,
  connectAsOwner,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

type Row = Record<string, unknown>;
type Member = { player: string; enrollment: string };

/** A call's SQLSTATE ("QF403"), or "none". */
const refusal = (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "none",
    (error: { code?: string }) => `${error.code}`,
  );

const as = (player: string): RequestContext => ({ playerId: player });
/** The 0050 numbers of memory_match easy, passed: what a client sends back for a won round. */
const PASS = { pairs: 6, moves: 9, ms: 30_000, lucky: 0 };

/**
 * Feature layers, part 2, in the database (T-711b, migration 0141, ADR-540 to ADR-546): Questify's per-organizer override
 * reaches boosts, community quests, meet-someone and mini-games where the platform switch acts (new things only), the
 * boost-start push waits for the layer, a switch-off racing a payment is decided by commit order without a wait, and
 * the recorded Ask Questify request.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)(
  "feature layers for the points path (database)",
  () => {
    let db: TestDatabase;
    let pool: Pool;
    let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
    let ownerA = "";
    let ownerB = "";
    let editorA = "";
    let adminId = "";
    let counter = 0;

    beforeAll(async () => {
      db = await createTestDatabase();
      pool = new Pool({ connectionString: db.appUrl, max: 8, options: "-c lock_timeout=5000" });
      ids = await seedTwoTenants(db.owner);
      ownerA = await addMember(db.owner, ids.orgA, "owner");
      ownerB = await addMember(db.owner, ids.orgB, "owner");
      editorA = await addMember(db.owner, ids.orgA, "editor");
      const [admin] = (
        await db.owner.query<{ id: string }>(
          "INSERT INTO staff_user (email, password_hash, platform_role) VALUES ('points-layers@questify.test', 'h', 'admin') RETURNING id",
        )
      ).rows;
      adminId = admin?.id ?? "";
    });
    afterAll(async () => {
      await pool.end();
      await db.close();
    });

    const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
      (await db.owner.query<T>(sql, values)).rows;
    /** One statement in a seat; `lockTimeout` bounds every wait of the call (the "never waits" tests use 200 ms). */
    const query = async <T extends Row>(
      context: RequestContext,
      sql: string,
      values: unknown[] = [],
      lockTimeout = "5s",
    ) => {
      const client: PoolClient = await pool.connect();
      try {
        return await withRequestContext(client, context, async () => {
          await client.query("SELECT set_config('lock_timeout', $1, true)", [lockTimeout]);
          return (await client.query<T>(sql, values)).rows;
        });
      } finally {
        client.release();
      }
    };
    const teamA = (staff = ownerA): RequestContext => ({
      organizerId: ids.orgA,
      staffUserId: staff,
    });
    const teamB = (): RequestContext => ({ organizerId: ids.orgB, staffUserId: ownerB });
    const admin = (): RequestContext => ({ isAdmin: true, staffUserId: adminId });

    const setOverride = (organizer: string, feature: string, enabled: boolean | null) =>
      enabled === null
        ? owner("DELETE FROM organizer_feature_override WHERE organizer_id = $1 AND feature = $2", [
            organizer,
            feature,
          ])
        : owner(
            `INSERT INTO organizer_feature_override (organizer_id, feature, enabled) VALUES ($1, $2, $3)
           ON CONFLICT (organizer_id, feature) DO UPDATE SET enabled = EXCLUDED.enabled`,
            [organizer, feature, enabled],
          );
    const setPlatform = (feature: string, on: boolean | null) =>
      on === null
        ? owner("DELETE FROM platform_setting WHERE key = 'features'")
        : owner(
            `INSERT INTO platform_setting (key, value) VALUES ('features', jsonb_build_object($1::text,
             jsonb_build_object('enabled', $2::boolean)))
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
            [feature, on],
          );
    const setSwitch = (event: string, feature: string, on: boolean) =>
      owner(
        `UPDATE event SET config = jsonb_set(config, '{features}', coalesce(config -> 'features', '{}')
         || jsonb_build_object($2::text, $3::boolean)) WHERE id = $1`,
        [event, feature, on],
      );
    const reset = async () => {
      await owner("DELETE FROM organizer_feature_override");
      await owner("DELETE FROM platform_setting WHERE key = 'features'");
    };

    /**
     * An admin's override write held open (as `lockOverride` and `upsertOverride` take it), committed by `commit`: the race
     * tests' second session.
     */
    const holdOverride = async (organizer: string, feature: string, enabled: boolean) => {
      const held: Client = await connectAsOwner(db);
      await held.query("BEGIN");
      await held.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `organizer_feature_override:${organizer}:${feature}`,
      ]);
      await held.query(
        `INSERT INTO organizer_feature_override (organizer_id, feature, enabled) VALUES ($1, $2, $3)
       ON CONFLICT (organizer_id, feature) DO UPDATE SET enabled = EXCLUDED.enabled`,
        [organizer, feature, enabled],
      );
      return {
        commit: async () => {
          await held.query("COMMIT");
          await held.end();
        },
      };
    };

    const newEvent = async (organizer = ids.orgA, access = "public"): Promise<string> => {
      counter += 1;
      const [event] = await owner<{ id: string }>(
        `INSERT INTO event (organizer_id, join_code, name_en, name_ar, status, access, starts_at, ends_at)
       VALUES ($1, $2, 'Layer Fest', 'مهرجان', 'live', $3, now() - interval '2 hours', now() + interval '1 day')
       RETURNING id`,
        [organizer, `PLY${counter}`, access],
      );
      return event?.id ?? "";
    };
    const newCategory = async (event: string) =>
      (
        await owner<{ id: string }>(
          "INSERT INTO category (event_id, name_en) VALUES ($1, 'Stage') RETURNING id",
          [event],
        )
      )[0]?.id ?? "";
    const newQuest = async (event: string, type: string, category?: string) => {
      const config =
        type === "meet"
          ? { dailyCap: 5 }
          : type === "game"
            ? { game: "memory_match", level: "easy", attempts: 3, cooldownMinutes: null }
            : {};
      const [quest] = await owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, type_config)
       VALUES ($1, $2, $3, 'Quest', 10, $5, $4) RETURNING id`,
        [
          event,
          category ?? (await newCategory(event)),
          type,
          JSON.stringify(config),
          type === "game" ? 1 : 10,
        ],
      );
      return quest?.id ?? "";
    };
    const member = async (event: string): Promise<Member> => {
      counter += 1;
      const [player] = await owner<{ id: string }>(
        "INSERT INTO player (username) VALUES ($1) RETURNING id",
        [`layer_player_${counter}`],
      );
      const [made] = await owner<{ id: string }>(
        `INSERT INTO enrollment (organizer_id, event_id, player_id, joined_via)
       SELECT organizer_id, id, $2, 'code' FROM event WHERE id = $1 RETURNING id`,
        [event, player?.id],
      );
      return { player: player?.id ?? "", enrollment: made?.id ?? "" };
    };
    const ledgerOf = async (who: Member) =>
      (
        await owner<{ n: number; points: number }>(
          "SELECT count(*)::int AS n, coalesce(sum(score_delta), 0)::int AS points FROM ledger_entry WHERE enrollment_id = $1",
          [who.enrollment],
        )
      )[0];

    const startRound = (who: Member, quest: string, lockTimeout?: string) =>
      query<{ round_id: string }>(
        as(who.player),
        "SELECT * FROM start_game_round($1, $2, NULL, 1)",
        [quest, randomUUID()],
        lockTimeout,
      );
    const finishRound = (who: Member, round: string) =>
      query<{ verdict: string; points: string | null }>(
        as(who.player),
        "SELECT * FROM finish_game_round($1, $2, 'passed', $3, NULL, false, 0)",
        [round, randomUUID(), JSON.stringify(PASS)],
      );
    const issuePass = async (who: Member, quest: string) => {
      const hash = randomBytes(32);
      await query(as(who.player), "SELECT * FROM issue_meet_pass($1, $2, NULL)", [quest, hash]);
      return hash;
    };
    const meet = (who: Member, hash: Buffer, lockTimeout?: string, key = randomUUID()) =>
      query<{ points: string }>(
        as(who.player),
        "SELECT * FROM meet_player($1, $2, NULL, NULL)",
        [hash, key],
        lockTimeout,
      );

    const ask = (context: RequestContext, event: string, feature = "bigScreen") =>
      query<{ id: string; status: string; created: boolean }>(
        context,
        "SELECT * FROM request_feature($1, $2, $3)",
        [event, feature, randomUUID()],
      );
    const decide = (context: RequestContext, id: string, status: string) =>
      query(
        context,
        "UPDATE feature_request SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1 RETURNING 1",
        [id, status, adminId],
      );

    const boostIn = async (event: string, category: string, from: number, to: number) =>
      (
        await owner<{ id: string }>(
          `INSERT INTO boost (organizer_id, event_id, category_id, starts_at, ends_at)
         SELECT organizer_id, id, $2, now() + make_interval(mins => $3), now() + make_interval(mins => $4)
         FROM event WHERE id = $1 RETURNING id`,
          [event, category, from, to],
        )
      )[0]?.id ?? "";
    const complete = (who: Member, quest: string, lockTimeout?: string) =>
      query<{ points: string }>(
        as(who.player),
        "SELECT * FROM complete_quest($1, 'qr', 1, NULL, $2, NULL)",
        [quest, randomUUID()],
        lockTimeout,
      );
    const notices = async (boost: string) =>
      (
        await owner<{ n: number }>("SELECT count(*)::int AS n FROM notice WHERE dedupe = $1", [
          `boost:${boost}`,
        ])
      )[0]?.n;

    const SYSTEM: RequestContext = {};
    /** A points goal (target 10, its step pays 5) whose window began `ago` before now, saved as its builder would. */
    const goalIn = async (event: string, ago: string, organizer = ids.orgA) => {
      const team = organizer === ids.orgA ? teamA() : teamB();
      const made = {
        title: { en: "Light the tower" },
        measure: "points",
        target: 10,
        startsAt: new Date().toISOString(),
        endsAt: new Date(Date.now() + 3_600_000).toISOString(),
        paidTo: "contributors",
        reward: { kind: "points", points: 5 },
        milestones: [],
      };
      const [saved] = await query<{ id: string }>(
        team,
        "SELECT save_community_goal($1, NULL, $2, $3) AS id",
        [event, JSON.stringify(made), randomUUID()],
      );
      await owner(
        `UPDATE community_goal SET starts_at = date_trunc('milliseconds', now() - $2::interval),
                                 ends_at = date_trunc('milliseconds', now() + interval '1 hour') WHERE id = $1`,
        [saved?.id, ago],
      );
      return saved?.id ?? "";
    };
    const settle = async (goal: string, lockTimeout?: string) =>
      (await query<{ s: string }>(SYSTEM, "SELECT settle_goal($1) AS s", [goal], lockTimeout))[0]
        ?.s;
    /** A completion worth `points` and its entry five minutes ago, written as the engine writes them. */
    const earn = (who: Member, points: number) =>
      owner(
        `WITH c AS (
         INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                       idempotency_key, created_at)
         SELECT n.organizer_id, n.event_id, n.id, q.id, 1, 'qr', gen_random_uuid()::text, now() - interval '5 minutes'
         FROM enrollment n JOIN quest q ON q.event_id = n.event_id WHERE n.id = $1 LIMIT 1 RETURNING *)
       INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                                 completion_id, quest_id, actor, created_at)
       SELECT c.organizer_id, c.event_id, c.enrollment_id, 'quest', $2, $2, c.id, c.quest_id, 'player', c.created_at
       FROM c`,
        [who.enrollment, points],
      );

    describe("the rules", () => {
      it("games_on and meet_on agree with the composed configuration in every layer state", async () => {
        await reset();
        const settings = createSettingsService({ pool, ttlMs: 0 });
        const event = await newEvent();
        const who = await member(event);
        const rules = { miniGames: "games_on", meetSomeone: "meet_on" } as const;
        for (const [key, rule] of Object.entries(rules)) {
          for (const platformOn of [true, false]) {
            for (const override of [null, true, false]) {
              for (const eventOn of [true, false]) {
                await setPlatform(key, platformOn);
                await setOverride(ids.orgA, key, override);
                await setSwitch(event, key, eventOn);
                const [row] = await owner<{ on: boolean }>(`SELECT ${rule}($1) AS on`, [event]);
                const api = await eventFeatureOn(settings, event, who.player, key);
                const state = { key, platformOn, override, eventOn };
                expect({ ...state, db: row?.on }).toEqual({ ...state, db: api });
                expect(api, JSON.stringify(state)).toBe((override ?? platformOn) && eventOn);
              }
            }
          }
          await setSwitch(event, key, true);
        }
        expect(
          (await owner<{ on: boolean }>("SELECT games_on(gen_random_uuid()) AS on"))[0],
        ).toEqual({
          on: true,
        });
        await reset();
      });

      it("boosts_on and community_on read the event's switch only, whatever the layers say (ADR-540)", async () => {
        await reset();
        const event = await newEvent();
        for (const [key, rule] of [
          ["boosts", "boosts_on"],
          ["community", "community_on"],
        ] as const) {
          for (const layer of [
            () => setPlatform(key, false),
            () => setOverride(ids.orgA, key, false),
          ]) {
            await layer();
            await setSwitch(event, key, true);
            const on = await owner<{ on: boolean }>(
              `SELECT ${rule}(e) AS on FROM event e WHERE e.id = $1`,
              [event],
            );
            expect(on[0]?.on).toBe(true);
            await setSwitch(event, key, false);
            const off = await owner<{ on: boolean }>(
              `SELECT ${rule}(e) AS on FROM event e WHERE e.id = $1`,
              [event],
            );
            expect(off[0]?.on).toBe(false);
            await reset();
            await setSwitch(event, key, true);
          }
        }
      });

      it("lists the old settle functions as gone and the new ones in place", async () => {
        const found = await owner<{ sig: string }>(
          `SELECT p.oid::regprocedure::text AS sig FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname IN ('settle_goal', 'settle_community') ORDER BY 1`,
        );
        expect(found.map((row) => row.sig)).toEqual([
          "settle_community(uuid,uuid)",
          "settle_goal(uuid)",
        ]);
      });
    });

    describe("the round and meet doors", () => {
      it("refuse under an override Off with the platform On, open under an override On with the platform Off", async () => {
        await reset();
        const mine = await newEvent();
        const theirs = await newEvent(ids.orgB);
        const [gameA, meetA] = [await newQuest(mine, "game"), await newQuest(mine, "meet")];
        const [gameB, meetB] = [await newQuest(theirs, "game"), await newQuest(theirs, "meet")];
        const [a1, a2, b1, b2] = [
          await member(mine),
          await member(mine),
          await member(theirs),
          await member(theirs),
        ];
        const shown = await issuePass(a2, meetA);
        const shownB = await issuePass(b2, meetB);

        await setOverride(ids.orgA, "miniGames", false);
        await setOverride(ids.orgA, "meetSomeone", false);
        expect(await refusal(startRound(a1, gameA))).toBe("QF403");
        expect(await refusal(issuePass(a1, meetA))).toBe("QF403");
        expect(await refusal(meet(a1, shown))).toBe("QF403");
        expect(
          await owner("SELECT 1 FROM game_round WHERE enrollment_id = $1", [a1.enrollment]),
        ).toEqual([]);
        expect(await ledgerOf(a1)).toEqual({ n: 0, points: 0 });
        expect(await ledgerOf(a2)).toEqual({ n: 0, points: 0 });
        // Another organizer's event is untouched.
        expect(await refusal(startRound(b1, gameB))).toBe("none");
        expect(await refusal(meet(b1, shownB))).toBe("none");

        await reset();
        await setPlatform("miniGames", false);
        expect(await refusal(startRound(b1, gameB))).toBe("QF403");
        await setOverride(ids.orgA, "miniGames", true);
        expect(await refusal(startRound(a1, gameA))).toBe("none");
        await owner("UPDATE platform_setting SET value = $1 WHERE key = 'features'", [
          JSON.stringify({ meetSomeone: { enabled: false } }),
        ]);
        expect(await refusal(issuePass(b1, meetB))).toBe("QF403");
        await setOverride(ids.orgA, "meetSomeone", true);
        expect(await refusal(meet(a1, shown))).toBe("none");
        await reset();
      });

      it("lets a round started before the override Off finish and pay once", async () => {
        await reset();
        const event = await newEvent();
        const quest = await newQuest(event, "game");
        const who = await member(event);
        const [round] = await startRound(who, quest);
        await setOverride(ids.orgA, "miniGames", false);
        const [finished] = await finishRound(who, String(round?.round_id));
        expect(finished?.verdict).toBe("passed");
        expect(await ledgerOf(who)).toEqual({ n: 1, points: 10 });
        expect(await refusal(startRound(who, quest))).toBe("QF403");
        await reset();
      });

      it("refuses a pass shown before the override Off, paying neither side", async () => {
        // As before this task, meet_player checks the switch before its replay lookup: a replayed scan is refused too.
        await reset();
        const event = await newEvent();
        const quest = await newQuest(event, "meet");
        const [scanner, shower] = [await member(event), await member(event)];
        const shown = await issuePass(shower, quest);
        await setOverride(ids.orgA, "meetSomeone", false);
        expect(await refusal(meet(scanner, shown))).toBe("QF403");
        for (const who of [scanner, shower]) {
          expect(await ledgerOf(who)).toEqual({ n: 0, points: 0 });
          expect(
            await owner("SELECT 1 FROM quest_completion WHERE enrollment_id = $1", [
              who.enrollment,
            ]),
          ).toEqual([]);
        }
        await reset();
      });
    });

    describe("a switch-off racing a payment (ADR-546)", () => {
      it("decides a meet scan by commit order, and the scan never waits on the admin's write", async () => {
        await reset();
        const event = await newEvent();
        const quest = await newQuest(event, "meet");
        const [a, b, c, d] = [
          await member(event),
          await member(event),
          await member(event),
          await member(event),
        ];
        const [shownB, shownD] = [await issuePass(b, quest), await issuePass(d, quest)];
        // Order B: the admin's Off is written and held; the scan reads the committed On and pays at once.
        const held = await holdOverride(ids.orgA, "meetSomeone", false);
        try {
          expect(await refusal(meet(a, shownB, "200ms"))).toBe("none");
        } finally {
          await held.commit();
        }
        expect((await ledgerOf(a))?.n).toBe(1);
        // Then, as in order A (the Off committed first), the door refuses and writes nothing.
        expect(await refusal(meet(c, shownD, "200ms"))).toBe("QF403");
        expect(await ledgerOf(c)).toEqual({ n: 0, points: 0 });
        expect((await ledgerOf(a))?.n).toBe(1);
        await reset();
      });

      it("decides a round start by commit order, and the start never waits on the admin's write", async () => {
        await reset();
        const event = await newEvent();
        const quest = await newQuest(event, "game");
        const [a, c] = [await member(event), await member(event)];
        const held = await holdOverride(ids.orgA, "miniGames", false);
        let round: string | undefined;
        try {
          round = (await startRound(a, quest, "200ms"))[0]?.round_id;
        } finally {
          await held.commit();
        }
        expect(round).toBeDefined();
        expect((await finishRound(a, String(round)))[0]?.verdict).toBe("passed");
        expect(await ledgerOf(a)).toEqual({ n: 1, points: 10 });
        expect(await refusal(startRound(c, quest, "200ms"))).toBe("QF403");
        await reset();
      });
    });

    describe("boosts under a layer Off", () => {
      it("keeps a running boost paying double whether the Off committed before or is held during the payment", async () => {
        await reset();
        const event = await newEvent();
        const category = await newCategory(event);
        const quest = await newQuest(event, "scan_qr", category);
        await boostIn(event, category, -5, 30);
        const [a, b] = [await member(event), await member(event)];
        const held = await holdOverride(ids.orgA, "boosts", false);
        try {
          expect((await complete(a, quest, "200ms"))[0]?.points).toBe("20");
        } finally {
          await held.commit();
        }
        expect((await complete(b, quest, "200ms"))[0]?.points).toBe("20");
        // The owner's event switch still stops it at once (ADR-233).
        await setSwitch(event, "boosts", false);
        expect((await complete(await member(event), quest))[0]?.points).toBe("10");
        await reset();
      });

      it("pays a boost saved earlier once its window opens, without its start notice until the layer is back On", async () => {
        await reset();
        const event = await newEvent();
        const category = await newCategory(event);
        const quest = await newQuest(event, "scan_qr", category);
        const who = await member(event);
        const boost = await boostIn(event, category, 60, 90);
        await setOverride(ids.orgA, "boosts", false);
        // Its window opens: the start trigger and the due scan write nothing while the layer is Off.
        await owner("UPDATE boost SET starts_at = now() - interval '1 minute' WHERE id = $1", [
          boost,
        ]);
        await owner("SELECT push_due_boost(100)");
        expect(await notices(boost)).toBe(0);
        expect((await complete(who, quest))[0]?.points).toBe("20");
        // The owner can still stop one running boost (end_boost has no switch check; Q-500).
        expect(
          await refusal(
            query(teamA(), "SELECT * FROM end_boost($1, $2, $3)", [event, boost, randomUUID()]),
          ),
        ).toBe("none");
        await reset();
        const second = await boostIn(event, category, -1, 30);
        await owner("DELETE FROM notice WHERE dedupe = $1", [`boost:${second}`]);
        await setPlatform("boosts", false);
        await owner("SELECT push_due_boost(100)");
        expect(await notices(second)).toBe(0);
        await setOverride(ids.orgA, "boosts", true);
        await owner("SELECT push_due_boost(100)");
        expect(await notices(second)).toBe(1);
        await reset();
      });

      it("does not send a boost notice written before the layer went Off", async () => {
        await reset();
        const event = await newEvent();
        const category = await newCategory(event);
        const who = await member(event);
        const boost = await boostIn(event, category, -1, 30);
        expect(await notices(boost)).toBe(1);
        const audience = async () =>
          (
            await owner<{ ok: boolean }>(
              `SELECT notice_audience_ok(n, m) AS ok FROM notice n, enrollment m
             WHERE n.dedupe = $1 AND m.id = $2`,
              [`boost:${boost}`, who.enrollment],
            )
          )[0]?.ok;
        expect(await audience()).toBe(true);
        await setOverride(ids.orgA, "boosts", false);
        expect(await audience()).toBe(false);
        await setOverride(ids.orgA, "boosts", null);
        await setPlatform("boosts", false);
        expect(await audience()).toBe(false);
        await reset();
      });
    });

    describe("community goals under a layer Off", () => {
      it("does not start a scheduled goal under an override Off, for that organizer only", async () => {
        await reset();
        const mine = await goalIn(await newEvent(), "1 minute");
        const theirs = await goalIn(await newEvent(ids.orgB), "1 minute", ids.orgB);
        await setOverride(ids.orgA, "community", false);
        expect(await settle(mine)).toBe("scheduled");
        expect(await settle(theirs)).toBe("running");
        await reset();
        await setPlatform("community", false);
        await setOverride(ids.orgA, "community", true);
        expect(await settle(mine)).toBe("running");
        await reset();
      });

      it("keeps a running goal settling under an override Off; its reached step pays", async () => {
        await reset();
        const event = await newEvent();
        await newQuest(event, "scan_qr");
        // Started 30 minutes ago: the first settle reads its first 10 minutes, so the points earned 5 minutes ago are read
        // by a later settle, under the layer Off.
        const goal = await goalIn(event, "30 minutes");
        expect(await settle(goal)).toBe("running");
        const who = await member(event);
        await earn(who, 15);
        await setOverride(ids.orgA, "community", false);
        let status = await settle(goal);
        for (let tick = 0; tick < 10 && status !== "reached"; tick += 1) {
          status = await settle(goal);
        }
        expect(status).toBe("reached");
        await query(SYSTEM, "SELECT * FROM pay_community_batch(500, $1)", [event]);
        expect((await ledgerOf(who))?.points).toBe(20);
        await reset();
      });

      it("decides a goal's start by commit order against the admin's write, never waiting", async () => {
        await reset();
        const event = await newEvent();
        const first = await goalIn(event, "1 minute");
        const held = await holdOverride(ids.orgA, "community", false);
        try {
          expect(await settle(first, "200ms")).toBe("running");
        } finally {
          await held.commit();
        }
        const second = await goalIn(await newEvent(), "1 minute");
        expect(await settle(second, "200ms")).toBe("scheduled");
        await reset();
      });
    });

    describe("the Ask Questify request (FR-1827, ADR-545)", () => {
      it("names exactly the registry's add-ons, in the door's rule and in the table's CHECK", async () => {
        const gated = Object.entries(FEATURES)
          .filter(([, definition]) => definition.gated)
          .map(([key]) => key)
          .toSorted();
        for (const key of Object.keys(FEATURES)) {
          const [row] = await owner<{ ok: boolean }>("SELECT feature_request_addon($1) AS ok", [
            key,
          ]);
          expect({ key, ok: row?.ok }).toEqual({ key, ok: gated.includes(key) });
        }
        const [check] = await owner<{ def: string }>(
          `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
         WHERE conrelid = 'feature_request'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%feature %'`,
        );
        const listed = [...(check?.def.matchAll(/'([a-zA-Z]+)'::text/g) ?? [])].map((m) => m[1]);
        expect(listed.toSorted()).toEqual(gated);
      });

      it("is recorded by the event's owner only, once while open, and refused as the door says", async () => {
        const event = await newEvent();
        const theirs = await newEvent(ids.orgB);
        expect(await refusal(ask(teamA(editorA), event))).toBe("RQ403");
        expect(await refusal(ask(teamB(), event))).toBe("RQ404");
        expect(await refusal(ask({}, event))).toBe("RQ404");
        expect(await refusal(ask({ playerId: ids.playerA }, event))).toBe("RQ404");
        expect(await refusal(ask(teamA(), theirs))).toBe("RQ404");
        expect(await refusal(ask(teamA(), event, "shop"))).toBe("RQ422");
        expect(await refusal(ask(teamA(), randomUUID()))).toBe("RQ404");

        const [first] = await ask(teamA(), event);
        expect(first).toMatchObject({ status: "open", created: true });
        const [again] = await ask(teamA(), event);
        expect(again).toMatchObject({ id: first?.id, created: false });
        expect(
          await owner("SELECT count(*)::int AS n FROM feature_request WHERE event_id = $1", [
            event,
          ]),
        ).toEqual([{ n: 1 }]);
        const audit = await owner<{ after: Row; target_id: string }>(
          "SELECT after, target_id FROM audit_log WHERE action = 'feature_request.create' AND event_id = $1",
          [event],
        );
        expect(audit).toEqual([{ after: { feature: "bigScreen" }, target_id: first?.id }]);

        await owner(
          "INSERT INTO event_entitlement (event_id, organizer_id, feature) VALUES ($1, $2, 'bigScreen')",
          [theirs, ids.orgB],
        );
        expect(await refusal(ask(teamB(), theirs))).toBe("RQ409");
      });

      it("is closed by an admin only, and asked again only 24 hours after a decline", async () => {
        const event = await newEvent();
        const [made] = await ask(teamA(), event);
        const id = String(made?.id);
        for (const context of [
          teamA(),
          teamB(),
          {},
          { playerId: ids.playerA },
          { isAdmin: true },
        ]) {
          expect(await decide(context, id, "declined")).toEqual([]);
        }
        expect(await refusal(query(teamA(), "DELETE FROM feature_request"))).toBe("42501");
        expect(await decide(admin(), id, "declined")).toHaveLength(1);
        expect(await decide(admin(), id, "allowed")).toEqual([]);
        expect(await refusal(ask(teamA(), event))).toBe("RQ429");
        await owner(
          "UPDATE feature_request SET decided_at = now() - interval '25 hours' WHERE id = $1",
          [id],
        );
        const [second] = await ask(teamA(), event);
        expect(second).toMatchObject({ created: true });
        expect(second?.id).not.toBe(id);
      });

      it("is read by the organizer's own members and admins, never by another organizer or a player", async () => {
        const event = await newEvent(ids.orgA, "public");
        await ask(teamA(), event);
        const seen = (context: RequestContext) =>
          query<{ event_id: string }>(
            context,
            "SELECT event_id FROM feature_request WHERE event_id = $1",
            [event],
          );
        expect(await seen(teamA())).toHaveLength(1);
        expect(await seen(teamA(editorA))).toHaveLength(1);
        expect(await seen(admin())).toHaveLength(1);
        expect(await seen(teamB())).toEqual([]);
        expect(await seen({ playerId: ids.playerA })).toEqual([]);
        expect(await seen({})).toEqual([]);
      });
    });
  },
);
