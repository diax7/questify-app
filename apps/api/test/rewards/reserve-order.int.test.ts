import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withRequestContext } from "#src/db/context";
import {
  TEST_DATABASE_URL,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

type Row = Record<string, unknown>;

const refusal = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    const { code, detail } = error as { code: string; detail?: string };
    return detail === undefined ? code : `${code}:${detail}`;
  }
  return "none";
};

/**
 * `reserve_reward`'s refusal order and answers, pinned before T-612 moved its gates into `spend_checks` and its writes
 * into `spend_reward` (plan review 88, MAJOR 2). Each order case breaks two neighbouring checks and expects the earlier
 * one. The answer cases pin every column for an item, a digital code, a rehearsal's digital reward, a replay and a key
 * reused for another reward.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("reserve_reward order and answers", () => {
  let db: TestDatabase;
  let pool: Pool;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = new Pool({ connectionString: db.appUrl, max: 4 });
    ids = await seedTwoTenants(db.owner);
  });
  afterAll(async () => {
    await pool.end();
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;

  type EventShape = { status?: string; starts?: string; ends?: string; hours?: string | null };
  const newEvent = async (shape: EventShape = {}): Promise<string> => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at, desk_location_en, desk_hours,
                          shop_days_after, pickup_minutes)
       VALUES ($1, $2, 'Order Fest', $3, now() + $4::interval, now() + $5::interval, 'Hall B', $6::tstzmultirange,
               0, 60)
       RETURNING id`,
      [
        ids.orgA,
        `ORD${counter}`,
        shape.status ?? "live",
        shape.starts ?? "-1 hour",
        shape.ends ?? "2 days",
        shape.hours ?? null,
      ],
    );
    return event?.id ?? "";
  };

  const newPlayer = async (event: string, points = 1000, via = "code") => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`order_player_${counter}`],
    );
    const [enrolled] = await owner<{ id: string }>(
      `INSERT INTO enrollment (organizer_id, event_id, player_id, joined_via) VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [ids.orgA, event, player?.id, via],
    );
    if (points > 0) {
      await owner(
        `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor)
         VALUES ($1, $2, $3, 'welcome', $4, $4, 'system')`,
        [ids.orgA, event, enrolled?.id, points],
      );
    }
    return { player: player?.id ?? "", enrollment: enrolled?.id ?? "" };
  };

  type RewardShape = {
    kind?: string;
    price?: number;
    stock?: number;
    limit?: number | null;
    opens?: string | null;
    closes?: string | null;
  };
  const newReward = async (event: string, shape: RewardShape = {}): Promise<string> => {
    const [row] = await owner<{ id: string }>(
      `INSERT INTO reward (event_id, kind, name_en, price, stock_total, per_player_limit, opens_at, closes_at)
       VALUES ($1, $2, 'Hoodie', $3, $4, $5, now() + $6::interval, now() + $7::interval) RETURNING id`,
      [
        event,
        shape.kind ?? "item",
        shape.price ?? 200,
        shape.stock ?? 5,
        shape.limit ?? null,
        shape.opens ?? null,
        shape.closes ?? null,
      ],
    );
    return row?.id ?? "";
  };
  const addCode = async (event: string, reward: string): Promise<Buffer> => {
    const cipher = randomBytes(40);
    await owner(
      `INSERT INTO reward_code (organizer_id, event_id, reward_id, code_cipher, code_hash)
       VALUES ($1, $2, $3, $4, $5)`,
      [ids.orgA, event, reward, cipher, randomBytes(32)],
    );
    return cipher;
  };
  const lockReward = async (event: string, reward: string): Promise<void> => {
    const [goal] = await owner<{ id: string }>(
      `INSERT INTO community_goal (organizer_id, event_id, title_en, measure, target, starts_at, ends_at)
       VALUES ($1, $2, 'Together', 'points', 100, now(), now() + interval '1 hour') RETURNING id`,
      [ids.orgA, event],
    );
    await owner(
      `INSERT INTO community_step (event_id, goal_id, threshold, reward, unlock_reward_id)
       VALUES ($1, $2, 10, 'unlock', $3)`,
      [event, goal?.id, reward],
    );
  };
  const shopOff = (event: string) =>
    owner(
      `UPDATE event SET config = jsonb_set(config, '{features}', '{"shop": false}') WHERE id = $1`,
      [event],
    );

  const reserve = async (player: string, reward: string, key = randomUUID()) => {
    const client = await pool.connect();
    try {
      return await withRequestContext(client, { playerId: player }, async () => {
        const { rows } = await client.query("SELECT * FROM reserve_reward($1, $2)", [reward, key]);
        return rows[0] as Row;
      });
    } finally {
      client.release();
    }
  };
  describe("the refusal order: each case breaks two neighbouring checks", () => {
    it("a replay answers before the enrollment's status", async () => {
      const event = await newEvent();
      const reward = await newReward(event);
      const who = await newPlayer(event);
      const key = randomUUID();
      await reserve(who.player, reward, key);
      await owner("UPDATE enrollment SET status = 'removed' WHERE id = $1", [who.enrollment]);
      expect((await reserve(who.player, reward, key))["replayed"]).toBe(true);
    });

    it("RA403 (not active) before RP403 (paused)", async () => {
      const event = await newEvent();
      const reward = await newReward(event);
      const who = await newPlayer(event);
      await owner(
        "UPDATE enrollment SET status = 'banned', redeem_paused_at = now() WHERE id = $1",
        [who.enrollment],
      );
      expect(await refusal(reserve(who.player, reward))).toBe("RA403:banned");
    });

    it("RP403 (paused) before RN404 (the reward removed)", async () => {
      const event = await newEvent();
      const reward = await newReward(event);
      const who = await newPlayer(event);
      await owner("UPDATE enrollment SET redeem_paused_at = now() WHERE id = $1", [who.enrollment]);
      await owner("UPDATE reward SET status = 'removed' WHERE id = $1", [reward]);
      expect(await refusal(reserve(who.player, reward))).toBe("RP403");
    });

    it("RN404 (removed) before RW403 community_locked", async () => {
      const event = await newEvent();
      const reward = await newReward(event);
      const who = await newPlayer(event);
      await lockReward(event, reward);
      await owner("UPDATE reward SET status = 'removed' WHERE id = $1", [reward]);
      expect(await refusal(reserve(who.player, reward))).toBe("RN404");
    });

    it("RW403 community_locked before RS403 feature_off", async () => {
      const event = await newEvent();
      const reward = await newReward(event);
      const who = await newPlayer(event);
      await lockReward(event, reward);
      await shopOff(event);
      expect(await refusal(reserve(who.player, reward))).toBe("RW403:community_locked");
    });

    it("RS403 feature_off before the shop's window", async () => {
      const event = await newEvent({ status: "ended", starts: "-3 days", ends: "-2 days" });
      const reward = await newReward(event);
      const who = await newPlayer(event);
      await shopOff(event);
      expect(await refusal(reserve(who.player, reward))).toBe("RS403:feature_off");
    });

    it("the shop's window before desk_finished", async () => {
      const event = await newEvent({
        status: "ended",
        starts: "-3 days",
        ends: "-2 days",
        hours: "{[2020-01-01 10:00+00,2020-01-01 12:00+00)}",
      });
      const reward = await newReward(event);
      const who = await newPlayer(event);
      expect(await refusal(reserve(who.player, reward))).toBe("RS403:closed");
    });

    it("desk_finished before RW403 not_started", async () => {
      const event = await newEvent({ hours: "{[2020-01-01 10:00+00,2020-01-01 12:00+00)}" });
      const reward = await newReward(event, { opens: "1 hour" });
      const who = await newPlayer(event);
      expect(await refusal(reserve(who.player, reward))).toBe("RS403:desk_finished");
    });

    it("RW403 not_started before RO409 (not_started and ended never meet)", async () => {
      const event = await newEvent();
      const reward = await newReward(event, { opens: "1 hour", stock: 0 });
      const who = await newPlayer(event);
      expect(await refusal(reserve(who.player, reward))).toBe("RW403:not_started");
    });

    it("RW403 ended before RO409", async () => {
      const event = await newEvent();
      const reward = await newReward(event, { opens: "-2 hours", closes: "-1 hour", stock: 0 });
      const who = await newPlayer(event);
      expect(await refusal(reserve(who.player, reward))).toBe("RW403:ended");
    });

    it("RO409 before RL409", async () => {
      const event = await newEvent();
      const reward = await newReward(event, { stock: 1, limit: 1 });
      const who = await newPlayer(event);
      await reserve(who.player, reward);
      expect(await refusal(reserve(who.player, reward))).toBe("RO409");
    });

    it("RL409 before RB422", async () => {
      const event = await newEvent();
      const reward = await newReward(event, { price: 300, limit: 1 });
      const who = await newPlayer(event, 400);
      await reserve(who.player, reward);
      expect(await refusal(reserve(who.player, reward))).toBe("RL409:1");
    });

    it("RB422 before RX500 (a digital reward whose codes ran out)", async () => {
      const event = await newEvent();
      const reward = await newReward(event, { kind: "digital", stock: 1, price: 300 });
      const who = await newPlayer(event, 100);
      expect(await refusal(reserve(who.player, reward))).toBe("RB422");
      const rich = await newPlayer(event, 1000);
      expect(await refusal(reserve(rich.player, reward))).toBe("RX500");
    });

    it("RN404 for an unknown reward and for a stranger to the event", async () => {
      const event = await newEvent();
      const reward = await newReward(event);
      const who = await newPlayer(event);
      expect(await refusal(reserve(who.player, randomUUID()))).toBe("RN404");
      const elsewhere = await newPlayer(await newEvent());
      expect(await refusal(reserve(elsewhere.player, reward))).toBe("RN404");
    });
  });

  describe("the answers, every column", () => {
    it("an item: reserved until the pickup time, one unit and the price taken", async () => {
      const event = await newEvent();
      const reward = await newReward(event, { price: 250, stock: 4 });
      const who = await newPlayer(event, 1000);
      const row = await reserve(who.player, reward);
      const [made] = await owner<{ reserved_until: Date; created_at: Date }>(
        "SELECT reserved_until, created_at FROM redemption WHERE id = $1",
        [row["redemption_id"]],
      );
      expect(row).toEqual({
        redemption_id: expect.any(String),
        kind: "item",
        status: "reserved",
        price: 250,
        reserved_until: made?.reserved_until,
        balance: "750",
        stock_left: 3,
        replayed: false,
        code_cipher: null,
      });
      expect(made?.reserved_until.getTime()).toBe((made?.created_at.getTime() ?? 0) + 60 * 60_000);
      const ledger = await owner(
        `SELECT kind, score_delta, balance_delta, actor FROM ledger_entry WHERE redemption_id = $1`,
        [row["redemption_id"]],
      );
      expect(ledger).toEqual([
        { kind: "redeem", score_delta: "0", balance_delta: "-250", actor: "player" },
      ]);
      expect(await owner("SELECT units_out FROM reward WHERE id = $1", [reward])).toEqual([
        { units_out: 1 },
      ]);
    });

    it("a digital code: delivered at once with its sealed code", async () => {
      const event = await newEvent();
      const reward = await newReward(event, { kind: "digital", stock: 2, price: 100 });
      const cipher = await addCode(event, reward);
      await addCode(event, reward);
      const who = await newPlayer(event, 500);
      const row = await reserve(who.player, reward);
      expect(row).toEqual({
        redemption_id: expect.any(String),
        kind: "digital",
        status: "delivered",
        price: 100,
        reserved_until: null,
        balance: "400",
        stock_left: 1,
        replayed: false,
        code_cipher: cipher,
      });
    });

    it("a rehearsal's digital reward: delivered with no code, the stock untouched", async () => {
      const event = await newEvent({ status: "draft", starts: "1 day", ends: "3 days" });
      const reward = await newReward(event, { kind: "digital", stock: 3, price: 100 });
      const who = await newPlayer(event, 500, "rehearsal");
      const row = await reserve(who.player, reward);
      expect(row).toEqual({
        redemption_id: expect.any(String),
        kind: "digital",
        status: "delivered",
        price: 100,
        reserved_until: null,
        balance: "400",
        stock_left: 3,
        replayed: false,
        code_cipher: null,
      });
      expect(await owner("SELECT units_out FROM reward WHERE id = $1", [reward])).toEqual([
        { units_out: 0 },
      ]);
    });

    it("a replay: the first redemption again, with today's balance and stock", async () => {
      const event = await newEvent();
      const reward = await newReward(event, { price: 200, stock: 5 });
      const who = await newPlayer(event, 1000);
      const key = randomUUID();
      const first = await reserve(who.player, reward, key);
      await reserve(who.player, reward);
      const again = await reserve(who.player, reward, key);
      expect(again).toEqual({ ...first, balance: "600", stock_left: 3, replayed: true });
    });

    it("RK422: a key that reserved another reward", async () => {
      const event = await newEvent();
      const reward = await newReward(event);
      const other = await newReward(event);
      const who = await newPlayer(event);
      const key = randomUUID();
      await reserve(who.player, reward, key);
      expect(await refusal(reserve(who.player, other, key))).toBe("RK422");
    });
  });
});
