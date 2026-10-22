import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withRequestContext } from "#src/db/context";
import {
  TEST_DATABASE_URL,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

type Reserved = {
  redemption_id: string;
  status: string;
  price: number;
  balance: string;
  stock_left: number;
  replayed: boolean;
};

const refusal = async (work: Promise<unknown>): Promise<{ code: string; detail?: string }> => {
  try {
    await work;
  } catch (error) {
    const { code, detail } = error as { code: string; detail?: string };
    return detail === undefined ? { code } : { code, detail };
  }
  throw new Error("expected a refusal");
};

describe.skipIf(TEST_DATABASE_URL === undefined)("rewards and reservations (T-201, T-202)", () => {
  let db: TestDatabase;
  let pool: Pool;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let counter = 0;
  let staffA = "";

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = new Pool({ connectionString: db.appUrl, max: 6 });
    ids = await seedTwoTenants(db.owner);
    const staff = await db.owner.query<{ id: string }>(
      "INSERT INTO staff_user (email, password_hash) VALUES ('owner@najd.sa', 'h') RETURNING id",
    );
    staffA = staff.rows[0]?.id ?? "";
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [ids.orgA, staffA],
    );
  });
  afterAll(async () => {
    await pool.end();
    await db.close();
  });

  const owner = async <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;

  /** Pays points the way a quest does: a completion and its ledger entry, so the balance stays the ledger's sum. */
  const fund = async (enrollment: string, points: number): Promise<void> => {
    const [general] = await owner<{ id: string }>("SELECT id FROM category WHERE event_id = $1", [
      ids.eventA,
    ]);
    const [quest] = await owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points) VALUES ($1, $2, 'scan_qr', 'Q', $3)
       RETURNING id`,
      [ids.eventA, general?.id, points],
    );
    const [done] = await owner<{ id: string }>(
      `INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                     idempotency_key)
       VALUES ($1, $2, $3, $4, 1, 'qr', $5) RETURNING id`,
      [ids.orgA, ids.eventA, enrollment, quest?.id, randomUUID()],
    );
    await owner(
      `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                                 completion_id, quest_id, actor)
       VALUES ($1, $2, $3, 'quest', $4, $4, $5, $6, 'player')`,
      [ids.orgA, ids.eventA, enrollment, points, done?.id, quest?.id],
    );
  };

  /** A player enrolled in organizer A's live event with `points` to spend. */
  const newPlayer = async (points = 1000): Promise<{ player: string; enrollment: string }> => {
    counter += 1;
    const [row] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`shopper_${counter}`],
    );
    const [enrolled] = await owner<{ id: string }>(
      "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3) RETURNING id",
      [ids.orgA, ids.eventA, row?.id],
    );
    if (points > 0) {
      await fund(enrolled?.id ?? "", points);
    }
    return { player: row?.id ?? "", enrollment: enrolled?.id ?? "" };
  };

  const newReward = async (fields: Readonly<Record<string, unknown>> = {}): Promise<string> => {
    const [row] = await owner<{ id: string }>(
      `INSERT INTO reward (event_id, kind, name_en, price, stock_total, per_player_limit, opens_at, closes_at)
       VALUES ($1, $2, 'Hoodie', $3, $4, $5, $6, $7) RETURNING id`,
      [
        fields["event"] ?? ids.eventA,
        fields["kind"] ?? "item",
        fields["price"] ?? 200,
        fields["stock"] ?? 5,
        fields["limit"] ?? null,
        fields["opens_at"] ?? null,
        fields["closes_at"] ?? null,
      ],
    );
    return row?.id ?? "";
  };

  const asPlayer = async <T>(player: string, work: (client: PoolClient) => Promise<T>) => {
    const client = await pool.connect();
    try {
      return await withRequestContext(client, { playerId: player }, () => work(client));
    } finally {
      client.release();
    }
  };

  const reserve = (player: string, reward: string, key = randomUUID()) =>
    asPlayer(player, async (client) => {
      const { rows } = await client.query<Reserved>("SELECT * FROM reserve_reward($1, $2)", [
        reward,
        key,
      ]);
      return rows[0] as Reserved;
    });

  const cancel = (player: string, redemption: string) =>
    asPlayer(player, async (client) => {
      const { rows } = await client.query<Reserved>("SELECT * FROM cancel_redemption($1)", [
        redemption,
      ]);
      return rows[0] as Reserved;
    });

  const sums = async (enrollment: string) => {
    const [row] = await owner<{
      balance: string;
      score: string;
      ledger_balance: string;
      ledger_score: string;
    }>(
      `SELECT n.balance, n.score,
              (SELECT coalesce(sum(balance_delta), 0) FROM ledger_entry WHERE enrollment_id = n.id) AS ledger_balance,
              (SELECT coalesce(sum(score_delta), 0) FROM ledger_entry WHERE enrollment_id = n.id) AS ledger_score
       FROM enrollment n WHERE n.id = $1`,
      [enrollment],
    );
    return row;
  };

  const stockOf = async (reward: string) =>
    (await owner<{ units_out: number }>("SELECT units_out FROM reward WHERE id = $1", [reward]))[0]
      ?.units_out;

  describe("reserving", () => {
    it("takes the price from the balance only and holds one unit (FR-506, ADR-043)", async () => {
      const { player, enrollment } = await newPlayer(300);
      const reward = await newReward({ price: 200, stock: 5 });
      const made = await reserve(player, reward);
      expect(made).toMatchObject({ status: "reserved", price: 200, balance: "100", stock_left: 4 });
      expect(made.replayed).toBe(false);
      expect(await sums(enrollment)).toEqual({
        balance: "100",
        score: "300",
        ledger_balance: "100",
        ledger_score: "300",
      });
      const entries = await owner<{ kind: string; balance_delta: string; score_delta: string }>(
        "SELECT kind, balance_delta, score_delta FROM ledger_entry WHERE redemption_id = $1",
        [made.redemption_id],
      );
      expect(entries).toEqual([{ kind: "redeem", balance_delta: "-200", score_delta: "0" }]);
    });

    it("gives the last unit to one of two players reserving at once", async () => {
      const reward = await newReward({ stock: 1 });
      const first = await newPlayer();
      const second = await newPlayer();
      const results = await Promise.allSettled([
        reserve(first.player, reward),
        reserve(second.player, reward),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const failed = results.find((r) => r.status === "rejected");
      expect((failed as PromiseRejectedResult).reason.code).toBe("RO409");
      expect(await stockOf(reward)).toBe(1);
    });

    it("refuses a balance below the price and changes nothing", async () => {
      const { player, enrollment } = await newPlayer(100);
      const reward = await newReward({ price: 200 });
      expect(await refusal(reserve(player, reward))).toEqual({ code: "RB422" });
      expect(await stockOf(reward)).toBe(0);
      expect((await sums(enrollment))?.balance).toBe("100");
    });

    it("keeps the per-player limit, counting reservations held (FR-502)", async () => {
      const { player } = await newPlayer();
      const reward = await newReward({ price: 10, limit: 1 });
      const made = await reserve(player, reward);
      expect(await refusal(reserve(player, reward))).toEqual({ code: "RL409", detail: "1" });
      await cancel(player, made.redemption_id);
      expect((await reserve(player, reward)).status).toBe("reserved");
    });

    it("redeems only inside the reward's window (FR-503)", async () => {
      const { player } = await newPlayer();
      const early = await newReward({ opens_at: new Date(Date.now() + 3_600_000) });
      const late = await newReward({ closes_at: new Date(Date.now() - 1_000) });
      expect(await refusal(reserve(player, early))).toEqual({
        code: "RW403",
        detail: "not_started",
      });
      expect(await refusal(reserve(player, late))).toEqual({ code: "RW403", detail: "ended" });
    });

    it("refuses sold out, removed, other events' rewards and inactive players", async () => {
      const { player, enrollment } = await newPlayer();
      const none = await newReward({ stock: 0 });
      expect(await refusal(reserve(player, none))).toEqual({ code: "RO409" });
      const removed = await newReward();
      await owner("UPDATE reward SET status = 'removed' WHERE id = $1", [removed]);
      expect(await refusal(reserve(player, removed))).toEqual({ code: "RN404" });
      const elsewhere = await newReward({ event: ids.eventB });
      expect(await refusal(reserve(player, elsewhere))).toEqual({ code: "RN404" });
      expect(await refusal(reserve(player, randomUUID()))).toEqual({ code: "RN404" });
      await owner("UPDATE enrollment SET status = 'banned' WHERE id = $1", [enrollment]);
      expect(await refusal(reserve(player, await newReward()))).toEqual({
        code: "RA403",
        detail: "banned",
      });
    });

    it("answers a retry with the same key once, and refuses the key for another reward", async () => {
      const { player, enrollment } = await newPlayer(1000);
      const reward = await newReward({ price: 100 });
      const key = randomUUID();
      const first = await reserve(player, reward, key);
      const again = await reserve(player, reward, key);
      expect(again).toMatchObject({ redemption_id: first.redemption_id, replayed: true });
      expect((await sums(enrollment))?.balance).toBe("900");
      expect(await refusal(reserve(player, await newReward(), key))).toEqual({ code: "RK422" });
    });
  });

  describe("the shop window (ADR-048)", () => {
    it("opens while live and for the days after the end, then closes", async () => {
      const [row] = await owner<{ live: string; after: string; past: string; draft: string }>(
        `SELECT shop_state('live', now() - interval '1 hour', now() + interval '1 hour', 3) AS live,
                shop_state('live', now() - interval '2 days', now() - interval '1 day', 3) AS after,
                shop_state('ended', now() - interval '9 days', now() - interval '4 days', 3) AS past,
                shop_state('scheduled', now() + interval '1 day', now() + interval '2 days', 3) AS draft`,
      );
      expect(row).toEqual({ live: "open", after: "open", past: "closed", draft: "not_open" });
    });

    it("refuses a reservation once the shop has closed", async () => {
      const { player } = await newPlayer();
      const reward = await newReward();
      await owner(
        "UPDATE event SET shop_days_after = 0, ends_at = now() - interval '1 minute' WHERE id = $1",
        [ids.eventA],
      );
      try {
        expect(await refusal(reserve(player, reward))).toEqual({ code: "RS403", detail: "closed" });
      } finally {
        await owner(
          "UPDATE event SET shop_days_after = 3, ends_at = now() + interval '30 days' WHERE id = $1",
          [ids.eventA],
        );
      }
    });
  });

  describe("cancelling and the timeout (FR-513, FR-508, FR-1603)", () => {
    it("returns exactly what was paid and the unit, once", async () => {
      const { player, enrollment } = await newPlayer(500);
      const reward = await newReward({ price: 200, stock: 1 });
      const made = await reserve(player, reward);
      await owner("UPDATE reward SET price = 50 WHERE id = $1", [reward]);
      const back = await cancel(player, made.redemption_id);
      expect(back).toMatchObject({
        status: "cancelled",
        balance: "500",
        stock_left: 1,
        replayed: false,
      });
      const twice = await cancel(player, made.redemption_id);
      expect(twice).toMatchObject({ status: "cancelled", balance: "500", replayed: true });
      const entries = await owner<{ kind: string; balance_delta: string }>(
        "SELECT kind, balance_delta FROM ledger_entry WHERE redemption_id = $1 ORDER BY id",
        [made.redemption_id],
      );
      expect(entries).toEqual([
        { kind: "redeem", balance_delta: "-200" },
        { kind: "redeem_return", balance_delta: "200" },
      ]);
      expect(await sums(enrollment)).toMatchObject({
        balance: "500",
        ledger_balance: "500",
        score: "500",
      });
    });

    it("never cancels another player's reservation", async () => {
      const mine = await newPlayer();
      const theirs = await newPlayer();
      const made = await reserve(mine.player, await newReward());
      expect(await refusal(cancel(theirs.player, made.redemption_id))).toEqual({ code: "RN404" });
      expect(await refusal(cancel(theirs.player, randomUUID()))).toEqual({ code: "RN404" });
    });

    it("expires a reservation past its pickup time, then refuses to cancel it", async () => {
      const { player, enrollment } = await newPlayer(300);
      const reward = await newReward({ price: 100 });
      const made = await reserve(player, reward);
      await owner(
        "UPDATE redemption SET reserved_until = now() - interval '1 second' WHERE id = $1",
        [made.redemption_id],
      );
      const outcomes: (string | null)[] = [];
      for (;;) {
        const [row] = (
          await db.app.query<{ outcome: string | null }>(
            "SELECT expire_one_reservation() AS outcome",
          )
        ).rows;
        outcomes.push(row?.outcome ?? null);
        if (row?.outcome === null) {
          break;
        }
      }
      expect(outcomes).toContain("expired");
      const [ended] = await owner<{ status: string; ended_by: string }>(
        "SELECT status, ended_by FROM redemption WHERE id = $1",
        [made.redemption_id],
      );
      expect(ended).toEqual({ status: "expired", ended_by: "timeout" });
      expect(await stockOf(reward)).toBe(0);
      expect(await sums(enrollment)).toMatchObject({ balance: "300", ledger_balance: "300" });
      expect(await refusal(cancel(player, made.redemption_id))).toEqual({
        code: "RE409",
        detail: "expired",
      });
    });

    it("lets a cancel and the timeout race without paying back twice", async () => {
      const { player, enrollment } = await newPlayer(300);
      const made = await reserve(player, await newReward({ price: 100 }));
      await owner(
        "UPDATE redemption SET reserved_until = now() - interval '1 second' WHERE id = $1",
        [made.redemption_id],
      );
      const expiring = (async () => {
        const client = await pool.connect();
        try {
          return (await client.query("SELECT expire_one_reservation()")).rows;
        } finally {
          client.release();
        }
      })();
      await Promise.allSettled([cancel(player, made.redemption_id), expiring]);
      const returns = await owner<{ n: string }>(
        "SELECT count(*) AS n FROM ledger_entry WHERE redemption_id = $1 AND kind = 'redeem_return'",
        [made.redemption_id],
      );
      expect(returns).toEqual([{ n: "1" }]);
      expect(await sums(enrollment)).toMatchObject({ balance: "300", ledger_balance: "300" });
    });

    it("runs the timeout beside another player's reserve of the same reward without a deadlock", async () => {
      const reward = await newReward({ price: 10, stock: 50 });
      const waiting = await newPlayer();
      for (let i = 0; i < 5; i += 1) {
        const made = await reserve(waiting.player, reward);
        await owner(
          "UPDATE redemption SET reserved_until = now() - interval '1 second' WHERE id = $1",
          [made.redemption_id],
        );
      }
      const buyer = await newPlayer();
      const expiring = (async () => {
        const client = await pool.connect();
        try {
          for (let i = 0; i < 10; i += 1) {
            await client.query("SELECT expire_one_reservation()");
          }
        } finally {
          client.release();
        }
      })();
      const buying = Promise.all([1, 2, 3, 4, 5].map(() => reserve(buyer.player, reward)));
      const results = await Promise.allSettled([expiring, buying]);
      expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
      expect(await stockOf(reward)).toBe(5);
    });
  });

  describe("reads", () => {
    it("shows a member the shop, the stock left and their own reservations", async () => {
      const { player } = await newPlayer(1000);
      const fresh = await newPlayer(1000);
      const reward = await newReward({ price: 100, stock: 3 });
      const made = await reserve(player, reward);
      const [shop] = await asPlayer(
        player,
        async (c) => (await c.query("SELECT * FROM event_shop($1)", [ids.eventA])).rows,
      );
      expect(shop).toMatchObject({
        state: "open",
        pickup_minutes: 120,
        balance: "900",
        first_redemption: false,
      });
      const [first] = await asPlayer(
        fresh.player,
        async (c) =>
          (await c.query("SELECT first_redemption FROM event_shop($1)", [ids.eventA])).rows,
      );
      expect(first).toEqual({ first_redemption: true });
      const listed = await asPlayer(
        player,
        async (c) =>
          (await c.query("SELECT id, stock_left, held_by_me FROM shop_rewards($1)", [ids.eventA]))
            .rows,
      );
      expect(listed).toContainEqual({ id: reward, stock_left: 2, held_by_me: 1 });
      const mine = await asPlayer(
        player,
        async (c) =>
          (await c.query("SELECT id, status, price FROM my_redemptions($1)", [ids.eventA])).rows,
      );
      expect(mine).toContainEqual({ id: made.redemption_id, status: "reserved", price: 100 });
      const history = await asPlayer(
        player,
        async (c) =>
          (await c.query("SELECT kind, title_en FROM member_activity($1, NULL, 5)", [ids.eventA]))
            .rows,
      );
      expect(history[0]).toEqual({ kind: "redeem", title_en: "Hoodie" });
    });

    it("shows a non-member nothing", async () => {
      const stranger = await newPlayer(0);
      await owner("DELETE FROM enrollment WHERE id = $1", [stranger.enrollment]);
      const shop = await asPlayer(
        stranger.player,
        async (c) => (await c.query("SELECT * FROM event_shop($1)", [ids.eventA])).rows,
      );
      const rewards = await asPlayer(
        stranger.player,
        async (c) => (await c.query("SELECT * FROM shop_rewards($1)", [ids.eventA])).rows,
      );
      expect(shop).toEqual([]);
      expect(rewards).toEqual([]);
    });

    it("marks the most reserved rewards popular (FR-1618)", async () => {
      const hot = await newReward({ price: 1, stock: 10 });
      for (let i = 0; i < 3; i += 1) {
        await reserve((await newPlayer(10)).player, hot);
      }
      const { player } = await newPlayer(10);
      const listed = await asPlayer(
        player,
        async (c) => (await c.query("SELECT id, popular FROM shop_rewards($1)", [ids.eventA])).rows,
      );
      expect(listed).toContainEqual({ id: hot, popular: true });
    });
  });

  describe("deny by default", () => {
    it("never lets the API role move units out, write redemptions or spend in the ledger", async () => {
      const reward = await newReward();
      const asOrganizer = (sql: string, values: unknown[]) =>
        withRequestContext(db.app, { organizerId: ids.orgA, staffUserId: staffA }, () =>
          db.app.query(sql, values),
        );
      expect(
        await refusal(asOrganizer("UPDATE reward SET units_out = 1 WHERE id = $1", [reward])),
      ).toEqual({
        code: "42501",
      });
      expect(
        await refusal(
          asOrganizer("UPDATE reward SET event_id = $2 WHERE id = $1", [reward, ids.eventB]),
        ),
      ).toEqual({ code: "42501" });
      expect(
        await refusal(
          asOrganizer("UPDATE redemption SET status = 'cancelled' WHERE reward_id = $1", [reward]),
        ),
      ).toEqual({ code: "42501" });
      expect(
        await refusal(
          asOrganizer("SELECT end_reservation($1, 'cancelled', 'player', 'player', NULL)", [
            randomUUID(),
          ]),
        ),
      ).toEqual({
        code: "42501",
      });
    });

    it("keeps a removed reward removed and the stock total above what is out", async () => {
      const { player } = await newPlayer();
      const reward = await newReward({ stock: 2 });
      await reserve(player, reward);
      const asOrganizer = (sql: string) =>
        withRequestContext(db.app, { organizerId: ids.orgA, staffUserId: staffA }, () =>
          db.app.query(sql, [reward]),
        );
      expect(
        (await refusal(asOrganizer("UPDATE reward SET stock_total = 0 WHERE id = $1"))).code,
      ).toBe("23514");
      await asOrganizer("UPDATE reward SET status = 'removed' WHERE id = $1");
      expect(
        await refusal(asOrganizer("UPDATE reward SET status = 'active' WHERE id = $1")),
      ).toEqual({
        code: "RR409",
      });
    });

    it("hides one organizer's rewards and reservations from another", async () => {
      const reward = await newReward();
      await reserve((await newPlayer()).player, reward);
      const seen = await withRequestContext(
        db.app,
        { organizerId: ids.orgB, staffUserId: staffA },
        async () => ({
          rewards: (await db.app.query("SELECT id FROM reward WHERE event_id = $1", [ids.eventA]))
            .rows,
          redemptions: (
            await db.app.query("SELECT id FROM redemption WHERE event_id = $1", [ids.eventA])
          ).rows,
        }),
      );
      expect(seen).toEqual({ rewards: [], redemptions: [] });
    });

    it("gives an outsider nothing at all", async () => {
      for (const sql of [
        "SELECT * FROM public.reward",
        "SELECT * FROM public.redemption",
        `SELECT * FROM public.reserve_reward('${randomUUID()}', 'k')`,
        `SELECT * FROM public.cancel_redemption('${randomUUID()}')`,
        "SELECT public.expire_one_reservation()",
        `SELECT * FROM public.event_shop('${ids.eventA}')`,
        `SELECT * FROM public.shop_rewards('${ids.eventA}')`,
        `SELECT * FROM public.my_redemptions('${ids.eventA}')`,
      ]) {
        expect((await refusal(db.outsider.query(sql))).code).toBe("42501");
      }
    });
  });
});
