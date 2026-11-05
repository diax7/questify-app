import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { questifyFixture, type QuestifyFixture } from "#test/support/questify";
import { TEST_DATABASE_URL } from "#test/support/test-db";

type Answer = Record<string, unknown> & { completion_id: string; ranking_failed: boolean };

const ANSWER = "SELECT * FROM complete_quest_answer($1, 'qr', 1, NULL, $2, NULL)";
const ENGINE = "SELECT * FROM complete_quest($1, 'qr', 1, NULL, $2, NULL)";

/**
 * Every part as the API read it before migration 0149, one function at a time (first row of each), for the same
 * completion as the same player: what complete_quest_answer must equal column for column.
 */
const PARTS_ONE_BY_ONE = `
  SELECT l.level_up, l.up_title_ar AS level_title_ar, l.up_title_en AS level_title_en,
         CASE WHEN l.level_up IS NOT NULL THEN own_level_items($1) END AS level_items,
         b.category_id AS bonus_category_id, b.points AS bonus_points, b.name_ar AS bonus_name_ar,
         b.name_en AS bonus_name_en, b.item_ar AS bonus_item_ar, b.item_en AS bonus_item_en,
         b.item_outcome AS bonus_item_outcome, b.item_until AS bonus_item_until,
         b.item_time_zone AS bonus_item_time_zone,
         i.name_ar AS item_name_ar, i.name_en AS item_name_en, i.outcome AS item_outcome, i.until AS item_until,
         i.time_zone AS item_time_zone,
         completion_boost($1) AS boost_multiplier,
         (SELECT to_jsonb(f) FROM own_first_bonus($1) f LIMIT 1) AS first_bonus,
         (SELECT to_jsonb(s) FROM own_streak_bonus($1) s LIMIT 1) AS streak_bonus,
         r.enrollment_id AS rank_enrollment_id, r.score AS rank_score, r.score_version AS rank_score_version,
         r.ranked AS rank_ranked,
         d.day::text AS day_day, d.enrollment_id AS day_enrollment_id, d.score AS day_score,
         d.score_version AS day_score_version, d.ranked AS day_ranked
  FROM (SELECT 1) one
  LEFT JOIN LATERAL (SELECT * FROM own_level($1) LIMIT 1) l ON true
  LEFT JOIN LATERAL (SELECT * FROM own_bonus($1) LIMIT 1) b ON true
  LEFT JOIN LATERAL (SELECT * FROM own_quest_item($1) LIMIT 1) i ON true
  LEFT JOIN LATERAL (SELECT * FROM ranking_entry_of($1) LIMIT 1) r ON true
  LEFT JOIN LATERAL (SELECT * FROM ranking_day_entry_of($1) LIMIT 1) d ON true`;

const ENGINE_COLUMNS = ["completion_id", "points", "occurrence", "score", "balance", "replayed"];

const partsOf = (row: Answer) =>
  Object.fromEntries(
    Object.entries(row).filter(
      ([name]) =>
        ![...ENGINE_COLUMNS, "event_id", "ranking_failed", "ranking_sqlstate"].includes(name),
    ),
  );

const refusal = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
    return "none";
  } catch (error) {
    const pg = error as { code?: string; detail?: string };
    return `${pg.code}:${pg.detail ?? ""}`;
  }
};

