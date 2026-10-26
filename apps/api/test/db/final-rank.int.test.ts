import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_DATABASE_URL } from "#test/support/test-db";
import { questifyFixture, type QuestifyFixture } from "#test/support/questify";

/**
 * The final-rank snapshot (T-403, migration 0065, ADR-275): written once with result_place at confirmation, from one
 * ordering; append-only; the backfill for events confirmed before it; kept on erasure tombstones.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("final ranks (database)", () => {
  let f: QuestifyFixture;
  beforeAll(async () => {
    f = await questifyFixture();
  });
  afterAll(async () => {
    await f.close();
  });

  const ranksOf = (event: string) =>
    f.owner<{ rank: number; enrollment_id: string }>(
      "SELECT rank, enrollment_id FROM final_rank WHERE event_id = $1 ORDER BY rank",
      [event],
    );
  const placesOf = (event: string) =>
    f.owner<{ rank: number; enrollment_id: string }>(
      "SELECT rank, enrollment_id FROM result_place WHERE event_id = $1 ORDER BY rank",
      [event],
    );
  /** `count` ranked members with distinct scores (highest first), plus a zero-point member and an operator. */
  const crowd = async (count: number) => {
    const event = await f.newEvent();
    const ranked: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const enrollment = await f.join(event, await f.newPlayer());
      await f.earn(event, enrollment, { points: 1000 - i });
      ranked.push(enrollment);
    }
    const zero = await f.join(event, await f.newPlayer());
    const operator = await f.newPlayer();
    const staffed = await f.join(event, operator);
    await f.earn(event, staffed, { points: 5000 });
    await f.owner(
      "INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities) VALUES ($1, $2, $3, $4)",
      [f.ids.orgA, event, operator, ["hand_over"]],
    );
    return { event, ranked, zero, staffed };
  };

  it("writes every ranked member once at confirmation; its top equals result_place", async () => {
    const { event, ranked, zero, staffed } = await crowd(12);
    expect(await f.confirm(event)).toBe("confirmed");
    const ranks = await ranksOf(event);
    expect(ranks.map((row) => row.enrollment_id)).toEqual(ranked);
    expect(ranks.map((row) => row.rank)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(await placesOf(event)).toEqual(ranks.slice(0, 10));
    expect(ranks.map((row) => row.enrollment_id)).not.toContain(zero);
    expect(ranks.map((row) => row.enrollment_id)).not.toContain(staffed);
    expect(await f.confirm(event)).toBe("replayed");
    expect(await ranksOf(event)).toHaveLength(12);
  });

  it("is append-only for every role, the owner included", async () => {
    const { event } = await crowd(2);
    await f.confirm(event);
    for (const sql of [
      "UPDATE final_rank SET rank = rank + 10 WHERE event_id = $1",
      "DELETE FROM final_rank WHERE event_id = $1",
    ]) {
      await expect(f.owner(sql, [event])).rejects.toThrow(/never be changed/);
    }
    await expect(f.owner("TRUNCATE final_rank")).rejects.toThrow(/never be changed/);
    expect(await ranksOf(event)).toHaveLength(2);
  });

  it("backfills an event confirmed before the snapshot: its places first, then the rest; once", async () => {
    const { event, ranked } = await crowd(12);
    await f.owner(
      "INSERT INTO event_result (event_id, organizer_id, confirmed_at) VALUES ($1, $2, now())",
      [event, f.ids.orgA],
    );
    // An older confirmation froze the top ten in a different order from today's scores.
    const frozen = [ranked[1], ranked[0], ...ranked.slice(2, 10)];
    for (const [i, enrollment] of frozen.entries()) {
      await f.owner(
        "INSERT INTO result_place (event_id, rank, enrollment_id, score, score_version) VALUES ($1, $2, $3, 1, 1)",
        [event, i + 1, enrollment],
      );
    }
    const before = await f.owner<{ n: string }>("SELECT count(*) AS n FROM final_rank");
    await f.owner("SELECT backfill_final_ranks()");
    expect((await ranksOf(event)).map((row) => row.enrollment_id)).toEqual([
      ...frozen,
      ranked[10],
      ranked[11],
    ]);
    const once = await f.owner<{ n: string }>("SELECT count(*) AS n FROM final_rank");
    expect(Number(once[0]?.n) - Number(before[0]?.n)).toBe(12);
    await f.owner("SELECT backfill_final_ranks()");
    expect(await f.owner<{ n: string }>("SELECT count(*) AS n FROM final_rank")).toEqual(once);
  });

  it("keeps the rank and the earned tier on an erased player's tombstone", async () => {
    const event = await f.newEvent();
    const player = await f.newPlayer();
    const enrollment = await f.join(event, player);
    await f.earn(event, enrollment);
    await f.confirm(event);
    await f.reveal(event);
    expect(await f.sync(player)).toEqual([
      { id: "events-attended", tier: "bronze" },
      { id: "top-ten", tier: "bronze" },
    ]);
    await f.asPlayer(player, "SELECT * FROM erase_player($1, true, $2)", [
      await f.deletionToken(player),
      randomUUID(),
    ]);
    expect(await ranksOf(event)).toEqual([{ rank: 1, enrollment_id: enrollment }]);
    expect(await f.earned(player)).toEqual(["events-attended:bronze", "top-ten:bronze"]);
  });

  it.runIf(process.env["QUESTIFY_TIMING"] === "1")(
    "confirms 20,000 ranked members within 10 seconds (opt-in timing)",
    async () => {
      const event = await f.newEvent();
      await f.owner(
        "INSERT INTO player (username) SELECT 'rank_load_' || i FROM generate_series(1, 20000) i",
      );
      await f.owner(
        `INSERT INTO enrollment (organizer_id, event_id, player_id, score, score_version)
         SELECT $1, $2, p.id, 100000 - row_number() OVER (ORDER BY p.username), row_number() OVER (ORDER BY p.username)
         FROM player p WHERE p.username LIKE 'rank_load_%'`,
        [f.ids.orgA, event],
      );
      const started = Date.now();
      expect(await f.confirm(event)).toBe("confirmed");
      const elapsed = Date.now() - started;
      expect(await ranksOf(event)).toHaveLength(20000);
      expect(elapsed, `confirm_results with 20,000 ranked members took ${elapsed} ms`).toBeLessThan(
        10_000,
      );
    },
    120_000,
  );
});
