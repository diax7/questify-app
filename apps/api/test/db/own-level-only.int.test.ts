import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { questifyFixture, type QuestifyFixture } from "#test/support/questify";
import { TEST_DATABASE_URL } from "#test/support/test-db";

/**
 * `own_level_only()` (FOLLOWUPS batch 30, migration 0182): the level field of `own_level(NULL)` alone, which the
 * ranking read's own row takes (ADR-766). Same answer for every caller, at and around every level's first XP, past the
 * last level, for a banned player and for a caller who is no player.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("own_level_only (database)", () => {
  let f: QuestifyFixture;
  beforeAll(async () => {
    f = await questifyFixture();
  });
  afterAll(async () => {
    await f.close();
  });

  const both = async (player: string) => {
    const [old] = await f.asPlayer<{ level: number }>(player, "SELECT level FROM own_level(NULL)");
    const [only] = await f.asPlayer<{ level: number | null }>(
      player,
      "SELECT own_level_only() AS level",
    );
    return { old: old?.level ?? null, only: only?.level ?? null };
  };

  it("answers the level own_level(NULL) answers, for every XP around every level's start", async () => {
    const starts = await f.owner<{ xp_from: string }>(
      "SELECT xp_from FROM xp_level ORDER BY level",
    );
    const totals = new Set<number>([0, 1]);
    for (const row of starts) {
      const from = Number(row.xp_from);
      for (const near of [from - 1, from, from + 1]) if (near >= 0) totals.add(near);
    }
    totals.add(Number(starts.at(-1)?.xp_from) * 3);
    const seen = new Set<number>();
    for (const xp of totals) {
      const player = await f.newPlayer();
      await f.owner("UPDATE player_xp SET xp = $2 WHERE player_id = $1", [player, xp]);
      const answer = await both(player);
      expect(answer.only, `${xp} XP`).toBe(answer.old);
      expect(answer.only, `${xp} XP`).not.toBeNull();
      seen.add(answer.only ?? 0);
    }
    expect(seen.size).toBe(starts.length);
  });

  it("answers no level for a banned player or a caller who is no player, as own_level(NULL) has no row", async () => {
    const banned = await f.newPlayer();
    await f.owner("UPDATE player_xp SET xp = 500 WHERE player_id = $1", [banned]);
    await f.owner("UPDATE player SET status = 'banned' WHERE id = $1", [banned]);
    expect(await both(banned)).toEqual({ old: null, only: null });
    const [outsider] = await f.run<{ level: number | null }>(
      f.team(),
      "SELECT own_level_only() AS level",
    );
    expect(outsider?.level).toBeNull();
  });

  it("is a definer with its search path pinned, granted to the API's role alone", async () => {
    const [row] = await f.owner<{
      language: string;
      definer: boolean;
      settings: string[];
      app: boolean;
      public: boolean;
      outsider: boolean;
    }>(
      `SELECT l.lanname AS language, p.prosecdef AS definer, p.proconfig AS settings,
              has_function_privilege('questify_app', p.oid, 'EXECUTE') AS app,
              has_function_privilege('public', p.oid, 'EXECUTE') AS public,
              has_function_privilege('questify_outsider', p.oid, 'EXECUTE') AS outsider
       FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.oid = 'public.own_level_only()'::regprocedure`,
    );
    expect(row).toEqual({
      language: "plpgsql",
      definer: true,
      settings: ["search_path=public, pg_temp"],
      app: true,
      public: false,
      outsider: false,
    });
  });
});
