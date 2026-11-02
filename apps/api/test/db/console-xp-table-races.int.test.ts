import { randomUUID } from "node:crypto";
import type { Client, PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "#src/db/context";
import { questifyFixture, type QuestifyFixture } from "#test/support/questify";
import { connectAsOwner, TEST_DATABASE_URL } from "#test/support/test-db";

type Level = { level: number; xpFrom: number; itemId: string | null };
type Doc = { levels: Level[] };
type Outcome = Readonly<{ code: string | null; detail?: string; ms: number }>;

/** One connection with a transaction held open: as the owner (a scan) or as the API (a door, a sync). */
type Session = Readonly<{
  client: Client | PoolClient;
  pid: number;
  /** Starts a statement without waiting for it: its code (null when it succeeded) and how long it took. */
  start: (sql: string, values?: unknown[]) => Promise<Outcome>;
  commit: () => Promise<void>;
  end: () => Promise<void>;
}>;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const swap = (doc: Doc, level: number, change: Partial<Level>): Doc => ({
  levels: doc.levels.map((row) => (row.level === level ? { ...row, ...change } : row)),
});

/**
 * T-709d's lock races (migration 0124, plan "Races"): a scan, a sync and a second save against the XP table door, both
 * orders, each session with the API's 2 s lock timeout; the door's one 1 s budget for all its lock waits (plan review
 * MAJOR); a sync that catches up and earns XP crossed with a save never deadlocks (plan review MINOR); erasure and sign-up
 * never wait for a save. Each race appends fresh levels above everyone's XP, so the races never share a level.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("console XP table races (database)", () => {
  let f: QuestifyFixture;
  let admin: RequestContext = {};
  let event = "";
  let items = 0;
  const open: Session[] = [];

  const one = async <T>(sql: string, values: unknown[] = []): Promise<T> =>
    (await f.run<{ r: T }>(admin, sql, values))[0]?.r as T;
  const current = async (): Promise<Doc> => ({
    levels: (
      await one<{ levels: (Level & { reached: boolean })[] }>("SELECT admin_xp_table() AS r")
    ).levels.map(({ level, xpFrom, itemId }) => ({ level, xpFrom, itemId })),
  });
  const save = (doc: Doc, confirmed = false) =>
    one("SELECT admin_xp_table_save($1, NULL, $2, gen_random_uuid()) AS r", [doc, confirmed]);
  const saveSql = "SELECT admin_xp_table_save($1, NULL, $2, gen_random_uuid())";
  const freeItem = async () => {
    items += 1;
    const id = `race-${items}`;
    await one("SELECT admin_item_create($1, gen_random_uuid()) AS r", [
      { id, kind: "title", name: { ar: "جائزة", en: "Prize" }, visualKey: null },
    ]);
    return id;
  };
  const topXp = async () =>
    Number(
      (
        await f.owner<{ xp: string }>(
          "SELECT coalesce(max(xp), 0) AS xp FROM xp_board WHERE board = 'all'",
        )
      )[0]?.xp,
    );
  /** Appends levels above everyone's XP, `gaps` apart from the last; answers their numbers and starts. */
  const appendLevels = async (gaps: number[]) => {
    const doc = await current();
    let start = Math.max(await topXp(), doc.levels.at(-1)?.xpFrom ?? 0) + 1000;
    const added: Level[] = [];
    for (const gap of gaps) {
      start += gap;
      added.push({
        level: doc.levels.length + added.length + 1,
        xpFrom: start,
        itemId: await freeItem(),
      });
    }
    await save({ levels: [...doc.levels, ...added] });
    return added;
  };
  const setQuestXp = (amount: number) =>
    f.owner(
      "UPDATE platform_setting SET value = value || jsonb_build_object('questXp', $1::int) WHERE key = 'xp'",
      [amount],
    );
  const xpOf = async (player: string) =>
    Number(
      (await f.owner<{ xp: string }>("SELECT xp FROM player_xp WHERE player_id = $1", [player]))[0]
        ?.xp,
    );
  /**
   * A player at exactly `total` XP, through quest credits of at most 99,999 each, in an event of their own (two scans in
   * one event queue on the event's rows, which would hide the level locks under test).
   */
  const playerAt = async (total: number) => {
    const id = await f.newPlayer();
    const own = await f.newEvent({ phase: "live" });
    const enrollment = await f.join(own, id);
    while ((await xpOf(id)) < total) {
      await setQuestXp(Math.min(99_999, total - (await xpOf(id))));
      await f.earn(own, enrollment);
    }
    await setQuestXp(1);
    return { id, enrollment, event: own };
  };
  const reached = async (player: string) =>
    (
      await f.owner<{ level: number }>(
        "SELECT level FROM level_reached WHERE player_id = $1 ORDER BY level",
        [player],
      )
    ).map((row) => row.level);
  const owns = async (player: string, item: string) =>
    (
      await f.owner("SELECT 1 FROM player_item WHERE player_id = $1 AND item_id = $2", [
        player,
        item,
      ])
    ).length === 1;

  const session = async (seat: "owner" | RequestContext): Promise<Session> => {
    const client = seat === "owner" ? await connectAsOwner(f.db) : await f.pool.connect();
    await client.query("SET lock_timeout = '2s'");
    await client.query("BEGIN");
    if (seat !== "owner") {
      for (const [key, value] of [
        ["app.player_id", seat.playerId ?? ""],
        ["app.staff_user_id", seat.staffUserId ?? ""],
        ["app.is_admin", seat.isAdmin === true ? "on" : ""],
        ["app.organizer_id", ""],
        ["app.device_id", ""],
      ]) {
        await client.query("SELECT set_config($1, $2, true)", [key, value]);
      }
    }
    const pid =
      (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid ?? 0;
    let ended = false;
    const made: Session = {
      client,
      pid,
      start: (sql, values = []) => {
        const began = performance.now();
        return client.query(sql, values).then(
          () => ({ code: null, ms: performance.now() - began }),
          (error: { code?: string; detail?: string }) => ({
            code: error.code ?? "unknown",
            ...(error.detail === undefined ? {} : { detail: error.detail }),
            ms: performance.now() - began,
          }),
        );
      },
      commit: async () => {
        await client.query("COMMIT");
      },
      end: async () => {
        if (ended) return;
        ended = true;
        await client.query("ROLLBACK").catch(() => undefined);
        await client.query("RESET lock_timeout").catch(() => undefined);
        if (seat === "owner") await (client as Client).end();
        else (client as PoolClient).release();
      },
    };
    open.push(made);
    return made;
  };
  /** Waits until the session's backend waits for a lock. */
  const blocked = async (who: Session) => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const rows = await f.owner(
        "SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'",
        [who.pid],
      );
      if (rows.length === 1) return;
      await pause(10);
    }
    throw new Error(`session ${who.pid} never waited for a lock`);
  };
  /** The statements of one quest credit (as the fixture's earn), on a held owner session. */
  const scan = async (
    who: Session,
    runner: Readonly<{ enrollment: string; event: string }>,
  ): Promise<Outcome> => {
    const { enrollment, event: own } = runner;
    const quest = await who.client.query<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, visible, type_config)
       SELECT $1, id, 'scan_qr', 'Quest', 10, 100, true, '{}' FROM category WHERE event_id = $1 LIMIT 1 RETURNING id`,
      [own],
    );
    const done = await who.client.query<{ id: string }>(
      `INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method, idempotency_key)
       VALUES ($1, $2, $3, $4, 1, 'qr', $5) RETURNING id`,
      [f.ids.orgA, own, enrollment, quest.rows[0]?.id, randomUUID()],
    );
    return who.start(
      `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, completion_id,
                                 quest_id, actor)
       VALUES ($1, $2, $3, 'quest', 10, 10, $4, $5, 'player')`,
      [f.ids.orgA, own, enrollment, done.rows[0]?.id, quest.rows[0]?.id],
    );
  };

  const retire = (quest: string) =>
    f.owner("UPDATE questify_quest SET status = 'retired' WHERE id = $1", [quest]);
  /** A runner one below a new top level, which a confirmed save then lowers to the runner's XP. */
  const due = async () => {
    const [top] = await appendLevels([500]);
    const runner = await playerAt((top?.xpFrom ?? 0) - 1);
    await save(swap(await current(), top?.level ?? 0, { xpFrom: (top?.xpFrom ?? 0) - 1 }), true);
    return { top: { ...(top as Level), xpFrom: (top?.xpFrom ?? 0) - 1 }, runner };
  };

  /**
   * A runner with a lowered level due (`caught`) and a Questify quest paying 300 XP that reaches `crossed`, which another
   * player's scan holds. The quest is retired after each race.
   */
  const setup = async () => {
    const [caught, crossed] = await appendLevels([0, 200]);
    const runner = await playerAt((caught?.xpFrom ?? 0) - 100);
    await save(
      swap(await current(), caught?.level ?? 0, { xpFrom: (caught?.xpFrom ?? 0) - 100 }),
      true,
    );
    const holder = await playerAt((crossed?.xpFrom ?? 0) - 1);
    const [quest] = await f.owner<{ id: string }>(
      `INSERT INTO questify_quest (metric, target, title_ar, title_en, xp, position, status)
       VALUES ('quests', 1, 'مهمة', 'Quest', 300, 900, 'active') RETURNING id`,
    );
    return {
      caught: caught as Level,
      crossed: crossed as Level,
      runner,
      holder,
      quest: quest?.id ?? "",
    };
  };
  beforeAll(async () => {
    f = await questifyFixture();
    const [row] = await f.owner<{ id: string }>(
      "INSERT INTO staff_user (email, password_hash, platform_role, status) VALUES ('race@questify.test', 'h', 'admin', 'active') RETURNING id",
    );
    admin = { isAdmin: true, staffUserId: row?.id ?? "" };
    event = await f.newEvent({ phase: "live" });
    const doc = await current();
    await save({ levels: doc.levels.slice(0, 7) });
  });
  afterEach(async () => {
    for (const each of open.splice(0)) await each.end();
  });
  afterAll(async () => {
    await f.close();
  });

  describe("a scan reaching the top level while the door removes it", () => {
    it("reach first: the door waits, then refuses (level_held)", async () => {
      const [top] = await appendLevels([0]);
      const runner = await playerAt((top?.xpFrom ?? 0) - 1);
      const reach = await session("owner");
      expect((await scan(reach, runner)).code).toBeNull();
      const door = await session(admin);
      const before = await current();
      const saving = door.start(saveSql, [{ levels: before.levels.slice(0, -1) }, false]);
      await blocked(door);
      await reach.commit();
      expect(await saving).toMatchObject({
        code: "CA409",
        detail: `{"level": ${top?.level}, "reason": "level_held"}`,
      });
      await door.end();
      await reach.end();
      expect(await reached(runner.id)).toContain(top?.level);
    });

    it("door first: the scan waits, then commits without the level and without an error", async () => {
      const [top] = await appendLevels([0]);
      const runner = await playerAt((top?.xpFrom ?? 0) - 1);
      const door = await session(admin);
      const before = await current();
      expect(
        (await door.start(saveSql, [{ levels: before.levels.slice(0, -1) }, false])).code,
      ).toBeNull();
      const reach = await session("owner");
      const scanning = scan(reach, runner);
      await blocked(reach);
      await door.commit();
      expect((await scanning).code).toBeNull();
      await reach.commit();
      await door.end();
      await reach.end();
      expect(await reached(runner.id)).not.toContain(top?.level);
      const [mine] = await f.asPlayer<{ level: number }>(
        runner.id,
        "SELECT level FROM own_level(NULL)",
      );
      expect(mine?.level).toBe((top?.level ?? 0) - 1);
    });
  });

  describe("a scan reaching a level while the door changes its reward", () => {
    it("reach first: the door refuses (reward_given) and the player keeps the old item", async () => {
      const [top] = await appendLevels([0]);
      const other = await freeItem();
      const runner = await playerAt((top?.xpFrom ?? 0) - 1);
      const reach = await session("owner");
      expect((await scan(reach, runner)).code).toBeNull();
      const door = await session(admin);
      const saving = door.start(saveSql, [
        swap(await current(), top?.level ?? 0, { itemId: other }),
        false,
      ]);
      await blocked(door);
      await reach.commit();
      expect(await saving).toMatchObject({
        code: "CA409",
        detail: `{"level": ${top?.level}, "reason": "reward_given"}`,
      });
      await door.end();
      await reach.end();
      expect(await owns(runner.id, top?.itemId ?? "")).toBe(true);
    });

    it("door first: the scan waits and the player gets the new item", async () => {
      const [top] = await appendLevels([0]);
      const other = await freeItem();
      const runner = await playerAt((top?.xpFrom ?? 0) - 1);
      const door = await session(admin);
      expect(
        (
          await door.start(saveSql, [
            swap(await current(), top?.level ?? 0, { itemId: other }),
            false,
          ])
        ).code,
      ).toBeNull();
      const reach = await session("owner");
      const scanning = scan(reach, runner);
      await blocked(reach);
      await door.commit();
      expect((await scanning).code).toBeNull();
      await reach.commit();
      await door.end();
      await reach.end();
      expect(await owns(runner.id, other)).toBe(true);
      expect(await owns(runner.id, top?.itemId ?? "")).toBe(false);
    });
  });

  describe("a sync's catch-up against the door", () => {
    it("sync first: the door waits, then refuses to change the reward the sync gave", async () => {
      const { top, runner } = await due();
      const other = await freeItem();
      const syncing = await session({ playerId: runner.id });
      expect((await syncing.start("SELECT questify_sync()")).code).toBeNull();
      const door = await session(admin);
      const saving = door.start(saveSql, [
        swap(await current(), top.level, { itemId: other }),
        false,
      ]);
      await blocked(door);
      await syncing.commit();
      expect(await saving).toMatchObject({
        code: "CA409",
        detail: `{"level": ${top.level}, "reason": "reward_given"}`,
      });
      await door.end();
      await syncing.end();
      expect(await owns(runner.id, top.itemId ?? "")).toBe(true);
    });

    it("door first: the sync waits and catches up with the new item", async () => {
      const { top, runner } = await due();
      const other = await freeItem();
      const door = await session(admin);
      expect(
        (await door.start(saveSql, [swap(await current(), top.level, { itemId: other }), false]))
          .code,
      ).toBeNull();
      const syncing = await session({ playerId: runner.id });
      const answer = syncing.start("SELECT questify_sync()");
      await blocked(syncing);
      await door.commit();
      expect((await answer).code).toBeNull();
      await syncing.commit();
      await door.end();
      await syncing.end();
      expect(await owns(runner.id, other)).toBe(true);
    });
  });

  describe("the door's one lock budget (plan review MAJOR)", () => {
    it("gives up within about 1 s in all when two reaches hold it in turn, so a scan queued behind it stays under 2 s", async () => {
      const [low, middle, high] = await appendLevels([0, 1000, 1000]);
      const first = await playerAt((middle?.xpFrom ?? 0) - 1);
      const second = await playerAt((high?.xpFrom ?? 0) - 1);
      const queued = await playerAt((low?.xpFrom ?? 0) - 1);
      const holdMiddle = await session("owner");
      const holdHigh = await session("owner");
      expect((await scan(holdMiddle, first)).code).toBeNull();
      expect((await scan(holdHigh, second)).code).toBeNull();
      const door = await session(admin);
      const saving = door.start(saveSql, [swap(await current(), 2, { xpFrom: 201 }), false]);
      await blocked(door);
      const behind = await session("owner");
      const scanning = scan(behind, queued);
      await blocked(behind);
      await pause(700);
      await holdMiddle.commit();
      const saved = await saving;
      const queuedScan = await scanning;
      await holdHigh.commit();
      await behind.commit();
      for (const each of [door, holdMiddle, holdHigh, behind]) await each.end();
      expect(["CA503", "55P03"]).toContain(saved.code);
      expect(saved.ms).toBeLessThan(1400);
      expect(queuedScan.code).toBeNull();
      expect(queuedScan.ms).toBeLessThan(1500);
      expect(await reached(queued.id)).toContain(low?.level);
    });
  });

  describe("a sync that catches up and earns XP, crossed with a save (plan review MINOR)", () => {
    it("door first, held behind another reach: the sync waits at its catch-up and nobody deadlocks", async () => {
      const { caught, crossed, runner, holder, quest } = await setup();
      const hold = await session("owner");
      expect((await scan(hold, holder)).code).toBeNull();
      const door = await session(admin);
      const saving = door.start(saveSql, [swap(await current(), 2, { xpFrom: 201 }), false]);
      await blocked(door);
      const syncing = await session({ playerId: runner.id });
      const answer = syncing.start("SELECT questify_sync()");
      await blocked(syncing);
      await pause(200);
      await hold.commit();
      expect((await saving).code).toBeNull();
      await door.commit();
      expect((await answer).code).toBeNull();
      await syncing.commit();
      for (const each of [hold, door, syncing]) await each.end();
      await retire(quest);
      expect(await reached(runner.id)).toEqual(
        expect.arrayContaining([caught.level, crossed.level]),
      );
      await save(swap(await current(), 2, { xpFrom: 200 }), true);
    });

    it("sync first: the door waits for the sync and then saves", async () => {
      const { caught, crossed, runner, quest } = await setup();
      const syncing = await session({ playerId: runner.id });
      expect((await syncing.start("SELECT questify_sync()")).code).toBeNull();
      const door = await session(admin);
      const saving = door.start(saveSql, [swap(await current(), 2, { xpFrom: 201 }), false]);
      await blocked(door);
      await syncing.commit();
      expect((await saving).code).toBeNull();
      await door.commit();
      for (const each of [syncing, door]) await each.end();
      await retire(quest);
      expect(await reached(runner.id)).toEqual(
        expect.arrayContaining([caught.level, crossed.level]),
      );
      await save(swap(await current(), 2, { xpFrom: 200 }), true);
    });
  });

  describe("two saves, and the other writers", () => {
    it("queues a second save on level 1; it sees the level the first one added", async () => {
      const doc = await current();
      const added: Level = {
        level: doc.levels.length + 1,
        xpFrom: (await topXp()) + 50_000,
        itemId: await freeItem(),
      };
      const first = await session(admin);
      expect(
        (await first.start(saveSql, [{ levels: [...doc.levels, added] }, false])).code,
      ).toBeNull();
      const second = await session(admin);
      const moved = { ...added, xpFrom: added.xpFrom + 7 };
      const saving = second.start(saveSql, [{ levels: [...doc.levels, moved] }, false]);
      await blocked(second);
      await first.commit();
      expect((await saving).code).toBeNull();
      await second.commit();
      for (const each of [first, second]) await each.end();
      expect((await current()).levels.at(-1)).toEqual(moved);
    });

    it("serializes the door with an art change and a souvenir rule on the item it maps", async () => {
      const [top] = await appendLevels([0]);
      items += 1;
      const frame = `race-frame-${items}`;
      await one("SELECT admin_item_create($1, gen_random_uuid()) AS r", [
        { id: frame, kind: "frame", name: { ar: "إطار", en: "Frame" }, visualKey: "frame-03" },
      ]);
      const door = await session(admin);
      expect(
        (
          await door.start(saveSql, [
            swap(await current(), top?.level ?? 0, { itemId: frame }),
            false,
          ])
        ).code,
      ).toBeNull();
      const art = await session(admin);
      const painting = art.start("SELECT admin_item_save($1, $2, NULL, gen_random_uuid())", [
        frame,
        { name: { ar: "إطار", en: "Frame" }, visualKey: "frame-04" },
      ]);
      await blocked(art);
      const souvenir = await session("owner");
      const ruling = souvenir.start(
        "INSERT INTO souvenir_rule (organizer_id, event_id, item_id, audience) VALUES ($1, $2, $3, 'all')",
        [f.ids.orgA, event, frame],
      );
      await blocked(souvenir);
      await door.commit();
      expect((await painting).code).toBeNull();
      await art.commit();
      expect((await ruling).code).toBe("23514");
      for (const each of [door, art, souvenir]) await each.end();
      expect(await f.owner("SELECT visual_key FROM item WHERE id = $1", [frame])).toEqual([
        { visual_key: "frame-04" },
      ]);
    });

    it("an art change first: the door waits for the item, then maps it", async () => {
      const [top] = await appendLevels([0]);
      items += 1;
      const frame = `race-frame-${items}`;
      await one("SELECT admin_item_create($1, gen_random_uuid()) AS r", [
        { id: frame, kind: "frame", name: { ar: "إطار", en: "Frame" }, visualKey: "frame-03" },
      ]);
      const art = await session(admin);
      expect(
        (
          await art.start("SELECT admin_item_save($1, $2, NULL, gen_random_uuid())", [
            frame,
            { name: { ar: "إطار", en: "Frame" }, visualKey: "frame-05" },
          ])
        ).code,
      ).toBeNull();
      const door = await session(admin);
      const saving = door.start(saveSql, [
        swap(await current(), top?.level ?? 0, { itemId: frame }),
        false,
      ]);
      await blocked(door);
      await art.commit();
      expect((await saving).code).toBeNull();
      await door.commit();
      for (const each of [art, door]) await each.end();
      expect(await f.owner("SELECT level FROM level_item WHERE item_id = $1", [frame])).toEqual([
        { level: top?.level },
      ]);
    });

    it("never makes a sign-up or an erasure wait", async () => {
      const leaving = await playerAt(600);
      const hash = await f.deletionToken(leaving.id);
      const door = await session(admin);
      const doc = await current();
      expect(
        (await door.start(saveSql, [swap(swap(doc, 3, { xpFrom: 499 }), 2, { xpFrom: 199 }), true]))
          .code,
      ).toBeNull();
      const started = performance.now();
      const [made] = await f.owner<{ id: string }>(
        "INSERT INTO player (username) VALUES ('race_signup') RETURNING id",
      );
      expect(made?.id).toBeTruthy();
      expect(
        (
          await f.asPlayer<{ outcome: string }>(
            leaving.id,
            "SELECT outcome FROM erase_player($1, true, $2)",
            [hash, randomUUID()],
          )
        )[0]?.outcome,
      ).toBeTruthy();
      expect(performance.now() - started).toBeLessThan(1000);
      await door.commit();
      await door.end();
      await save(swap(swap(await current(), 2, { xpFrom: 200 }), 3, { xpFrom: 500 }));
    });
  });
});
