import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
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
type Member = Readonly<{ player: string; enrollment: string }>;

const as = (player: string): RequestContext => ({ playerId: player });
/** Enough rounds to cross the locks often, few enough to finish under load (CTO code review nit 4). */
const ROUNDS = 10;

const noDeadlock = (results: readonly PromiseSettledResult<unknown>[]) => {
  for (const result of results) {
    if (result.status === "rejected") {
      expect(String((result.reason as { code?: string }).code)).not.toBe("40P01");
    }
  }
};

/**
 * The payer crossed with the other writers of the same players (T-306b, ADR-211, ADR-223): a meet payment that locks
 * two players in either order, the owner's results confirmation, and a player's own completion that waits for a
 * batch and then lands. Nobody is paid twice and nothing deadlocks.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("community payer crossed locks (database)", () => {
  let db: TestDatabase;
  let pool: Pool;
  let ids: Awaited<ReturnType<typeof seedTwoTenants>>;
  let ownerA = "";
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = new Pool({ connectionString: db.appUrl, max: 12 });
    ids = await seedTwoTenants(db.owner);
    ownerA = await addMember(db.owner, ids.orgA, "owner");
  });
  afterAll(async () => {
    await pool.end();
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const query = async <T extends Row>(
    context: RequestContext,
    sql: string,
    values: unknown[] = [],
  ) => {
    const client: PoolClient = await pool.connect();
    try {
      return await withRequestContext(
        client,
        context,
        async () => (await client.query<T>(sql, values)).rows,
      );
    } finally {
      client.release();
    }
  };

  const newEvent = async (status = "live") => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
       VALUES ($1, $2, 'Lock Fest', $3, now() - interval '2 hours', now() + interval '1 day') RETURNING id`,
      [ids.orgA, `CML${counter}`, status],
    );
    return event?.id ?? "";
  };
  const newQuest = async (event: string, type: string) => {
    const [category] = await owner<{ id: string }>(
      "INSERT INTO category (event_id, name_en) VALUES ($1, 'People') RETURNING id",
      [event],
    );
    const [quest] = await owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, type_config)
       VALUES ($1, $2, $3, 'Q', 50, 10, $4) RETURNING id`,
      [event, category?.id, type, JSON.stringify(type === "meet" ? { dailyCap: 10 } : {})],
    );
    return quest?.id ?? "";
  };
  const member = async (event: string): Promise<Member> => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`cl_player_${counter}`],
    );
    const [made] = await owner<{ id: string }>(
      "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3) RETURNING id",
      [ids.orgA, event, player?.id],
    );
    return { player: player?.id ?? "", enrollment: made?.id ?? "" };
  };
  /** A reached, final goal whose points step owes `points` to each of `who`. */
  const owe = async (event: string, who: readonly Member[], points = 20) => {
    const [goal] = await owner<{ id: string }>(
      `INSERT INTO community_goal (organizer_id, event_id, title_en, measure, target, starts_at, ends_at, status,
                                   settled_until, final_at)
       VALUES ($1, $2, 'Owed', 'points', 10, now() - interval '1 hour', now() - interval '30 minutes', 'reached',
               now() - interval '30 minutes', now())
       RETURNING id`,
      [ids.orgA, event],
    );
    const [step] = await owner<{ id: string }>(
      `INSERT INTO community_step (event_id, goal_id, threshold, is_goal, reward, points)
       VALUES ($1, $2, 10, true, 'points', $3) RETURNING id`,
      [event, goal?.id, points],
    );
    await owner(
      "INSERT INTO community_reach (step_id, event_id, reached_at, progress) VALUES ($1, $2, now() - interval '40 minutes', 10)",
      [step?.id, event],
    );
    await owner(
      "INSERT INTO community_payout (step_id, enrollment_id, event_id) SELECT $1, unnest($2::uuid[]), $3",
      [step?.id, who.map((one) => one.enrollment), event],
    );
    return step?.id ?? "";
  };
  const pay = (event: string) => query({}, "SELECT * FROM pay_community_batch(500, $1)", [event]);
  const issue = async (who: Member, quest: string) => {
    const hash = randomBytes(32);
    await query(as(who.player), "SELECT * FROM issue_meet_pass($1, $2, NULL)", [quest, hash]);
    return hash;
  };
  const meet = (who: Member, hash: Buffer) =>
    query(as(who.player), "SELECT * FROM meet_player($1, $2, NULL, NULL)", [hash, randomUUID()]);
  const communityEntries = async (who: Member) =>
    (
      await owner<{ n: number }>(
        "SELECT count(*)::int AS n FROM ledger_entry WHERE enrollment_id = $1 AND kind = 'community'",
        [who.enrollment],
      )
    )[0]?.n;

  it("crosses a batch with meet payments over the same two players, in both orders", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const event = await newEvent();
      const [one, two] = [await newQuest(event, "meet"), await newQuest(event, "meet")];
      const [a, b] = [await member(event), await member(event)];
      await owe(event, [a, b]);
      const [fromA, fromB] = [await issue(a, two), await issue(b, one)];
      const results = await Promise.allSettled([pay(event), meet(a, fromB), meet(b, fromA)]);
      noDeadlock(results);
      expect(results.every((result) => result.status === "fulfilled")).toBe(true);
      expect([await communityEntries(a), await communityEntries(b)]).toEqual([1, 1]);
      expect(await pay(event)).toEqual([]);
    }
  }, 120_000);

  it("crosses a batch with the owner's results confirmation: one waits for the other", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const event = await newEvent();
      const [a, b] = [await member(event), await member(event)];
      await owe(event, [a, b]);
      await owner(
        "UPDATE event SET status = 'ended', ends_at = now() - interval '1 second' WHERE id = $1",
        [event],
      );
      const places = async () =>
        (
          await owner<{ ids: string[] }>(
            `SELECT coalesce(array_agg(c.enrollment_id ORDER BY c.rank), '{}') AS ids
             FROM current_places((SELECT e FROM event e WHERE e.id = $1)) c`,
            [event],
          )
        )[0]?.ids;
      const seen = await places();
      const confirm = async (expected: unknown) =>
        query<{ o: string }>(
          { organizerId: ids.orgA, staffUserId: ownerA },
          "SELECT confirm_results($1, $2, $3) AS o",
          [event, expected, randomUUID()],
        );
      const [paid, confirmed] = await Promise.allSettled([pay(event), confirm(seen)]);
      noDeadlock([paid, confirmed]);
      expect(paid.status).toBe("fulfilled");
      if (confirmed.status === "rejected") {
        // Waited for the batch and saw the new places, or ran first and saw the rewards still due.
        expect(["community_paying", "results_changed"]).toContain(
          (confirmed.reason as { detail?: string }).detail,
        );
      }
      expect([await communityEntries(a), await communityEntries(b)]).toEqual([1, 1]);
      expect((await confirm(await places()))[0]?.o).toMatch(/^(confirmed|replayed)$/);
    }
  }, 120_000);

  it("lets a player's completion wait for a batch and land after it", async () => {
    const event = await newEvent();
    const quest = await newQuest(event, "scan_qr");
    const [a, b] = [await member(event), await member(event)];
    await owe(event, [a, b]);
    const batch: PoolClient = await pool.connect();
    try {
      await batch.query("BEGIN");
      await batch.query("SELECT * FROM pay_community_batch(500, $1)", [event]);
      const started = Date.now();
      const scan = query(
        as(a.player),
        "SELECT * FROM complete_quest($1, 'qr', 1, NULL, $2, NULL)",
        [quest, randomUUID()],
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      await batch.query("COMMIT");
      const [done] = await scan;
      expect(Date.now() - started).toBeGreaterThanOrEqual(250);
      expect(done).toMatchObject({ points: "50", score: "70" });
    } finally {
      batch.release();
    }
  });
});
