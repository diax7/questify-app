import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "#src/db/context";
import { dailyFixture, type DailyFixture } from "#test/support/daily";
import { questifyFixture, type QuestifyFixture } from "#test/support/questify";
import { TEST_DATABASE_URL } from "#test/support/test-db";

type Shown = {
  rank: number;
  username: string;
  avatar: string;
  equipment: Record<string, unknown>;
  xp: number;
  level: number;
  isMe?: boolean;
};
type Board = { board: string; rows: Shown[]; me: Shown | null };
type Season = { month: string; players: number; rows: Shown[] };

const ROW_KEYS = ["avatar", "equipment", "isMe", "level", "rank", "username", "xp"];
const ME_KEYS = ["avatar", "equipment", "level", "rank", "username", "xp"];
const SCAN = "SELECT * FROM complete_quest($1, 'code', NULL, 'ABC', $2, NULL)";
const scanStatement = (player: string, quest: string) => ({
  context: { playerId: player } as RequestContext,
  sql: SCAN,
  values: [quest, randomUUID()],
});

/** Shared helpers over either fixture: boards, the ledger check and seeded boards. */
function helpers(f: QuestifyFixture) {
  /** Board rows that differ from the ledger for one player ('all' and xp_month_of months, sums and highest ids). */
  const mismatches = async (player: string) =>
    f.owner<{ board: string }>(
      `SELECT coalesce(b.board, l.board) AS board FROM (
         SELECT 'all' AS board, sum(e.delta) AS xp, max(e.id) AS v FROM xp_entry e WHERE e.player_id = $1
         HAVING count(*) > 0
         UNION ALL
         SELECT xp_month_of(e.id), sum(e.delta), max(e.id) FROM xp_entry e WHERE e.player_id = $1 GROUP BY 1
       ) l FULL JOIN (SELECT * FROM xp_board WHERE player_id = $1) b ON b.board = l.board
       WHERE b.xp IS DISTINCT FROM l.xp OR b.xp_version IS DISTINCT FROM l.v
       UNION ALL
       SELECT 'player_xp' FROM player_xp x LEFT JOIN xp_board b ON b.player_id = x.player_id AND b.board = 'all'
       WHERE x.player_id = $1 AND coalesce(b.xp, 0) <> x.xp`,
      [player],
    );
  const boardsOf = async (player: string) =>
    f.owner<{ board: string; xp: string; xp_version: string }>(
      "SELECT board, xp, xp_version FROM xp_board WHERE player_id = $1 ORDER BY board",
      [player],
    );
  const json = async (board: string, reader: string | null) =>
    (await f.owner<{ r: Board }>("SELECT xp_board_json($1, $2) AS r", [board, reader]))[0]
      ?.r as Board;
  /** `n` active players straight onto `board` with the given XP and version per index; answers their ids. */
  const seed = async (board: string, n: number, xpOf: string, versionOf: string) =>
    (
      await f.owner<{ id: string }>(
        `WITH made AS (
           INSERT INTO player (username)
           SELECT 'rk_' || $2 || '_' || g FROM generate_series(1, $1::int) g RETURNING id, username
         ), numbered AS (
           SELECT id, split_part(username, '_', 3)::int AS g FROM made
         ), placed AS (
           INSERT INTO xp_board (board, player_id, xp, xp_version)
           SELECT $3, id, ${xpOf}, ${versionOf} FROM numbered RETURNING player_id
         )
         SELECT n.id FROM numbered n ORDER BY n.g`,
        [n, board.replace("-", ""), board],
      )
    ).map((row) => row.id);
  const reference = async (board: string) =>
    f.owner<{ id: string; username: string; place: string }>(
      `SELECT b.player_id AS id, p.username, row_number() OVER (ORDER BY b.xp DESC, b.xp_version) AS place
       FROM xp_board b JOIN player p ON p.id = b.player_id
       WHERE b.board = $1 AND b.xp > 0 AND p.status = 'active' ORDER BY place`,
      [board],
    );
  /** The functions whose source matches `pattern`, other than xp_apply, and whether each calls xp_apply. */
  const writers = async (pattern: string) =>
    (
      await f.owner<{ name: string; applies: boolean }>(
        `SELECT p.proname AS name, p.prosrc ~ 'xp_apply\\(' AS applies FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.prosrc ~* $1 ORDER BY 1`,
        [pattern],
      )
    ).filter((row) => row.name !== "xp_apply");
  return { mismatches, boardsOf, json, seed, reference, writers };
}