/**
 * T-804c (ADR-671, ADR-672, migration 0149): `complete_quest_answer` answers a completion in one statement, each part
 * the existing function's own answer, and a ranking failure inside it never undoes the completion; `player_request_gate`
 * answers the player guard in one call.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)(
  "one statement answers a completion (database)",
  () => {
    let f: QuestifyFixture;
    let event: string;
    let organizer: string;
    let quest: string;
    let other: string;
    let counter = 0;

    const owner = <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
      f.owner<T>(sql, values);
    const one = async (sql: string, values: unknown[] = []) =>
      String(Object.values((await owner(sql, values))[0] ?? {})[0] ?? "");

    /** A player in the event, with yesterday's streak day played and 199 XP (level 2 starts at 200). */
    const member = async (): Promise<{ player: string; enrollment: string }> => {
      const player = await f.newPlayer();
      const enrollment = await f.join(event, player);
      await owner("UPDATE player_xp SET xp = 199 WHERE player_id = $1", [player]);
      await owner(
        `WITH c AS (
         INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                       idempotency_key)
         VALUES ($1, $2, $3, $4, 1, 'qr', gen_random_uuid()::text) RETURNING id
       )
       INSERT INTO event_streak_day (enrollment_id, day, organizer_id, event_id, days, completion_id)
       SELECT $3, event_day(now(), e) - 1, $1, $2, 1, c.id FROM c, event e WHERE e.id = $2`,
        [organizer, event, enrollment, other],
      );
      return { player, enrollment };
    };

    const itemOf = (name: string) =>
      one(
        `INSERT INTO quest_item (organizer_id, event_id, name_ar, name_en, stock_total)
       VALUES ($1, $2, $3, $3, 1) RETURNING id`,
        [organizer, event, name],
      );

    beforeAll(async () => {
      f = await questifyFixture();
      event = await f.newEvent({ phase: "live" });
      organizer = await one("SELECT organizer_id FROM event WHERE id = $1", [event]);
      const category = await one(
        `INSERT INTO category (event_id, name_ar, name_en, completion_bonus, item_id)
       VALUES ($1, 'مكافأة', 'Bonus', 20, $2) RETURNING id`,
        [event, await itemOf("Mug")],
      );
      quest = await one(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, type_config, item_id)
       VALUES ($1, $2, 'scan_qr', 'Tower', 10, 1, '{}', $3) RETURNING id`,
        [event, category, await itemOf("Cap")],
      );
      other = await one(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, type_config, visible)
       SELECT $1, id, 'scan_qr', 'Seed', 1, 100, '{}', false FROM category WHERE event_id = $1 AND name_en = 'General'
       RETURNING id`,
        [event],
      );
      await owner(
        `INSERT INTO quest_first_bonus (quest_id, organizer_id, event_id, points, slots) VALUES ($1, $2, $3, 5, 1)`,
        [quest, organizer, event],
      );
      await owner(
        "INSERT INTO quest_bonus_slot (quest_id, place, organizer_id, event_id) VALUES ($1, 1, $2, $3)",
        [quest, organizer, event],
      );
      await owner(
        `INSERT INTO boost (organizer_id, event_id, category_id, starts_at, ends_at)
       VALUES ($1, $2, $3, now() - interval '1 hour', now() + interval '1 hour')`,
        [organizer, event, category],
      );
      await owner(
        "INSERT INTO event_streak (event_id, organizer_id, enabled, bonus_points) VALUES ($1, $2, true, 4)",
        [event, organizer],
      );
    });
    afterAll(async () => {
      await f.close();
    });

    const answer = async (player: string, target: string, key: string): Promise<Answer> => {
      const [row] = await f.asPlayer<Answer>(player, ANSWER, [target, key]);
      return row as Answer;
    };
    const oneByOne = async (player: string, completion: string) =>
      (await f.asPlayer(player, PARTS_ONE_BY_ONE, [completion]))[0];

    it("answers each part as the part functions do, and every part has a value for the first player", async () => {
      const a = await member();
      const key = randomUUID();
      const row = await answer(a.player, quest, key);
      expect(partsOf(row)).toEqual(await oneByOne(a.player, row.completion_id));
      expect(row).toMatchObject({
        replayed: false,
        event_id: event,
        level_up: 2,
        bonus_item_outcome: "pending",
        item_outcome: "pending",
        boost_multiplier: 2,
        first_bonus: { points: expect.any(Number), place: 1, slots: 1 },
        streak_bonus: { points: 4, days: 2 },
        rank_enrollment_id: a.enrollment,
        rank_ranked: true,
        day_enrollment_id: a.enrollment,
        ranking_failed: false,
        ranking_sqlstate: null,
      });
      expect(row["bonus_category_id"]).not.toBeNull();
      expect(row["level_items"]).not.toEqual([]);

      const engine = (await f.asPlayer(a.player, ENGINE, [quest, key]))[0];
      const replay = await answer(a.player, quest, key);
      expect(replay).toEqual({ ...row, replayed: true });
      expect(Object.fromEntries(ENGINE_COLUMNS.map((name) => [name, replay[name]]))).toEqual(
        engine,
      );
    });

    it("answers a missed first bonus and an item out of stock for the next player", async () => {
      const b = await member();
      const row = await answer(b.player, quest, randomUUID());
      expect(partsOf(row)).toEqual(await oneByOne(b.player, row.completion_id));
      expect(row).toMatchObject({
        first_bonus: { points: 5, place: null, slots: 1 },
        item_outcome: "out_of_stock",
        bonus_item_outcome: "out_of_stock",
      });
    });

    it("passes every refusal of complete_quest through with its code and detail", async () => {
      const c = await member();
      const key = randomUUID();
      await answer(c.player, quest, key);
      const cases: [string, string][] = [
        [randomUUID(), randomUUID()],
        [quest, randomUUID()],
        [other, key],
      ];
      for (const [target, request] of cases) {
        const engine = await refusal(f.asPlayer(c.player, ENGINE, [target, request]));
        expect(engine).not.toBe("none");
        expect(await refusal(f.asPlayer(c.player, ANSWER, [target, request]))).toBe(engine);
      }
    });

    it("commits the completion and its points when the ranking entries fail, and names the SQLSTATE", async () => {
      const d = await member();
      const [kept] = await owner<{ definition: string }>(
        "SELECT pg_get_functiondef('ranking_day_entry_for(bigint, boolean)'::regprocedure) AS definition",
      );
      await owner("BEGIN");
      let row: Answer | undefined;
      try {
        await owner(
          `CREATE OR REPLACE FUNCTION ranking_day_entry_for(completion bigint, eligible boolean)
           RETURNS TABLE(event_id uuid, day date, enrollment_id uuid, score bigint, score_version bigint,
                         ranked boolean)
           LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
         AS $$ BEGIN RAISE EXCEPTION 'ranking broken for the test'; END $$`,
        );
        await owner("SELECT set_config('app.player_id', $1, true)", [d.player]);
        [row] = await owner<Answer>(ANSWER, [quest, randomUUID()]);
        await owner(kept?.definition ?? "");
        await owner("COMMIT");
      } catch (error) {
        await owner("ROLLBACK");
        throw error;
      }
      expect(row).toMatchObject({
        ranking_failed: true,
        ranking_sqlstate: "P0001",
        rank_enrollment_id: null,
        rank_score: null,
        rank_score_version: null,
        rank_ranked: null,
        day_day: null,
        day_enrollment_id: null,
        event_id: event,
        replayed: false,
      });
      const saved = await owner<{ points: string; score: string }>(
        `SELECT l.score_delta::text AS points, n.score::text AS score
       FROM quest_completion c JOIN ledger_entry l ON l.completion_id = c.id AND l.kind = 'quest'
       JOIN enrollment n ON n.id = c.enrollment_id WHERE c.id = $1`,
        [row?.completion_id],
      );
      expect(saved).toEqual([{ points: String(row?.["points"]), score: expect.any(String) }]);
      expect(Number(saved[0]?.score)).toBeGreaterThanOrEqual(Number(row?.["points"]));
    });

    it("is a volatile definer with a fixed path, run only by the API role", async () => {
      const rows = await owner<Record<string, unknown>>(
        `SELECT p.proname AS name, p.provolatile AS volatility, p.prosecdef AS definer, p.proconfig AS config,
              l.lanname AS language, has_function_privilege('questify_app', p.oid, 'EXECUTE') AS app,
              EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public
       FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
       WHERE p.pronamespace = 'public'::regnamespace
         AND p.proname IN ('complete_quest_answer', 'player_request_gate') ORDER BY 1`,
      );
      const shape = {
        definer: true,
        config: ["search_path=public, pg_temp"],
        language: "plpgsql",
        app: true,
      };
      expect(rows).toEqual([
        { name: "complete_quest_answer", volatility: "v", public: false, ...shape },
        { name: "player_request_gate", volatility: "s", public: false, ...shape },
      ]);
    });

    /** A player with a session for `token`; the session's times and the player's state set by `change`. */
    const withSession = async (token: string, change?: string) => {
      counter += 1;
      const player = await f.newPlayer();
      await owner(
        `INSERT INTO player_acceptance (player_id, document, version, method)
       VALUES ($1, 'terms_of_use', '0.1', 'signup')`,
        [player],
      );
      await owner(
        "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
        [player, createHash("sha256").update(token).digest()],
      );
      if (change !== undefined) {
        await owner(change, [player]);
      }
      return player;
    };
    const gate = async (token: string, write: boolean) =>
      (
        await f.run(
          {},
          "SELECT player_id, held FROM player_request_gate(sha256(convert_to($1, 'UTF8')), $2)",
          [token, write],
        )
      )[0];
    /** The two calls the gate replaces, for the same token. */
    const separately = async (token: string) =>
      (
        await f.run(
          {},
          `SELECT o.owner AS player_id, CASE WHEN o.owner IS NULL THEN NULL ELSE player_legal_held(o.owner) END AS held
         FROM (SELECT player_session_owner(sha256(convert_to($1, 'UTF8'))) AS owner) o`,
          [token],
        )
      )[0];

    describe("the player gate (player_request_gate)", () => {
      it("answers the live session's player, held only on a write while a newer version waits", async () => {
        const live = `gate-live-${counter}`;
        const player = await withSession(live);
        expect(await gate(live, true)).toEqual({ player_id: player, held: false });
        await owner("INSERT INTO legal_version (document, version) VALUES ('terms_of_use', '0.2')");
        expect(await gate(live, true)).toEqual({ player_id: player, held: true });
        expect(await gate(live, false)).toEqual({ player_id: player, held: false });
        expect(await separately(live)).toEqual({ player_id: player, held: true });
      });

      it("answers no player for a banned player, a reset session, an expired or an unknown token", async () => {
        const cases = [
          ["gate-banned", "UPDATE player SET status = 'banned' WHERE id = $1"],
          ["gate-reset", "UPDATE player SET tokens_valid_after = now() WHERE id = $1"],
          [
            "gate-expired",
            `UPDATE player_session SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
           WHERE player_id = $1`,
          ],
        ] as const;
        for (const [token, change] of cases) {
          await withSession(token, change);
          for (const write of [true, false]) {
            expect(await gate(token, write), token).toEqual({ player_id: null, held: false });
          }
          expect((await separately(token))?.["player_id"], token).toBeNull();
        }
        expect(await gate("gate-unknown", true)).toEqual({ player_id: null, held: false });
      });
    });
  },
);
