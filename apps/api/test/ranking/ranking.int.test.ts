import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { LightMyRequestResponse } from "fastify";
import { Pool } from "pg";
import { createClient, type RedisClientType } from "redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRanking, type Ranking } from "#src/ranking/ranking";
import { createRankingStore, type RankingStore } from "#src/ranking/store";
import {
  createStaff,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import {
  TEST_DATABASE_URL,
  addMember,
  createTestDatabase,
  type TestDatabase,
} from "#test/support/test-db";
import { TEST_REDIS_URL, createTestRedis } from "#test/support/test-redis";

type View = {
  rows: { rank: number; username: string; score: number; isMe: boolean }[];
  me: { rank: number; username: string; score: number } | null;
  total: number;
};

const names = (seen: View) => seen.rows.map((row) => row.username);

/**
 * Rankings over HTTP (T-106): the completion answer's rank, the ranking route, exclusions, the owner's switch, and the
 * answers when Redis is down or its copy is gone.
 */
describe.skipIf(TEST_DATABASE_URL === undefined || TEST_REDIS_URL === undefined)(
  "rankings over HTTP",
  () => {
    let db: TestDatabase;
    let redis: RedisClientType;
    let dead: RedisClientType;
    let store: RankingStore;
    let test: TestApp;
    let down: TestApp;
    let repairs: Ranking;
    let pool: Pool;
    let organizer: string;
    let counter = 0;

    beforeAll(async () => {
      db = await createTestDatabase();
      redis = await createTestRedis();
      store = createRankingStore(redis);
      // Never connected and no offline queue: every command fails at once, as when Redis is down.
      dead = createClient({ url: "redis://127.0.0.1:1", disableOfflineQueue: true });
      test = await startApp(db, false, {}, { rankingStore: store });
      down = await startApp(db, false, {}, { rankingStore: createRankingStore(dead) });
      pool = new Pool({ connectionString: db.appUrl, max: 2 });
      repairs = createRanking({ pool, store, log: () => undefined });
      const [made] = (
        await db.owner.query<{ id: string }>(
          "INSERT INTO organizer (name, slug) VALUES ('Rank Org', 'rank-org') RETURNING id",
        )
      ).rows;
      organizer = made?.id ?? "";
    });
    afterAll(async () => {
      await test.close();
      await down.close();
      await pool.end();
      await redis.close();
      await db.close();
    });

    const owner = async <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
      (await db.owner.query<T>(sql, values)).rows;

    const newEvent = async (): Promise<string> => {
      counter += 1;
      const [event] = await owner<{ id: string }>(
        `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
         VALUES ($1, $2, 'Rank Fest', 'live', now() - interval '1 hour', now() + interval '1 day') RETURNING id`,
        [organizer, `HTTP${counter}`],
      );
      return event?.id ?? "";
    };

    /** A player enrolled in the event, with a live bearer session. */
    const newPlayer = async (
      event: string,
      email?: string,
    ): Promise<{ id: string; token: string; enrollment: string }> => {
      counter += 1;
      const [player] = await owner<{ id: string }>(
        "INSERT INTO player (username) VALUES ($1) RETURNING id",
        [`climber_${counter}`],
      );
      const id = player?.id ?? "";
      await owner("INSERT INTO player_contact (player_id, email) VALUES ($1, $2)", [
        id,
        email ?? `climber${counter}@najd.sa`,
      ]);
      const token = randomBytes(32).toString("base64url");
      await owner(
        "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
        [id, createHash("sha256").update(token).digest()],
      );
      const [enrollment] = await owner<{ id: string }>(
        "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3) RETURNING id",
        [organizer, event, id],
      );
      return { id, token, enrollment: enrollment?.id ?? "" };
    };

    const newQuest = async (event: string, points: number): Promise<string> => {
      const [general] = await owner<{ id: string }>("SELECT id FROM category WHERE event_id = $1", [
        event,
      ]);
      const [quest] = await owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, type_config)
         VALUES ($1, $2, 'enter_code', 'Climb', $3, 20, '{"code":"CLIMB"}') RETURNING id`,
        [event, general?.id, points],
      );
      return quest?.id ?? "";
    };

    const complete = (token: string, quest: string, app: TestApp = test) =>
      app.app.inject({
        method: "POST",
        url: `/v1/quests/${quest}/complete`,
        headers: { authorization: `Bearer ${token}`, "idempotency-key": randomUUID() },
        payload: { proof: { type: "code", code: "CLIMB" } },
      });

    const ranking = (
      token: string | undefined,
      event: string,
      app: TestApp = test,
    ): Promise<LightMyRequestResponse> =>
      app.app.inject({
        method: "GET",
        url: `/v1/events/${event}/ranking`,
        headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
      });
    const view = async (token: string, event: string, app: TestApp = test) => {
      const response = await ranking(token, event, app);
      expect(response.statusCode).toBe(200);
      return response.json<View>();
    };
    const usernamesOf = async (players: readonly { id: string }[]) => {
      const found: string[] = [];
      for (const player of players) {
        found.push(await usernameOf(player.id));
      }
      return found;
    };
    const usernameOf = async (player: string) =>
      (await owner<{ username: string }>("SELECT username FROM player WHERE id = $1", [player]))[0]
        ?.username ?? "";

    describe("after a completion", () => {
      it("answers the player's new place", async () => {
        const event = await newEvent();
        const [ten, twenty] = [await newQuest(event, 10), await newQuest(event, 20)];
        const a = await newPlayer(event);
        const b = await newPlayer(event);
        expect((await complete(a.token, ten)).json()).toMatchObject({ score: 10, rank: 1 });
        expect((await complete(b.token, twenty)).json()).toMatchObject({ score: 20, rank: 1 });
        expect((await complete(a.token, ten)).json()).toMatchObject({ score: 20, rank: 2 });
      });

      it("answers a null place when Redis cannot be written, and marks the event for repair", async () => {
        const event = await newEvent();
        const a = await newPlayer(event);
        const answer = await complete(a.token, await newQuest(event, 5), down);
        expect(answer.statusCode).toBe(200);
        expect(answer.json()).toMatchObject({ score: 5, rank: null });
        expect(
          await owner("SELECT 1 FROM ranking_repair WHERE event_id = $1", [event]),
        ).toHaveLength(1);
        await repairs.repairDue();
        expect((await view(a.token, event)).me).toMatchObject({ rank: 1, score: 5 });
      });
    });

    describe("the ranking route", () => {
      it("shows the top 10 and the caller's own place, ties going to who reached the points first", async () => {
        const event = await newEvent();
        const quest = await newQuest(event, 10);
        const players = [];
        for (let n = 0; n < 12; n += 1) {
          players.push(await newPlayer(event));
        }
        for (const [index, player] of players.entries()) {
          await complete(player.token, quest);
          if (index < 3) {
            await complete(player.token, quest);
          }
        }
        const last = players[11];
        const seen = await view(last?.token ?? "", event);
        expect(seen.total).toBe(12);
        expect(seen.rows).toHaveLength(10);
        expect(seen.rows.map((row) => row.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        expect(names(seen).slice(0, 4)).toEqual(await usernamesOf(players.slice(0, 4)));
        expect(seen.me).toEqual({
          rank: 12,
          username: await usernameOf(last?.id ?? ""),
          avatar: "falcon",
          score: 10,
        });
        expect(seen.rows.some((row) => row.isMe)).toBe(false);
        // Only the username and avatar of another player are ever shown (FR-120).
        for (const row of seen.rows) {
          expect(Object.keys(row).toSorted()).toEqual([
            "avatar",
            "isMe",
            "rank",
            "score",
            "username",
          ]);
        }
        const first = await view(players[0]?.token ?? "", event);
        expect(first.rows[0]).toMatchObject({ rank: 1, isMe: true, score: 20 });
      });

      it("gives no place to a player with no points", async () => {
        const event = await newEvent();
        const a = await newPlayer(event);
        await complete(a.token, await newQuest(event, 3));
        const idle = await newPlayer(event);
        expect(await view(idle.token, event)).toMatchObject({ me: null, total: 1 });
      });

      it("drops a banned player at once, and keeps them out", async () => {
        const event = await newEvent();
        const quest = await newQuest(event, 10);
        const reader = await newPlayer(event);
        const banned = await newPlayer(event);
        await complete(reader.token, quest);
        await complete(banned.token, quest);
        await complete(banned.token, quest);
        expect((await view(reader.token, event)).me?.rank).toBe(2);
        await owner("UPDATE enrollment SET status = 'banned' WHERE id = $1", [banned.enrollment]);
        const after = await view(reader.token, event);
        expect(names(after)).toEqual([await usernameOf(reader.id)]);
        expect(after).toMatchObject({ me: { rank: 1 }, total: 1 });
        expect(await view(reader.token, event)).toMatchObject({ me: { rank: 1 }, total: 1 });
      });

      it("drops the organizer's new team member once the repair runs (FR-1014)", async () => {
        const event = await newEvent();
        const quest = await newQuest(event, 10);
        const reader = await newPlayer(event);
        await complete(reader.token, quest);
        const staffEmail = `staff${counter}@rank.test`;
        const staffer = await newPlayer(event, staffEmail);
        await complete(staffer.token, quest);
        await complete(staffer.token, quest);
        expect((await view(reader.token, event)).me?.rank).toBe(2);
        const staffId = await createStaff(db.owner, { email: staffEmail, passwordHash: "unused" });
        await owner(
          "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'editor')",
          [organizer, staffId],
        );
        await repairs.repairDue();
        expect(await view(reader.token, event)).toMatchObject({ me: { rank: 1 }, total: 1 });
      });

      it("refuses a stranger, an unknown token and a missing event", async () => {
        const event = await newEvent();
        const stranger = await newPlayer(await newEvent());
        const refused = await ranking(stranger.token, event);
        expect(refused.statusCode).toBe(403);
        expect(refused.json()).toMatchObject({ code: "not_enrolled" });
        expect((await ranking(undefined, event)).statusCode).toBe(401);
        expect((await ranking(stranger.token, randomUUID())).statusCode).toBe(404);
        expect(
          (
            await test.app.inject({
              method: "GET",
              url: "/v1/events/not-a-uuid/ranking",
              headers: { authorization: `Bearer ${stranger.token}` },
            })
          ).statusCode,
        ).toBe(400);
      });

      it("leaves the board alone when the reader loses their place in the middle of a read", async () => {
        const event = await newEvent();
        const quest = await newQuest(event, 6);
        const players = [];
        for (let n = 0; n < 4; n += 1) {
          players.push(await newPlayer(event));
          await complete(players[n]?.token ?? "", quest);
        }
        const reader = await newPlayer(event);
        const before = await store.read(event, 10, undefined);
        // A pool whose ranking_rows call first removes the reader, as if they left between the two reads.
        const racing = {
          connect: async () => {
            const client = await pool.connect();
            const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
            (client as unknown as { query: unknown }).query = async (...args: unknown[]) => {
              if (String(args[0]).includes("ranking_rows")) {
                await owner("UPDATE enrollment SET status = 'removed' WHERE id = $1", [
                  reader.enrollment,
                ]);
              }
              return query(...args);
            };
            return client;
          },
        } as unknown as Pool;
        const racy = createRanking({ pool: racing, store, log: () => undefined });
        expect(await racy.read(event, reader.id)).toBe("not_enrolled");
        expect(await store.read(event, 10, undefined)).toEqual(before);
      });

      it("tries a busy rebuild again on the next run", async () => {
        const event = await newEvent();
        await redis.set(`rank:{${event}}:lock`, "someone-else", { PX: 5000 });
        await owner("INSERT INTO ranking_repair (event_id) VALUES ($1) ON CONFLICT DO NOTHING", [
          event,
        ]);
        await repairs.repairDue();
        expect(
          await owner("SELECT 1 FROM ranking_repair WHERE event_id = $1", [event]),
        ).toHaveLength(1);
        await redis.del(`rank:{${event}}:lock`);
        await repairs.repairDue();
        expect(
          await owner("SELECT 1 FROM ranking_repair WHERE event_id = $1", [event]),
        ).toHaveLength(0);
      });

      it("never fails a committed completion because the ranking step failed", async () => {
        const event = await newEvent();
        const a = await newPlayer(event);
        await owner("REVOKE EXECUTE ON FUNCTION ranking_entry_of(bigint) FROM questify_app");
        try {
          const answer = await complete(a.token, await newQuest(event, 3));
          expect(answer.statusCode).toBe(200);
          expect(answer.json()).toMatchObject({ score: 3, rank: null });
        } finally {
          await owner("GRANT EXECUTE ON FUNCTION ranking_entry_of(bigint) TO questify_app");
        }
      });

      it("answers the same from PostgreSQL when Redis is down", async () => {
        const event = await newEvent();
        const quest = await newQuest(event, 7);
        const [a, b] = [await newPlayer(event), await newPlayer(event)];
        await complete(a.token, quest);
        await complete(b.token, quest);
        await complete(b.token, quest);
        expect(await view(a.token, event, down)).toEqual(await view(a.token, event));
      });

      it("rebuilds a lost copy from PostgreSQL to the same order (the Done-when)", async () => {
        const event = await newEvent();
        const quest = await newQuest(event, 4);
        const players = [await newPlayer(event), await newPlayer(event), await newPlayer(event)];
        for (const [index, player] of players.entries()) {
          for (let n = 0; n <= index % 2; n += 1) {
            await complete(player.token, quest);
          }
        }
        const before = await view(players[0]?.token ?? "", event);
        await redis.del([`rank:{${event}}`, `rank:{${event}}:member`, `rank:{${event}}:built`]);
        expect(await view(players[0]?.token ?? "", event)).toEqual(before);
        expect(await store.builtAt(event)).toBeDefined();
      });
    });

    /** A live event whose day starts 12 hours from now; multi-day unless `single` (an hour each side of now). */
    const dayEvent = async (single = false): Promise<string> => {
      counter += 1;
      const span = single
        ? "now() - interval '1 hour', now() + interval '1 hour'"
        : "now() - interval '2 days', now() + interval '1 day'";
      const [event] = await owner<{ id: string }>(
        `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at, day_start_hour)
         VALUES ($1, $2, 'Day Fest', 'live', ${span},
                 (extract(hour FROM now() AT TIME ZONE 'Asia/Riyadh')::int + 12) % 24) RETURNING id`,
        [organizer, `TODAY${counter}`],
      );
      return event?.id ?? "";
    };
    const today = (token: string, event: string, scope = "today", app: TestApp = test) =>
      app.app.inject({
        method: "GET",
        url: `/v1/events/${event}/ranking?scope=${scope}`,
        headers: { authorization: `Bearer ${token}` },
      });
    const yesterday = (event: string, enrollment: string, points: number) =>
      owner(
        `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor,
                                   created_at)
         VALUES ($1, $2, $3, 'welcome', $4, $4, 'system', now() - interval '1 day')`,
        [organizer, event, enrollment, points],
      );

    describe("today's ranking (T-216, FR-610, FR-1611)", () => {
      it("shows only today's points, from Redis and from PostgreSQL alike, and leaves the overall order alone", async () => {
        const event = await dayEvent();
        const quest = await newQuest(event, 10);
        const a = await newPlayer(event);
        const b = await newPlayer(event);
        await yesterday(event, a.enrollment, 200);
        await complete(b.token, quest);
        await complete(b.token, quest);
        await complete(a.token, quest);
        const [{ day } = { day: "" }] = await owner<{ day: string }>(
          "SELECT event_day(now(), e)::text AS day FROM event e WHERE e.id = $1",
          [event],
        );
        const copy = `${event}/${day}`;
        // Each completion wrote today's copy too, before anyone read it.
        expect(await redis.hGet(`rank:{${copy}}:member`, b.enrollment)).toMatch(/^v/);
        const seen = await today(a.token, event);
        expect(seen.statusCode).toBe(200);
        const daily = seen.json<View & { today: boolean }>();
        expect(daily.rows.map((row) => row.score)).toEqual([20, 10]);
        expect(daily.me).toMatchObject({ rank: 2, score: 10 });
        expect(daily).toMatchObject({ total: 2, today: true });
        expect(await view(a.token, event)).toMatchObject({
          me: { rank: 1, score: 210 },
          today: true,
        });
        expect((await today(a.token, event, "today", down)).json()).toEqual(daily);
        await redis.del([`rank:{${copy}}`, `rank:{${copy}}:member`, `rank:{${copy}}:built`]);
        await owner("SELECT mark_ranking_repair($1)", [event]);
        await repairs.repairDue();
        expect(await store.builtAt(copy)).toBeDefined();
        expect((await today(a.token, event)).json()).toEqual(daily);
      });

      it("says no today's ranking for a single-day event, and refuses a bad scope", async () => {
        const event = await dayEvent(true);
        const a = await newPlayer(event);
        await complete(a.token, await newQuest(event, 3));
        expect(await view(a.token, event)).toMatchObject({ today: false, me: { score: 3 } });
        const off = await today(a.token, event);
        expect([off.statusCode, off.json().code]).toEqual([404, "today_ranking_off"]);
        expect((await today(a.token, event, "week")).statusCode).toBe(400);
        expect((await today(a.token, event, "event")).statusCode).toBe(200);
      });

      it("keeps the overall place when only today's copy cannot be written, and marks the event", async () => {
        const dayless: RankingStore = {
          ...store,
          upsert: (key, entry) =>
            key.includes("/")
              ? Promise.reject(new Error("day copy down"))
              : store.upsert(key, entry),
        };
        const broken = await startApp(db, false, {}, { rankingStore: dayless });
        try {
          const event = await dayEvent();
          const a = await newPlayer(event);
          const answer = await complete(a.token, await newQuest(event, 4), broken);
          expect([answer.statusCode, answer.json().rank]).toEqual([200, 1]);
          expect(
            await owner("SELECT 1 FROM ranking_repair WHERE event_id = $1", [event]),
          ).toHaveLength(1);
        } finally {
          await broken.close();
        }
      });
    });

    const toggle = (
      cookie: string,
      event: string,
      enabled: boolean,
      org = organizer,
      path = "ranking",
    ) =>
      test.app.inject({
        method: "PUT",
        url: `/v1/organizers/${org}/events/${event}/${path}`,
        headers: withSession(cookie),
        payload: { enabled },
      });

    describe("the owner's switch (FR-607)", () => {
      let ownerCookie: string;
      let editorCookie: string;

      beforeAll(async () => {
        const ownerEmail = `owner${counter}@rank.test`;
        const editorEmail = `editor${counter}@rank.test`;
        const ownerId = await createStaff(db.owner, { email: ownerEmail });
        const editorId = await createStaff(db.owner, { email: editorEmail });
        await owner(
          "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'editor')",
          [organizer, ownerId, editorId],
        );
        ownerCookie = await signInFully(test, ownerEmail);
        editorCookie = await signInFully(test, editorEmail);
      });

      it("hides the ranking when the owner turns it off, keeping the event's other switches", async () => {
        const event = await newEvent();
        const a = await newPlayer(event);
        await complete(a.token, await newQuest(event, 2));
        await owner(`UPDATE event SET config = '{"features": {"polls": false}}' WHERE id = $1`, [
          event,
        ]);
        const off = await toggle(ownerCookie, event, false);
        expect(off.statusCode).toBe(200);
        expect(off.json()).toEqual({ ranking: false });
        const [stored] = await owner<{ config: unknown }>(
          "SELECT config FROM event WHERE id = $1",
          [event],
        );
        expect(stored?.config).toEqual({ features: { polls: false, ranking: false } });
        const hidden = await ranking(a.token, event);
        expect(hidden.statusCode).toBe(404);
        expect(hidden.json()).toMatchObject({ code: "ranking_off" });
        const read = await test.app.inject({
          method: "GET",
          url: `/v1/organizers/${organizer}/events/${event}`,
          headers: withSession(ownerCookie),
        });
        expect(read.json()).toMatchObject({ event: { ranking: false } });
        expect((await toggle(ownerCookie, event, true)).statusCode).toBe(200);
        expect((await view(a.token, event)).me).toMatchObject({ rank: 1, score: 2 });
        expect(
          await owner<{ action: string }>(
            "SELECT action FROM audit_log WHERE event_id = $1 AND action = 'event.features.update'",
            [event],
          ),
        ).toHaveLength(2);
      });

      it("hides today's ranking when the owner turns it off (FR-608), leaving the event's ranking", async () => {
        const event = await newEvent();
        const a = await newPlayer(event);
        await complete(a.token, await newQuest(event, 2));
        expect(await view(a.token, event)).toMatchObject({ today: true });
        expect(
          (await toggle(editorCookie, event, false, organizer, "ranking-today")).statusCode,
        ).toBe(403);
        const off = await toggle(ownerCookie, event, false, organizer, "ranking-today");
        expect([off.statusCode, off.json()]).toEqual([200, { rankingToday: false }]);
        expect(await view(a.token, event)).toMatchObject({ today: false, me: { score: 2 } });
        const hidden = await test.app.inject({
          method: "GET",
          url: `/v1/events/${event}/ranking?scope=today`,
          headers: { authorization: `Bearer ${a.token}` },
        });
        expect([hidden.statusCode, hidden.json().code]).toEqual([404, "today_ranking_off"]);
        const read = await test.app.inject({
          method: "GET",
          url: `/v1/organizers/${organizer}/events/${event}`,
          headers: withSession(ownerCookie),
        });
        expect(read.json()).toMatchObject({ event: { ranking: true, rankingToday: false } });
      });

      it("is the owner's: an editor gets 403, another organizer's event 404, a bad body 400", async () => {
        const event = await newEvent();
        expect((await toggle(editorCookie, event, false)).statusCode).toBe(403);
        const [other] = await owner<{ id: string }>(
          `INSERT INTO organizer (name, slug) VALUES ('Other Org', $1) RETURNING id`,
          [`other-${counter}`],
        );
        await addMember(db.owner, other?.id ?? "");
        expect((await toggle(ownerCookie, event, false, other?.id ?? "")).statusCode).toBe(404);
        const [foreign] = await owner<{ id: string }>(
          `INSERT INTO event (organizer_id, join_code, name_en) VALUES ($1, $2, 'Foreign') RETURNING id`,
          [other?.id, `FOREIGN${counter}`],
        );
        expect((await toggle(ownerCookie, foreign?.id ?? "", false)).statusCode).toBe(404);
        const bad = await test.app.inject({
          method: "PUT",
          url: `/v1/organizers/${organizer}/events/${event}/ranking`,
          headers: withSession(ownerCookie),
          payload: { enabled: "no" },
        });
        expect(bad.statusCode).toBe(400);
      });
    });
  },
);