/**
 * The Questify-wide ranking in the database (T-408, migration 0072, FR-611, FR-605, FR-606, ADR-322): the boards kept
 * by xp_apply equal the ledger after every writer and every race; the order, the tie rule and the 11-row answer; who is
 * left out; the caller-bound player door, the switch and the admin's season doors.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("the Questify-wide ranking (database)", () => {
  let f: DailyFixture;
  let h: ReturnType<typeof helpers>;
  beforeAll(async () => {
    f = await dailyFixture();
    h = helpers(f);
  });
  afterAll(async () => {
    await f.close();
  });

  const ranking = async (player: string, scope = "lifetime") =>
    (await f.asPlayer<{ r: Board }>(player, "SELECT questify_ranking($1) AS r", [scope]))[0]
      ?.r as Board;
  const codeQuest = async (event: string) =>
    (
      await f.owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, type_config)
         SELECT $1, id, 'enter_code', 'Booth', 10, 1, '{"code": "ABC"}' FROM category WHERE event_id = $1 LIMIT 1
         RETURNING id`,
        [event],
      )
    )[0]?.id ?? "";
  const liveQuest = async (player: string) => {
    const event = await f.newEvent({ phase: "live" });
    await f.join(event, player);
    return codeQuest(event);
  };
  const scan = (player: string, quest: string) => f.asPlayer(player, SCAN, [quest, randomUUID()]);
  const highestIds = async (player: string) =>
    f.owner<{ ok: boolean }>(
      `SELECT bool_and(b.xp_version = (SELECT max(e.id) FROM xp_entry e WHERE e.player_id = b.player_id
                                       AND (b.board = 'all' OR xp_month_of(e.id) = b.board))) AS ok
       FROM xp_board b WHERE b.player_id = $1`,
      [player],
    );

  describe("order and the answer's shape", () => {
    it("ranks by XP, then the lower version; a reader 120th sees the top 10 and rank 120 (FR-611, FR-606)", async () => {
      const ids = await h.seed("1999-04", 125, "1000 - g", "1000 + g");
      await f.owner(
        "UPDATE xp_board SET xp = 875, xp_version = 5000 WHERE board = '1999-04' AND player_id = $1",
        [ids[0]],
      );
      const seen = await h.json("1999-04", ids[120] ?? "");
      expect(seen.rows.map((row) => row.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(seen.rows.every((row) => row.isMe === false)).toBe(true);
      expect(seen.me).toMatchObject({ rank: 120, xp: 879 });
      const tie = await h.json("1999-04", ids[0] ?? "");
      // 875 is also the XP of ids[124] (1000 - 125, version 1125): the lower version ranks first.
      expect(tie.me?.rank).toBe(125);
    });

    it("matches row_number over active rows for every player, banned players left out (reference check)", async () => {
      const ids = await h.seed(
        "1999-05",
        300,
        "1 + (g * 7919) % 23",
        "1000 + (g * 104729) % 300000",
      );
      const banned = ids.filter((_, index) => index % 15 === 0);
      await f.owner("UPDATE player SET status = 'banned' WHERE id = ANY($1::uuid[])", [banned]);
      const expected = await h.reference("1999-05");
      const places = new Map(expected.map((row) => [row.id, Number(row.place)]));
      for (const id of ids) {
        const seen = await h.json("1999-05", id);
        expect(seen.me?.rank ?? null, id).toBe(places.get(id) ?? null);
      }
      const top = await h.json("1999-05", null);
      expect(top.rows.map((row) => row.username)).toEqual(
        expected.slice(0, 10).map((row) => row.username),
      );
      expect(top.me).toBeNull();
    });

    it("answers exactly the listed keys through the door: no id, contact, birth year or gems", async () => {
      const player = await f.newPlayer();
      await scan(player, await liveQuest(player));
      const seen = await ranking(player);
      expect(seen.board).toBe("all");
      expect(seen.rows.length).toBeGreaterThan(0);
      for (const row of seen.rows) expect(Object.keys(row).toSorted()).toEqual(ROW_KEYS);
      expect(Object.keys(seen.me ?? {}).toSorted()).toEqual(ME_KEYS);
      expect(seen.me).toMatchObject({ xp: 100, level: 1, username: await f.usernameOf(player) });
      const ahead = await f.owner<{ n: string }>(
        `SELECT count(*) AS n FROM xp_board b JOIN player p ON p.id = b.player_id, xp_board m
         WHERE m.board = 'all' AND m.player_id = $1 AND b.board = 'all' AND b.xp > 0 AND p.status = 'active'
           AND (b.xp > m.xp OR (b.xp = m.xp AND b.xp_version < m.xp_version))`,
        [player],
      );
      expect(seen.me?.rank).toBe(Number(ahead[0]?.n) + 1);
      const month = await ranking(player, "month");
      const [now] = await f.owner<{ m: string }>("SELECT questify_month(now()) AS m");
      expect(month).toMatchObject({ board: now?.m, me: { xp: 100 } });
    });

    it("gives a player with no XP no place, and still the top rows", async () => {
      const seen = await ranking(await f.newPlayer());
      expect(seen.me).toBeNull();
      expect(Array.isArray(seen.rows)).toBe(true);
    });
  });

  /** Two players, the first ahead of the second, and the second's place now. */
  const pair = async () => {
    const ahead = await f.newPlayer();
    const behind = await f.newPlayer();
    await scan(ahead, await liveQuest(ahead));
    await scan(ahead, await liveQuest(ahead));
    await scan(behind, await liveQuest(behind));
    return { ahead, behind, before: (await ranking(behind)).me?.rank ?? 0 };
  };

  describe("who is left out", () => {
    it("drops a banned player from every place and refuses their own read", async () => {
      const { ahead, behind, before } = await pair();
      await f.owner("UPDATE player SET status = 'banned' WHERE id = $1", [ahead]);
      expect((await ranking(behind)).me?.rank).toBe(before - 1);
      await expect(ranking(ahead)).rejects.toMatchObject({ code: "PI401" });
    });

    it("drops a deleted account (its board rows kept on the tombstone) and refuses its read", async () => {
      const { ahead, behind, before } = await pair();
      await f.asPlayer(ahead, "SELECT * FROM erase_player($1, true, $2)", [
        await f.deletionToken(ahead),
        randomUUID(),
      ]);
      expect((await ranking(behind)).me?.rank).toBe(before - 1);
      expect(await h.boardsOf(ahead)).toHaveLength(2);
      await expect(ranking(ahead)).rejects.toMatchObject({ code: "PI401" });
    });
  });

  describe("the doors", () => {
    it("refuses a staff session or no session (PI401), any other scope (22023), and answers QW404 while off", async () => {
      const player = await f.newPlayer();
      for (const context of [f.team(), {}] as RequestContext[]) {
        await expect(f.run(context, "SELECT questify_ranking('lifetime')")).rejects.toMatchObject({
          code: "PI401",
        });
      }
      await expect(ranking(player, "season")).rejects.toMatchObject({ code: "22023" });
      await f.switchFeature("questifyRanking", false);
      try {
        await expect(ranking(player)).rejects.toMatchObject({ code: "QW404" });
      } finally {
        await f.switchFeature("questifyRanking", true);
      }
      expect((await ranking(player)).board).toBe("all");
    });

    it("lets only an admin read the seasons and a season's top 10", async () => {
      const player = await f.newPlayer();
      for (const context of [{ playerId: player }, {}] as RequestContext[]) {
        for (const sql of ["SELECT questify_seasons()", "SELECT questify_season_top('1999-05')"]) {
          await expect(f.run(context, sql)).rejects.toMatchObject({ code: "QY403" });
        }
      }
      const seasons = await f.door<Season[]>("SELECT questify_seasons() AS r");
      const [now] = await f.owner<{ m: string }>("SELECT questify_month(now()) AS m");
      expect(seasons.find((one) => one.month === now?.m)).toMatchObject({ current: true });
      // Every month from the earliest board to now, newest first; a month nobody played counts 0.
      expect(seasons.at(-1)?.month).toBe("1999-04");
      expect(seasons.find((one) => one.month === "1999-06")).toEqual({
        month: "1999-06",
        players: 0,
        current: false,
      });
      const months = seasons.map((one) => one.month);
      expect(months).toEqual([...months].toSorted().toReversed());
      expect(new Set(months).size).toBe(months.length);
      expect(seasons.find((one) => one.month === "1999-05")).toMatchObject({
        current: false,
        players: Number((await h.reference("1999-05")).length),
      });
      const top = await f.door<Season>("SELECT questify_season_top('1999-05') AS r");
      expect(top.rows).toHaveLength(10);
      expect(Object.keys(top.rows[0] ?? {}).toSorted()).toEqual(ME_KEYS);
      expect(await f.door<Season>("SELECT questify_season_top('1998-01') AS r")).toEqual({
        month: "1998-01",
        players: 0,
        rows: [],
      });
      await expect(f.door("SELECT questify_season_top('1999-13') AS r")).rejects.toMatchObject({
        code: "22023",
      });
    });
  });

  describe("every writer keeps the boards equal to the ledger", () => {
    it("an event scan, a team award, a removal, a Questify award and a daily finish", async () => {
      // The daily fixture moves its clock, which moves every Questify month: write everything after the move.
      const { picked, challenge } = await f.challengeToday();
      const player = await f.newPlayer();
      await scan(player, await liveQuest(player));
      const event = await f.newEvent({ phase: "live" });
      const enrollment = await f.join(event, player);
      await f.run(f.team(), "SELECT * FROM staff_award($1, $2, $3, NULL, 'Helped', $4, $5)", [
        event,
        enrollment,
        await codeQuest(event),
        randomUUID(),
        randomUUID(),
      ]);
      const credit = await f.earn(event, enrollment);
      await f.removeEntry(event, credit);
      await f.asPlayer(player, "SELECT set_preferences(NULL, ARRAY['music']) AS r");
      await f.sync(player);
      for (let pos = 1; pos <= 3; pos += 1) {
        await f.answer(player, challenge.id, picked[pos - 1] ?? "", pos, 2);
      }
      const sources = await f.owner<{ source: string }>(
        "SELECT DISTINCT source FROM xp_entry WHERE player_id = $1 ORDER BY 1",
        [player],
      );
      expect(sources.map((row) => row.source)).toEqual(["daily", "quest", "questify", "removal"]);
      expect(await h.mismatches(player)).toEqual([]);
      expect((await highestIds(player))[0]?.ok).toBe(true);
    });

    it("writes nothing for a rehearsal credit", async () => {
      const player = await f.newPlayer();
      const event = await f.newEvent({ phase: "live" });
      await f.earn(event, await f.join(event, player, "rehearsal"));
      expect(await h.boardsOf(player)).toEqual([]);
    });

    it("has xp_apply as the only writer of xp_board, called by every writer of xp_entry", async () => {
      const { writers } = h;
      expect(await writers("(insert\\s+into|update)\\s+xp_board\\M")).toEqual([]);
      const payers = await writers("insert\\s+into\\s+xp_entry\\M");
      expect(payers.length).toBeGreaterThan(3);
      expect(payers.filter((row) => !row.applies)).toEqual([]);
    });
  });

  describe("races (no deadlock, boards equal the ledger after)", () => {
    it("two scans in two events for one player", async () => {
      const player = await f.newPlayer();
      const outcome = await f.crossed(
        scanStatement(player, await liveQuest(player)),
        scanStatement(player, await liveQuest(player)),
      );
      expect(outcome.waited).toBe(true);
      expect(outcome.second).not.toBeInstanceOf(Error);
      expect(await h.mismatches(player)).toEqual([]);
      expect((await highestIds(player))[0]?.ok).toBe(true);
    });

    it.each(["scan-first", "sync-first"])("a sync crossing a scan: %s", async (order) => {
      const player = await f.newPlayer();
      await f.asPlayer(player, "SELECT set_preferences(NULL, ARRAY['music']) AS r");
      const sync = { context: { playerId: player }, sql: "SELECT questify_sync() AS r" };
      const scanning = scanStatement(player, await liveQuest(player));
      const outcome =
        order === "scan-first" ? await f.crossed(scanning, sync) : await f.crossed(sync, scanning);
      expect(outcome.waited).toBe(true);
      expect(outcome.second).not.toBeInstanceOf(Error);
      expect(await h.mismatches(player)).toEqual([]);
      expect((await highestIds(player))[0]?.ok).toBe(true);
    });

    it.each(["erase-first", "scan-first"])("erasure crossing a credit: %s", async (order) => {
      const player = await f.newPlayer();
      await scan(player, await liveQuest(player));
      const erase = {
        context: { playerId: player } as RequestContext,
        sql: "SELECT * FROM erase_player($1, true, $2)",
        values: [await f.deletionToken(player), randomUUID()],
      };
      const scanning = scanStatement(player, await liveQuest(player));
      const outcome =
        order === "erase-first"
          ? await f.crossed(erase, scanning)
          : await f.crossed(scanning, erase);
      expect(outcome.waited).toBe(true);
      expect(await h.mismatches(player)).toEqual([]);
    });

    it("a daily finish crossing a scan", async () => {
      const player = await f.newPlayer();
      const quest = await liveQuest(player);
      const { picked, challenge } = await f.challengeToday();
      for (let pos = 1; pos <= 2; pos += 1) {
        await f.answer(player, challenge.id, picked[pos - 1] ?? "", pos, 2);
      }
      const finish = {
        context: { playerId: player } as RequestContext,
        sql: "SELECT daily_answer_submit($1, $2, $3, $4) AS r",
        values: [challenge.id, picked[2], 3, 2],
      };
      const outcome = await f.crossed(finish, scanStatement(player, quest));
      expect(outcome.waited).toBe(true);
      expect(outcome.second).not.toBeInstanceOf(Error);
      expect(await h.mismatches(player)).toEqual([]);
      expect((await highestIds(player))[0]?.ok).toBe(true);
    });
  });
});

