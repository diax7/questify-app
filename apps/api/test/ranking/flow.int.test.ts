import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import type { RedisClientType } from "redis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withRequestContext } from "#src/db/context";
import { createRanking, type RankingDeps } from "#src/ranking/ranking";
import { createRankingStore, type RankingStore } from "#src/ranking/store";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";
import { TEST_REDIS_URL, createTestRedis } from "#test/support/test-redis";

type Logged = Readonly<{ level: string; fields: Record<string, unknown> }>;

/**
 * The ranking flow below the routes (T-106): which source answers (Redis, or the PostgreSQL fallback), what each
 * failure logs and marks, and the repair job's backstop. The routes' tests cover the answers themselves.
 */
describe.skipIf(TEST_DATABASE_URL === undefined || TEST_REDIS_URL === undefined)(
  "the ranking flow",
  () => {
    let db: TestDatabase;
    let redis: RedisClientType;
    let store: RankingStore;
    let pool: Pool;
    let organizer: string;
    let statements: string[];
    let failOn: RegExp | undefined;
    let logged: Logged[];
    let counter = 0;

    /** A pool that records every statement and can be told to fail one. */
    const recording = (): Pool =>
      ({
        connect: async () => {
          const client: PoolClient = await pool.connect();
          const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
          (client as unknown as { query: unknown }).query = async (...args: unknown[]) => {
            const sql = String(args[0]);
            statements.push(sql);
            if (failOn?.test(sql) === true) {
              throw Object.assign(new Error("told to fail"), { name: "DatabaseError" });
            }
            return query(...args);
          };
          return client;
        },
      }) as unknown as Pool;

    const deps = (overrides: Partial<RankingDeps> = {}): RankingDeps => ({
      pool: recording(),
      store,
      log: (level, fields) => logged.push({ level, fields: { ...fields } }),
      ...overrides,
    });
    const ran = (fragment: string) => statements.some((sql) => sql.includes(fragment));
    const eventsLogged = () => logged.map((entry) => entry.fields["event"]);

    beforeAll(async () => {
      db = await createTestDatabase();
      redis = await createTestRedis();
      store = createRankingStore(redis);
      pool = new Pool({ connectionString: db.appUrl, max: 4 });
      const [made] = (
        await db.owner.query<{ id: string }>(
          "INSERT INTO organizer (name, slug) VALUES ('Flow Org', 'flow-org') RETURNING id",
        )
      ).rows;
      organizer = made?.id ?? "";
    });
    afterAll(async () => {
      await pool.end();
      await redis.close();
      await db.close();
    });
    beforeEach(() => {
      statements = [];
      failOn = undefined;
      logged = [];
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    const owner = async <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
      (await db.owner.query<T>(sql, values)).rows;

    const newEvent = async (status = "live"): Promise<string> => {
      counter += 1;
      const [event] = await owner<{ id: string }>(
        `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
         VALUES ($1, $2, 'Flow Fest', $3, now() - interval '1 hour', now() + interval '1 day') RETURNING id`,
        [organizer, `FLOW${counter}`, status],
      );
      return event?.id ?? "";
    };

    const newPlayer = async (event: string): Promise<{ id: string; enrollment: string }> => {
      counter += 1;
      const [player] = await owner<{ id: string }>(
        "INSERT INTO player (username) VALUES ($1) RETURNING id",
        [`flower_${counter}`],
      );
      const id = player?.id ?? "";
      await owner("INSERT INTO player_contact (player_id, email) VALUES ($1, $2)", [
        id,
        `flower${counter}@najd.sa`,
      ]);
      await owner(
        "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
        [id, createHash("sha256").update(randomBytes(32)).digest()],
      );
      const [enrollment] = await owner<{ id: string }>(
        "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3) RETURNING id",
        [organizer, event, id],
      );
      return { id, enrollment: enrollment?.id ?? "" };
    };

    /** Completes a 10-point quest as the player straight in the database; returns the completion id. */
    const complete = async (event: string, player: string): Promise<string> => {
      const [general] = await owner<{ id: string }>("SELECT id FROM category WHERE event_id = $1", [
        event,
      ]);
      const [quest] = await owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, type_config)
         VALUES ($1, $2, 'enter_code', 'Flow', 10, 5, '{"code":"FLOW"}') RETURNING id`,
        [event, general?.id],
      );
      const client = await pool.connect();
      try {
        return await withRequestContext(client, { playerId: player }, async () => {
          const { rows } = await client.query<{ completion_id: string }>(
            "SELECT * FROM complete_quest($1, 'code', NULL, 'FLOW', $2, NULL)",
            [quest?.id, randomUUID()],
          );
          return rows[0]?.completion_id ?? "";
        });
      } finally {
        client.release();
      }
    };

    const marked = async (event: string) =>
      (await owner("SELECT 1 FROM ranking_repair WHERE event_id = $1", [event])).length === 1;

    const completionOf = async (enrollment: string) =>
      (
        await owner<{ id: string }>(
          "SELECT id FROM quest_completion WHERE enrollment_id = $1 ORDER BY id DESC LIMIT 1",
          [enrollment],
        )
      )[0]?.id ?? "";

    describe("reading", () => {
      it("answers from Redis when it can, never touching the PostgreSQL fallback", async () => {
        const event = await newEvent();
        const a = await newPlayer(event);
        await complete(event, a.id);
        const ranking = createRanking(deps());
        await ranking.afterCompletion(
          a.id,
          (
            await owner<{ id: string }>(
              "SELECT c.id FROM quest_completion c JOIN enrollment e ON e.id = c.enrollment_id WHERE e.id = $1",
              [a.enrollment],
            )
          )[0]?.id ?? "",
        );
        statements = [];
        const view = await ranking.read(event, a.id);
        expect(view).toMatchObject({ me: { rank: 1, score: 10 }, total: 1 });
        expect(view).toMatchObject({ rows: [{ rank: 1, score: 10, isMe: true }] });
        expect(ran("ranking_rows")).toBe(true);
        expect(ran("ranking_top")).toBe(false);
        expect(ran("ranking_position")).toBe(false);
      });

      it("builds a missing copy and answers from it", async () => {
        const event = await newEvent();
        const a = await newPlayer(event);
        await complete(event, a.id);
        const view = await createRanking(deps()).read(event, a.id);
        expect(view).toMatchObject({ me: { rank: 1 }, total: 1 });
        expect(ran("ranking_entries")).toBe(true);
        expect(ran("ranking_top")).toBe(false);
        expect(await store.builtAt(event)).toBeDefined();
      });

      it("answers from PostgreSQL, logged and marked, when Redis fails", async () => {
        const event = await newEvent();
        const a = await newPlayer(event);
        await complete(event, a.id);
        const broken: RankingStore = {
          ...store,
          read: () => Promise.reject(new Error("redis down")),
        };
        const view = await createRanking(deps({ store: broken })).read(event, a.id);
        expect(view).toMatchObject({ me: { rank: 1 }, total: 1 });
        expect(ran("ranking_top")).toBe(true);
        expect(logged).toContainEqual({
          level: "warn",
          fields: { event: "ranking.read_failed", reason: "Error" },
        });
        expect(await marked(event)).toBe(true);
      });

      it("answers from PostgreSQL without Redis at all", async () => {
        const event = await newEvent();
        const a = await newPlayer(event);
        await complete(event, a.id);
        const idle = await newPlayer(event);
        const ranking = createRanking(deps({ store: undefined }));
        expect(await ranking.read(event, a.id)).toMatchObject({
          rows: [{ rank: 1, score: 10, isMe: true }],
          me: { rank: 1, score: 10 },
          total: 1,
        });
        expect(await ranking.read(event, idle.id)).toMatchObject({ me: null, total: 1 });
        expect(ran("ranking_top")).toBe(true);
      });

      it("takes a no-longer-ranked row out of the copy, marks the event and answers from PostgreSQL", async () => {
        const event = await newEvent();
        const a = await newPlayer(event);
        const banned = await newPlayer(event);
        await complete(event, a.id);
        await complete(event, banned.id);
        const ranking = createRanking(deps());
        await ranking.read(event, a.id);
        await owner("UPDATE enrollment SET status = 'banned' WHERE id = $1", [banned.enrollment]);
        await owner("DELETE FROM ranking_repair WHERE event_id = $1", [event]);
        statements = [];
        expect(await ranking.read(event, a.id)).toMatchObject({ total: 1, me: { rank: 1 } });
        expect(ran("ranking_top")).toBe(true);
        expect(await redis.hGet(`rank:{${event}}:member`, banned.enrollment)).toMatch(/^x/);
        expect(await marked(event)).toBe(true);
      });

      it("answers not_enrolled to someone outside the event", async () => {
        const event = await newEvent();
        const stranger = await newPlayer(await newEvent());
        expect(await createRanking(deps()).read(event, stranger.id)).toBe("not_enrolled");
      });
    });

    describe("after a completion", () => {
      it("leaves a tombstone for a player who is not ranked", async () => {
        const event = await newEvent();
        const a = await newPlayer(event);
        await complete(event, a.id);
        await owner("UPDATE player SET status = 'banned' WHERE id = $1", [a.id]);
        expect(
          await createRanking(deps()).afterCompletion(a.id, await completionOf(a.enrollment)),
        ).toBeNull();
        expect(await redis.hGet(`rank:{${event}}:member`, a.enrollment)).toMatch(/^x/);
      });

      it("answers null for someone else's completion, and without Redis", async () => {
        const event = await newEvent();
        const a = await newPlayer(event);
        const b = await newPlayer(event);
        await complete(event, a.id);
        const completion = await completionOf(a.enrollment);
        expect(await createRanking(deps()).afterCompletion(b.id, completion)).toBeNull();
        statements = [];
        expect(
          await createRanking(deps({ store: undefined })).afterCompletion(a.id, completion),
        ).toBeNull();
        expect(statements).toEqual([]);
      });

      it("logs and marks a Redis write that failed, and still answers", async () => {
        const event = await newEvent();
        const a = await newPlayer(event);
        await complete(event, a.id);
        const broken: RankingStore = {
          ...store,
          upsert: () => Promise.reject(new TypeError("redis down")),
        };
        expect(
          await createRanking(deps({ store: broken })).afterCompletion(
            a.id,
            await completionOf(a.enrollment),
          ),
        ).toBeNull();
        expect(logged).toContainEqual({
          level: "warn",
          fields: { event: "ranking.write_failed", reason: "TypeError" },
        });
        expect(await marked(event)).toBe(true);
      });

      it("logs a mark that could not be written", async () => {
        const event = await newEvent();
        const a = await newPlayer(event);
        await complete(event, a.id);
        failOn = /mark_ranking_repair/;
        const broken: RankingStore = { ...store, upsert: () => Promise.reject("not an error") };
        await createRanking(deps({ store: broken })).afterCompletion(
          a.id,
          await completionOf(a.enrollment),
        );
        expect(eventsLogged()).toEqual(["ranking.write_failed", "ranking.mark_failed"]);
        expect(logged[0]?.fields["reason"]).toBe("unknown");
        expect(logged[1]).toEqual({
          level: "error",
          fields: { event: "ranking.mark_failed", reason: "DatabaseError" },
        });
      });
    });

    describe("the repair job", () => {
      it("does nothing without Redis", async () => {
        const event = await newEvent();
        await owner("INSERT INTO ranking_repair (event_id) VALUES ($1) ON CONFLICT DO NOTHING", [
          event,
        ]);
        await createRanking(deps({ store: undefined })).repairDue();
        expect(statements).toEqual([]);
        expect(await marked(event)).toBe(true);
        await owner("DELETE FROM ranking_repair WHERE event_id = $1", [event]);
      });

      it("logs and marks again a rebuild that failed", async () => {
        const event = await newEvent();
        await owner("INSERT INTO ranking_repair (event_id) VALUES ($1) ON CONFLICT DO NOTHING", [
          event,
        ]);
        const broken: RankingStore = {
          ...store,
          rebuild: () => Promise.reject(new RangeError("x")),
        };
        vi.spyOn(Date, "now").mockReturnValue(1);
        await createRanking(deps({ store: broken })).repairDue();
        expect(logged).toContainEqual({
          level: "warn",
          fields: { event: "ranking.rebuild_failed", reason: "RangeError" },
        });
        expect(await marked(event)).toBe(true);
        await owner("DELETE FROM ranking_repair WHERE event_id = $1", [event]);
      });

      it("runs the backstop at once, then not again for five minutes, and only for live events whose copy aged", async () => {
        await owner("DELETE FROM ranking_repair");
        const fresh = await newEvent();
        const aged = await newEvent();
        const ended = await newEvent("ended");
        const start = 10 * 60 * 1000 * 1000;
        const clock = vi.spyOn(Date, "now").mockReturnValue(start);
        const ranking = createRanking(deps());
        await redis.set(`rank:{${fresh}}:built`, String(start - 60_000));
        await redis.set(`rank:{${aged}}:built`, String(start - 5 * 60 * 1000));
        await redis.del(`rank:{${ended}}:built`);
        await ranking.repairDue();
        expect(await store.builtAt(fresh)).toBe(start - 60_000);
        expect(await store.builtAt(aged)).toBe(start);
        expect(await store.builtAt(ended)).toBeUndefined();

        await redis.set(`rank:{${aged}}:built`, "1");
        clock.mockReturnValue(start + 5 * 60 * 1000 - 1);
        await ranking.repairDue();
        expect(await store.builtAt(aged)).toBe(1);
        clock.mockReturnValue(start + 5 * 60 * 1000);
        await ranking.repairDue();
        expect(await store.builtAt(aged)).toBe(start + 5 * 60 * 1000);
      });
    });
  },
);
