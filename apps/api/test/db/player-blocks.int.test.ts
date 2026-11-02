import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pushFixture, sqlstate, type PushFixture } from "#test/support/push";
import { TEST_DATABASE_URL } from "#test/support/test-db";

type TopRow = { enrollment_id: string; username: string | null; avatar: string | null };

/**
 * Blocking a player (T-705, FR-1415, migration 0120): the player's own doors, the cap, and the reads a block masks. A
 * blocked player keeps their place and points without a name in the blocker's boards; their profile is not found; the
 * blocked player's own reads never change.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("blocking a player (database)", () => {
  let f: PushFixture;
  beforeAll(async () => {
    f = await pushFixture();
  });
  afterAll(async () => {
    await f.close();
  });

  const block = (me: string, name: string) =>
    f.one<string>({ playerId: me }, "SELECT block_player($1) AS r", [name]);
  const unblock = (me: string, name: string) =>
    f.one<string>({ playerId: me }, "SELECT unblock_player($1) AS r", [name]);
  const blocks = (me: string) =>
    f.one<{ username: string; avatar: string }[]>({ playerId: me }, "SELECT own_blocks() AS r");
  const top = (me: string, event: string, today = false) =>
    f.asPlayer<TopRow>(
      me,
      `SELECT enrollment_id, username, avatar FROM ${today ? "ranking_day_top" : "ranking_top"}($1, 10)`,
      [event],
    );
  /** An event with three ranked players: the reader, a player to block and a third. */
  const board = async () => {
    const event = await f.newEvent({ phase: "live" });
    const [reader, other, third] = [await f.newPlayer(), await f.newPlayer(), await f.newPlayer()];
    const enrollments: string[] = [];
    for (const [who, points] of [
      [reader, 10],
      [other, 30],
      [third, 20],
    ] as const) {
      const enrollment = await f.join(event, who);
      enrollments.push(enrollment);
      await f.earn(event, enrollment, { points, at: new Date() });
    }
    return { event, reader, other, third, enrollments, otherName: await f.usernameOf(other) };
  };

  const rows = async (me: string) =>
    (
      await f.one<{ rows: { username: string | null; hidden?: boolean }[] }>(
        { playerId: me },
        "SELECT questify_ranking('lifetime') AS r",
      )
    ).rows;

  describe("the doors", () => {
    it("blocks and unblocks by username, idempotently, and lists the blocks", async () => {
      const me = await f.newPlayer();
      const other = await f.newPlayer();
      const name = await f.usernameOf(other);
      expect(await block(me, name.toUpperCase())).toBe("blocked");
      expect(await block(me, name)).toBe("blocked");
      expect(await blocks(me)).toEqual([expect.objectContaining({ username: name })]);
      expect(await blocks(other)).toEqual([]);
      expect(await unblock(me, name)).toBe("unblocked");
      expect(await unblock(me, name)).toBe("unblocked");
      expect(await blocks(me)).toEqual([]);
    });

    it("answers not_found for an unknown name, an erased account and the caller", async () => {
      const me = await f.newPlayer();
      const gone = await f.newPlayer();
      const goneName = await f.usernameOf(gone);
      await f.erase(gone);
      for (const name of ["nobody_here_at_all", goneName, await f.usernameOf(me)]) {
        expect(await block(me, name)).toBe("not_found");
        expect(await unblock(me, name)).toBe("not_found");
      }
      expect(await f.count("player_block WHERE blocker_id = $1", [me])).toBe(0);
    });

    it("refuses a caller with no player", async () => {
      for (const sql of [
        "SELECT block_player('anyone')",
        "SELECT unblock_player('anyone')",
        "SELECT own_blocks()",
      ]) {
        expect(await sqlstate(f.run({}, sql))).toBe("42501");
        expect(await sqlstate(f.run({ isAdmin: true }, sql))).toBe("42501");
      }
    });

    it("holds the cap of 500 under concurrent blocks", async () => {
      const me = await f.newPlayer();
      await f.owner(
        `INSERT INTO player (username) SELECT 'cap_filler_' || g FROM generate_series(1, 499) g`,
      );
      await f.owner(
        `INSERT INTO player_block (blocker_id, blocked_id)
         SELECT $1, p.id FROM player p WHERE p.username LIKE 'cap\\_filler\\_%'`,
        [me],
      );
      const [x, y] = [await f.newPlayer(), await f.newPlayer()];
      const answers = await Promise.all([
        block(me, await f.usernameOf(x)),
        block(me, await f.usernameOf(y)),
      ]);
      expect(answers.toSorted()).toEqual(["blocked", "limit"]);
      expect(await f.count("player_block WHERE blocker_id = $1", [me])).toBe(500);
    });
  });

  describe("what a block masks", () => {
    it("keeps a blocked player's place without a name in the ranking, today's and the rows", async () => {
      const { event, reader, other, third, enrollments, otherName } = await board();
      const before = await top(other, event);
      expect((await top(reader, event)).map((row) => row.username)).toEqual([
        otherName,
        await f.usernameOf(third),
        await f.usernameOf(reader),
      ]);
      await block(reader, otherName);
      const masked = await top(reader, event);
      expect(masked[0]).toEqual({ enrollment_id: enrollments[1], username: null, avatar: null });
      expect(masked).toHaveLength(3);
      expect((await top(reader, event, true))[0]).toMatchObject({ username: null, avatar: null });
      expect(
        await f.asPlayer(
          reader,
          "SELECT enrollment_id, username, ranked FROM ranking_rows($1, $2)",
          [event, [enrollments[1]]],
        ),
      ).toEqual([{ enrollment_id: enrollments[1], username: null, ranked: true }]);
      expect(await top(other, event)).toEqual(before);
      expect((await top(third, event))[0]?.username).toBe(otherName);
    });

    it("hides a blocked player's profile, and only from the blocker", async () => {
      const { reader, other, third, otherName } = await board();
      const profile = (me: string) =>
        f.one<{ username: string } | null>(
          me === "" ? {} : { playerId: me },
          "SELECT public_player_profile($1) AS r",
          [otherName],
        );
      expect((await profile(reader))?.username).toBe(otherName);
      await block(reader, otherName);
      expect(await profile(reader)).toBeNull();
      expect((await profile(third))?.username).toBe(otherName);
      expect(
        await f.one<{ username: string } | null>(
          { playerId: other },
          "SELECT public_player_profile($1) AS r",
          [await f.usernameOf(reader)],
        ),
      ).not.toBeNull();
    });

    it("masks a blocked player's place in the revealed results", async () => {
      const { event, reader, otherName } = await board();
      await f.owner(
        "UPDATE event SET status = 'ended', ends_at = now() - interval '1 hour' WHERE id = $1",
        [event],
      );
      expect(await f.confirm(event)).toBe("confirmed");
      expect(await f.reveal(event)).toBe("revealed");
      await block(reader, otherName);
      const places = await f.asPlayer<{ rank: number; username: string | null; hidden: boolean }>(
        reader,
        "SELECT rank, username, hidden FROM event_results($1)",
        [event],
      );
      expect(places.map((row) => [row.rank, row.username === null, row.hidden])).toEqual([
        [1, true, true],
        [2, false, false],
        [3, false, false],
      ]);
    });

    it("masks a blocked player's row in the Questify-wide ranking", async () => {
      const { event, reader, other, enrollments, otherName } = await board();
      for (let quest = 0; quest < 30; quest += 1) {
        await f.earn(event, enrollments[1] ?? "", { at: new Date() });
      }
      expect((await rows(reader)).some((row) => row.username === otherName)).toBe(true);
      await block(reader, otherName);
      const masked = await rows(reader);
      expect(masked.some((row) => row.username === otherName)).toBe(false);
      expect(masked.filter((row) => row.hidden === true)).toHaveLength(1);
      expect((await rows(other)).some((row) => row.hidden === true)).toBe(false);
    });

    it("is erased with either account", async () => {
      const [a, b, c] = [await f.newPlayer(), await f.newPlayer(), await f.newPlayer()];
      await block(a, await f.usernameOf(b));
      await block(b, await f.usernameOf(c));
      await f.erase(b);
      expect(await f.count("player_block WHERE blocker_id = $1 OR blocked_id = $1", [b])).toBe(0);
    });
  });
});