/**
 * Months (ADR-323, plan review MAJOR-1), in a database of their own because one test replaces questify_month: the edge
 * at 04:00 Riyadh time on the 1st, and a removal counting in the month of the credit it reverses, so a past board
 * changes only when one of its own credits is removed.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("Questify ranking months (database)", () => {
  let f: QuestifyFixture;
  let h: ReturnType<typeof helpers>;
  beforeAll(async () => {
    f = await questifyFixture();
    h = helpers(f);
  });
  afterAll(async () => {
    await f.close();
  });

  it("changes month at 04:00 Riyadh time on the 1st, the Questify day's edge", async () => {
    const [row] = await f.owner<{ before: string; at: string; night: string }>(
      `SELECT questify_month('2026-11-01T00:59:59Z') AS before, questify_month('2026-11-01T01:00:00Z') AS at,
              questify_month('2026-10-31T22:00:00Z') AS night`,
    );
    expect(row).toEqual({ before: "2026-10", at: "2026-11", night: "2026-10" });
  });

  it("takes a removal off the credit's month; the season changes only by its own credits", async () => {
    await f.owner("CREATE TABLE test_edge (edge timestamptz NOT NULL)");
    await f.owner("INSERT INTO test_edge VALUES ('infinity')");
    await f.owner("GRANT SELECT ON test_edge TO PUBLIC");
    await f.owner(
      `CREATE OR REPLACE FUNCTION questify_month(at timestamptz) RETURNS text
         LANGUAGE sql STABLE SET search_path = public, pg_temp
         RETURN CASE WHEN at < (SELECT t.edge FROM test_edge t) THEN '2000-01'
                     ELSE to_char(questify_day(at), 'YYYY-MM') END`,
    );
    const [staff] = await f.owner<{ id: string }>(
      "INSERT INTO staff_user (email, password_hash, platform_role) VALUES ('months@questify.test', 'h', 'admin') RETURNING id",
    );
    const admin: RequestContext = { isAdmin: true, staffUserId: staff?.id ?? "" };
    // The archive's places and XP; a row's level is the player's lifetime level today, so it may move.
    const season = async () => {
      const top = (
        await f.run<{ r: Season }>(admin, "SELECT questify_season_top('2000-01') AS r")
      )[0]?.r;
      return {
        players: top?.players,
        rows: top?.rows.map((row) => [row.rank, row.username, row.xp]),
      };
    };

    const player = await f.newPlayer();
    const event = await f.newEvent({ phase: "live" });
    const enrollment = await f.join(event, player);
    const old = await f.earn(event, enrollment);
    await f.owner("UPDATE test_edge SET edge = clock_timestamp()");
    const archived = await season();
    expect(archived).toEqual({ players: 1, rows: [[1, await f.usernameOf(player), 100]] });

    await f.earn(event, enrollment);
    const [now] = await f.owner<{ m: string }>("SELECT questify_month(now()) AS m");
    expect(await season()).toEqual(archived);

    await f.removeEntry(event, old);
    const boards = await h.boardsOf(player);
    expect(boards.map((row) => [row.board, Number(row.xp)])).toEqual([
      ["2000-01", 0],
      [now?.m ?? "", 100],
      ["all", 100],
    ]);
    expect(await season()).toEqual({ players: 0, rows: [] });
    expect(await h.mismatches(player)).toEqual([]);
  });
});
