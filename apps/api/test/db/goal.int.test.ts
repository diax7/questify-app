import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withRequestContext } from "#src/db/context";
import {
  TEST_DATABASE_URL,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

/** The SQLSTATE a call is refused with. */
const refusal = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    return (error as { code: string }).code;
  }
  throw new Error("expected a refusal");
};

/** The player's goal in the database (T-213, migration 0033): who may pin what, and what forgets a pin. */
describe.skipIf(TEST_DATABASE_URL === undefined)("the player's goal (database)", () => {
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

  const owner = async <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;

  const newReward = async (event: string): Promise<string> => {
    counter += 1;
    return (
      (
        await owner<{ id: string }>(
          "INSERT INTO reward (event_id, kind, name_en, price, stock_total) VALUES ($1, 'item', $2, 100, 5) RETURNING id",
          [event, `Prize ${counter}`],
        )
      )[0]?.id ?? ""
    );
  };

  const setGoal = (player: string, event: string, reward: string | null) =>
    withRequestContext(db.app, { playerId: player }, async () => {
      const { rows } = await db.app.query<{ goal: string | null }>(
        "SELECT set_goal($1, $2) AS goal",
        [event, reward],
      );
      return rows[0]?.goal;
    });

  const goalOf = async (player: string, event: string) =>
    (
      await owner<{ goal_reward_id: string | null }>(
        "SELECT goal_reward_id FROM enrollment WHERE player_id = $1 AND event_id = $2",
        [player, event],
      )
    )[0]?.goal_reward_id;

  it("pins a reward of the player's event, replaces it and clears it", async () => {
    const first = await newReward(ids.eventA);
    const second = await newReward(ids.eventA);
    expect(await setGoal(ids.playerA, ids.eventA, first)).toBe(first);
    expect(await goalOf(ids.playerA, ids.eventA)).toBe(first);
    expect(await setGoal(ids.playerA, ids.eventA, second)).toBe(second);
    expect(await setGoal(ids.playerA, ids.eventA, null)).toBeNull();
    expect(await goalOf(ids.playerA, ids.eventA)).toBeNull();
  });

  it("refuses another tenant's event and reward, an unknown reward and a removed one, alike", async () => {
    const theirs = await newReward(ids.eventB);
    expect(await refusal(setGoal(ids.playerA, ids.eventB, theirs))).toBe("RN404");
    expect(await refusal(setGoal(ids.playerA, ids.eventB, null))).toBe("RN404");
    expect(await refusal(setGoal(ids.playerA, ids.eventA, theirs))).toBe("RN404");
    expect(await refusal(setGoal(ids.playerA, ids.eventA, ids.eventA))).toBe("RN404");
    const removed = await newReward(ids.eventA);
    await owner("UPDATE reward SET status = 'removed' WHERE id = $1", [removed]);
    expect(await refusal(setGoal(ids.playerA, ids.eventA, removed))).toBe("RN404");
    expect(await goalOf(ids.playerB, ids.eventB)).toBeNull();
  });

  it("refuses a member who is not active and a banned player", async () => {
    await owner("UPDATE enrollment SET status = 'pending' WHERE player_id = $1", [ids.playerA]);
    try {
      expect(await refusal(setGoal(ids.playerA, ids.eventA, null))).toBe("RN404");
    } finally {
      await owner("UPDATE enrollment SET status = 'active' WHERE player_id = $1", [ids.playerA]);
    }
    await owner("UPDATE player SET status = 'banned' WHERE id = $1", [ids.playerA]);
    try {
      expect(await refusal(setGoal(ids.playerA, ids.eventA, null))).toBe("RN404");
    } finally {
      await owner("UPDATE player SET status = 'active' WHERE id = $1", [ids.playerA]);
    }
  });

  it("refuses a request with no player", async () => {
    const reward = await newReward(ids.eventA);
    const code = await refusal(
      withRequestContext(db.app, {}, () =>
        db.app.query("SELECT set_goal($1, $2)", [ids.eventA, reward]),
      ),
    );
    expect(code).toBe("RN404");
  });

  it("forgets the pin when its reward is deleted", async () => {
    const reward = await newReward(ids.eventA);
    await setGoal(ids.playerA, ids.eventA, reward);
    await owner("DELETE FROM reward WHERE id = $1", [reward]);
    expect(await goalOf(ids.playerA, ids.eventA)).toBeNull();
  });

  it("is written only through set_goal: the API role cannot update the column", async () => {
    const reward = await newReward(ids.eventA);
    const code = await refusal(
      withRequestContext(db.app, { playerId: ids.playerA }, () =>
        db.app.query("UPDATE enrollment SET goal_reward_id = $1 WHERE player_id = $2", [
          reward,
          ids.playerA,
        ]),
      ),
    );
    expect(code).toBe("42501");
  });
});
