import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "#src/db/context";
import { questifyFixture, type QuestifyFixture } from "#test/support/questify";
import { addMember, connectAsOwner, TEST_DATABASE_URL } from "#test/support/test-db";

type Level = { level: number; xpFrom: number; itemId: string | null };
type Doc = { levels: Level[] };
type Table = { levels: (Level & { reached: boolean })[] };
type Sync = {
  levelUp: { level: number; items: { id: string }[] } | null;
};

/** A call's SQLSTATE and detail ("CA409:{...}"), or "none". */
const refusal = (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "none",
    (error: { code?: string; detail?: string }) =>
      error.detail === undefined || error.detail === ""
        ? `${error.code}`
        : `${error.code}:${error.detail}`,
  );
/** A CA409 of the XP table as jsonb prints its detail. */
const held = (reason: string, level: number) => `CA409:{"level": ${level}, "reason": "${reason}"}`;

const docOf = (t: Table): Doc => ({
  levels: t.levels.map(({ level, xpFrom, itemId }) => ({ level, xpFrom, itemId })),
});

/** The default curve (0039): level n starts at 50·(n−1)·(n+2); levels 2 to 30 give level-n (0063). */
const START = (n: number) => 50 * (n - 1) * (n + 2);

/**
 * T-709d in the database (migration 0124): the XP table door (one document, row locks within one 1 s budget, the
 * refusals that keep rewards given, a confirmation for a lowering), the preview, each player's catch-up at the next sync
 * (items once), the readers that derive the level from XP, and the deny-by-default checks. The lock
 * races are in console-xp-table-races.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("console XP table (database)", () => {
  let f: QuestifyFixture;
  let admin: RequestContext = {};
  let original: Doc = { levels: [] };

  const one = async <T>(sql: string, values: unknown[] = [], seat = admin): Promise<T> =>
    (await f.run<{ r: T }>(seat, sql, values))[0]?.r as T;
  const table = () => one<Table>("SELECT admin_xp_table() AS r");
  const save = (doc: unknown, confirmed = false, revertOf: string | null = null) =>
    one<Table>("SELECT admin_xp_table_save($1, $2, $3, $4) AS r", [
      doc,
      revertOf,
      confirmed,
      randomUUID(),
    ]);
  const preview = (doc: unknown) =>
    one<{ up: number; down: number; levels: number }>("SELECT admin_xp_table_preview($1) AS r", [
      doc,
    ]);
  /** The default curve with some levels changed: `{ 3: { xpFrom: 250 } }`. */
  const edit = (changes: Record<number, Partial<Level>>, base = original): Doc => ({
    levels: base.levels.map((row) => ({ ...row, ...changes[row.level] })),
  });
  const upTo = (n: number, base = original): Doc => ({ levels: base.levels.slice(0, n) });
  const sync = async (player: string) =>
    (await f.asPlayer<{ r: Sync }>(player, "SELECT questify_sync() AS r"))[0]?.r;
  const stored = async (player: string) =>
    (
      await f.owner<{ xp: string; level: number }>(
        "SELECT xp, level FROM player_xp WHERE player_id = $1",
        [player],
      )
    )[0];
  const reached = async (player: string) =>
    (
      await f.owner<{ level: number }>(
        "SELECT level FROM level_reached WHERE player_id = $1 ORDER BY level",
        [player],
      )
    ).map((row) => row.level);
  const owned = async (player: string) =>
    (
      await f.owner<{ item_id: string }>(
        "SELECT item_id FROM player_item WHERE player_id = $1 AND source = 'level' ORDER BY source_level",
        [player],
      )
    ).map((row) => row.item_id);
  /** A player with `quests` quest credits (100 XP each), synced once unless `synced` is false. */
  const player = async (quests: number, synced = true) => {
    const id = await f.newPlayer();
    await f.play(await f.newEvent(), id, quests);
    if (synced) await sync(id);
    return id;
  };
  const newItem = async (id: string, kind = "title", visualKey: string | null = null) =>
    one("SELECT admin_item_create($1, $2) AS r", [
      { id, kind, name: { ar: "جائزة", en: "Prize" }, visualKey },
      randomUUID(),
    ]);

  const raised = (by: number) =>
    edit(
      Object.fromEntries(
        original.levels.slice(1).map((row) => [row.level, { xpFrom: row.xpFrom + by }]),
      ),
    );
  const at = (level: number, row: Partial<Level>) => () => edit({ [level]: row });
  beforeAll(async () => {
    f = await questifyFixture();
    const [row] = await f.owner<{ id: string }>(
      "INSERT INTO staff_user (email, password_hash, platform_role, status) VALUES ('xpt@questify.test', 'h', 'admin', 'active') RETURNING id",
    );
    admin = { isAdmin: true, staffUserId: row?.id ?? "" };
    original = docOf(await table());
  });
  afterEach(async () => {
    await save(original, true);
    const drift = await f.owner(
      `SELECT x.player_id FROM player_xp x
       WHERE x.xp <> coalesce((SELECT sum(e.delta) FROM xp_entry e WHERE e.player_id = x.player_id), 0)`,
    );
    expect(drift).toEqual([]);
  });
  afterAll(async () => {
    await f.close();
  });

  describe("who may ask, and what is closed", () => {
    it("refuses every seat that is not an active platform admin with QE403 on the three doors", async () => {
      const editor = await addMember(f.db.owner, f.ids.orgA, "editor");
      const [off] = await f.owner<{ id: string }>(
        "INSERT INTO staff_user (email, password_hash, platform_role, status) VALUES ('off-xpt@questify.test', 'h', 'admin', 'disabled') RETURNING id",
      );
      const someone = await f.newPlayer();
      const seats: RequestContext[] = [
        f.team(),
        f.team(editor),
        { playerId: someone },
        { isAdmin: true },
        { isAdmin: true, staffUserId: editor },
        { isAdmin: true, staffUserId: off?.id ?? "" },
      ];
      for (const seat of seats) {
        for (const [sql, values] of [
          ["SELECT admin_xp_table()", []],
          ["SELECT admin_xp_table_save($1, NULL, true, gen_random_uuid())", [original]],
          ["SELECT admin_xp_table_preview($1)", [original]],
        ] as const) {
          expect(
            await refusal(f.run(seat, sql, [...values])),
            `${JSON.stringify(seat)} ${sql}`,
          ).toBe("QE403");
        }
      }
    });

    it("gives the internals to nobody, and only levels_reach inserts into level_reached", async () => {
      const internals = await f.owner<{ proname: string; grantee: string }>(
        `SELECT DISTINCT p.proname, CASE WHEN a.grantee = 0 THEN 'public' ELSE a.grantee::regrole::text END AS grantee
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
         WHERE n.nspname = 'public' AND a.privilege_type = 'EXECUTE' AND a.grantee <> p.proowner
           AND p.proname IN ('levels_reach', 'xp_catch_up', 'levels_due', 'xp_table_checked', 'xp_lock_left',
                             'xp_table_refuse', 'xp_table_refusals', 'xp_table_paying', 'xp_table_changes',
                             'xp_table_write', 'admin_xp_table_doc', 'questify_level_up', 'xp_board_top',
                             'xp_board_active_between')`,
      );
      expect(internals).toEqual([]);
      const inserters = await f.owner<{ proname: string }>(
        `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.prosrc ~* 'insert\\s+into\\s+(public\\.)?level_reached' ORDER BY 1`,
      );
      expect(inserters.map((row) => row.proname)).toEqual(["levels_reach"]);
      const writers = await f.owner<{ proname: string }>(
        `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public'
           AND p.prosrc ~* '(insert\\s+into|update|delete\\s+from)\\s+(public\\.)?(xp_level|level_item)\\M' ORDER BY 1`,
      );
      expect(writers.map((row) => row.proname)).toEqual(["xp_table_write"]);
      const callers = await f.owner<{ proname: string }>(
        `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.prosrc ~* 'xp_table_write\\(' ORDER BY 1`,
      );
      expect(callers.map((row) => row.proname)).toEqual(["admin_xp_table_save"]);
    });

    it("lists the table with the levels anyone reached", async () => {
      await player(3);
      const listed = await table();
      expect(listed.levels).toHaveLength(30);
      expect(listed.levels[0]).toEqual({ level: 1, xpFrom: 0, itemId: null, reached: false });
      expect(listed.levels[1]).toEqual({ level: 2, xpFrom: 200, itemId: "level-2", reached: true });
      expect(listed.levels[29]).toMatchObject({ level: 30, xpFrom: START(30), reached: false });
    });
  });

  describe("the document", () => {
    it.each<[string, () => unknown, string]>([
      ["no levels key", () => ({ titles: [] }), "levels"],
      ["an unknown key", () => ({ ...upTo(5), more: 1 }), "levels"],
      ["one level", () => upTo(1), "levels"],
      [
        "101 levels",
        () => ({
          levels: Array.from({ length: 101 }, (_, i) => ({
            level: i + 1,
            xpFrom: i * 10,
            itemId: i === 0 ? null : `x-${i}`,
          })),
        }),
        "levels",
      ],
      ["a gap", () => ({ levels: [original.levels[0], original.levels[2]] }), "level:2"],
      ["level 1 not at 0", at(1, { xpFrom: 5 }), "xpFrom:1"],
      ["not rising", at(4, { xpFrom: 500 }), "xpFrom:4"],
      ["a start of 0", at(2, { xpFrom: 0 }), "xpFrom:2"],
      ["a start over 100,000,000", at(30, { xpFrom: 100_000_001 }), "xpFrom:30"],
      ["a decimal start", at(2, { xpFrom: 200.5 }), "xpFrom:2"],
      ["a string start", at(2, { xpFrom: "200" as unknown as number }), "xpFrom:2"],
      ["a missing item", at(3, { itemId: null }), "itemId:3"],
      ["a duplicate item", at(3, { itemId: "level-2" }), "itemId:3"],
      ["level 1 with an item", at(1, { itemId: "level-2" }), "itemId:1"],
      ["a bad item id", at(3, { itemId: "Level 3" }), "itemId:3"],
      [
        "an unknown field in a level",
        () => ({ levels: original.levels.map((row) => ({ ...row, extra: true })) }),
        "level:1",
      ],
    ])("refuses %s with CA400", async (_name, doc, detail) => {
      expect(await refusal(save(doc(), true))).toBe(`CA400:${detail}`);
      expect(await refusal(preview(doc()))).toBe(`CA400:${detail}`);
    });

    it("refuses an unknown item and an item with another source with CA409, naming the level", async () => {
      await newItem("loose-title");
      await f.owner(
        "INSERT INTO item (id, kind, name_ar, name_en) VALUES ('souvenir-0123456789abcdef0123456789abcdef', 'title', 'تذكار', 'Souvenir')",
      );
      for (const [itemId, reason] of [
        ["no-such-item", "item_unknown"],
        ["shop-moon-ring", "item_has_source"],
        ["souvenir-0123456789abcdef0123456789abcdef", "item_has_source"],
      ] as const) {
        expect(await refusal(save(edit({ 30: { itemId } }), true))).toBe(held(reason, 30));
      }
      expect(await refusal(save(edit({ 30: { itemId: "loose-title" } }), true))).toBe("none");
    });

    it("refuses a souvenir's id without waiting on the item's row", async () => {
      const itemId = "souvenir-fedcba9876543210fedcba9876543210";
      await f.owner(
        "INSERT INTO item (id, kind, name_ar, name_en) VALUES ($1, 'title', 'تذكار', 'Souvenir')",
        [itemId],
      );
      const holder = await connectAsOwner(f.db);
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT 1 FROM item WHERE id = $1 FOR UPDATE", [itemId]);
        expect(await refusal(save(edit({ 30: { itemId } }), true))).toBe(
          held("item_has_source", 30),
        );
      } finally {
        await holder.query("ROLLBACK");
        await holder.end();
      }
    });

    it("keeps a document that changes nothing out of the audit", async () => {
      const before = await f.owner(
        "SELECT id FROM audit_log WHERE action LIKE 'catalog.xp_table.%'",
      );
      await save(original);
      expect(
        await f.owner("SELECT id FROM audit_log WHERE action LIKE 'catalog.xp_table.%'"),
      ).toEqual(before);
    });
  });

  describe("removing and remapping", () => {
    it("removes a level nobody reached or stands at, and its item is free again", async () => {
      const saved = await save(upTo(29));
      expect(saved.levels).toHaveLength(29);
      expect(await f.owner("SELECT level FROM level_item WHERE item_id = 'level-30'")).toEqual([]);
      const items = await one<{ id: string; source: unknown }[]>("SELECT admin_items() AS r");
      expect(items.find((row) => row.id === "level-30")?.source).toBeNull();
    });

    it("refuses to remove a level someone reached, or stands at before their row is written (level_held)", async () => {
      const someone = await player(3);
      await save(edit({ 2: { xpFrom: 100 }, 3: { xpFrom: 300 } }), true);
      expect(await reached(someone)).toEqual([2]);
      expect(await refusal(save(upTo(2, edit({ 2: { xpFrom: 100 }, 3: { xpFrom: 300 } }))))).toBe(
        held("level_held", 3),
      );
      expect(await refusal(save(upTo(1)))).toBe("CA400:levels");
      expect(await refusal(save(upTo(2)))).toBe(held("level_held", 3));
    });

    it("refuses to change the reward of a level someone reached (reward_given), allows it on one nobody reached", async () => {
      await player(3);
      await newItem("swap-a");
      expect(await refusal(save(edit({ 2: { itemId: "swap-a" } })))).toBe(held("reward_given", 2));
      expect(
        await refusal(save(edit({ 29: { itemId: "level-30" }, 30: { itemId: "level-29" } }))),
      ).toBe("none");
      expect(
        await f.owner(
          "SELECT level, item_id FROM level_item WHERE level IN (29, 30) ORDER BY level",
        ),
      ).toEqual([
        { level: 29, item_id: "level-30" },
        { level: 30, item_id: "level-29" },
      ]);
    });
  });

  describe("moving the starts", () => {
    it.each([
      ["raise every level", () => raised(1000), false],
      [
        "lower every level",
        () =>
          edit(
            Object.fromEntries(
              original.levels
                .slice(1)
                .map((row) => [row.level, { xpFrom: row.xpFrom - 100 + row.level }]),
            ),
          ),
        true,
      ],
      [
        "raise one onto the next level's old start",
        () => edit({ 10: { xpFrom: START(11) }, 11: { xpFrom: START(11) + 1 } }),
        false,
      ],
      [
        "lower one onto the level before's old start",
        () => edit({ 10: { xpFrom: START(9) }, 9: { xpFrom: START(9) - 1 } }),
        true,
      ],
      [
        "mixed, with the top level removed",
        () =>
          upTo(
            29,
            edit({
              5: { xpFrom: START(5) + 50 },
              6: { xpFrom: START(5) + 60 },
              20: { xpFrom: START(19) + 1 },
            }),
          ),
        true,
      ],
    ])("%s without tripping the unique start", async (_name, doc, pays) => {
      const wanted = doc();
      expect(await refusal(save(wanted))).toMatch(pays ? /^CA428:/ : /^none$/);
      if (pays) await save(wanted, true);
      expect(docOf(await table())).toEqual(wanted);
    });

    it("adds levels above the top and maps them to free items", async () => {
      await newItem("level-31-prize");
      await newItem("level-32-prize", "frame", "frame-07");
      const wanted = {
        levels: [
          ...original.levels,
          { level: 31, xpFrom: 60_000, itemId: "level-31-prize" },
          { level: 32, xpFrom: 70_000, itemId: "level-32-prize" },
        ],
      };
      expect(await refusal(save(wanted))).toBe("none");
      expect(docOf(await table())).toEqual(wanted);
    });
  });

  describe("a lowering pays, so it needs a confirmation", () => {
    it("refuses a lowering without confirmed (CA428 naming the levels), writes nothing", async () => {
      const lower = edit({ 3: { xpFrom: 300 }, 5: { xpFrom: 1000 } });
      const answer = await refusal(save(lower));
      expect(answer.startsWith("CA428:")).toBe(true);
      expect(JSON.parse(answer.slice("CA428:".length))).toEqual({ levels: [3, 5] });
      expect(docOf(await table())).toEqual(original);
      expect(await refusal(save(lower, true))).toBe("none");
    });

    it("needs no confirmation for a raise, an unchanged table, or an added level above everyone's XP", async () => {
      await player(4);
      expect(await refusal(save(edit({ 30: { xpFrom: START(30) + 5 } })))).toBe("none");
      expect(await refusal(save(edit({ 30: { xpFrom: START(30) + 5 } })))).toBe("none");
      await save(original, true);
      await newItem("far-prize");
      expect(
        await refusal(
          save({
            levels: [...original.levels, { level: 31, xpFrom: 90_000, itemId: "far-prize" }],
          }),
        ),
      ).toBe("none");
      await save(original, true);
      expect(
        await refusal(
          save({ levels: [...original.levels, { level: 31, xpFrom: 1, itemId: "far-prize" }] }),
        ),
      ).toBe("CA400:xpFrom:31");
    });

    it("previews how many players go up and down and the level rewards due", async () => {
      const low = await player(3);
      const mid = await player(6);
      expect(await stored(low)).toMatchObject({ level: 2 });
      expect(await stored(mid)).toMatchObject({ level: 3 });
      const before = await preview(original);
      expect(before).toEqual({ up: 0, down: 0, levels: 0 });
      const lower = await preview(edit({ 3: { xpFrom: 300 } }));
      expect(lower.up).toBeGreaterThanOrEqual(1);
      expect(lower.levels).toBe(lower.up);
      const raise = await preview(edit({ 3: { xpFrom: 650 }, 2: { xpFrom: 400 } }));
      expect(raise.down).toBeGreaterThanOrEqual(2);
      expect(raise.levels).toBe(0);
    });
  });

  describe("each player follows at their next sync", () => {
    it("writes the missing levels once, gives each item once, and names the top level", async () => {
      const someone = await player(3);
      expect(await reached(someone)).toEqual([2]);
      await save(edit({ 3: { xpFrom: 250 }, 4: { xpFrom: 280 } }), true);
      expect(await stored(someone)).toMatchObject({ level: 2 });
      const first = await sync(someone);
      expect(first?.levelUp).toMatchObject({ level: 4 });
      expect(first?.levelUp?.items.map((item) => item.id)).toEqual(["level-3", "level-4"]);
      expect(await reached(someone)).toEqual([2, 3, 4]);
      expect(await owned(someone)).toEqual(["level-2", "level-3", "level-4"]);
      expect(await stored(someone)).toMatchObject({ level: 4 });
      const second = await sync(someone);
      expect(second).toMatchObject({ levelUp: null });
      expect(await reached(someone)).toEqual([2, 3, 4]);
    });

    it("gives once when three syncs of one player run at once", async () => {
      const someone = await player(3);
      await save(edit({ 3: { xpFrom: 250 } }), true);
      const answers = await Promise.all([sync(someone), sync(someone), sync(someone)]);
      expect(answers.filter((answer) => answer?.levelUp !== null)).toHaveLength(1);
      expect(await reached(someone)).toEqual([2, 3]);
      expect(await owned(someone)).toEqual(["level-2", "level-3"]);
    });

    it("gives a banned player nothing until the ban is lifted, then once", async () => {
      const someone = await player(3);
      await f.run(
        admin,
        "SELECT * FROM admin_ban_player($1, 'cheating', 'Fraud ticket 4411 confirmed', $2)",
        [someone, randomUUID()],
      );
      await save(edit({ 3: { xpFrom: 250 } }), true);
      expect(await refusal(sync(someone))).toBe("PI401");
      expect(await reached(someone)).toEqual([2]);
      await f.run(
        admin,
        "SELECT * FROM admin_lift_ban($1, 'mistake', 'Fraud ticket 4411 confirmed', $2)",
        [someone, randomUUID()],
      );
      expect((await sync(someone))?.levelUp).toMatchObject({ level: 3 });
      expect((await sync(someone))?.levelUp).toBeNull();
      expect(await reached(someone)).toEqual([2, 3]);
    });

    it("lowers the stored level after a raise at the next sync, and keeps the items", async () => {
      const someone = await player(5);
      expect(await stored(someone)).toMatchObject({ level: 3 });
      await save(edit({ 3: { xpFrom: 600 }, 4: { xpFrom: 950 } }));
      expect(await stored(someone)).toMatchObject({ level: 3 });
      expect((await sync(someone))?.levelUp).toBeNull();
      expect(await stored(someone)).toMatchObject({ level: 2 });
      expect(await owned(someone)).toEqual(["level-2", "level-3"]);
    });

    it("leaves a sync that has nothing due on its unlocked fast path", async () => {
      const someone = await player(3);
      expect(await f.owner("SELECT levels_due($1) AS due", [someone])).toEqual([{ due: false }]);
      await save(edit({ 3: { xpFrom: 250 } }), true);
      expect(await f.owner("SELECT levels_due($1) AS due", [someone])).toEqual([{ due: true }]);
      await sync(someone);
      expect(await f.owner("SELECT levels_due($1) AS due", [someone])).toEqual([{ due: false }]);
    });
  });

  describe("readers", () => {
    it("derives the player's own level and next reward from XP before any sync; the public profile waits for it", async () => {
      const someone = await player(3);
      const username = await f.usernameOf(someone);
      const viewer = await player(1);
      await save(edit({ 3: { xpFrom: 250 } }), true);
      const [mine] = await f.asPlayer<{ level: number; level_from: string; next_level_at: string }>(
        someone,
        "SELECT level, level_from, next_level_at FROM own_level(NULL)",
      );
      expect(mine).toEqual({ level: 3, level_from: "250", next_level_at: String(START(4)) });
      const [gear] = await f.asPlayer<{ next_reward: { id: string } }>(
        someone,
        "SELECT next_reward FROM own_equipment()",
      );
      expect(gear?.next_reward.id).toBe("level-4");
      const profile = async () =>
        (
          await f.asPlayer<{ r: { level: { number: number } } }>(
            viewer,
            "SELECT public_player_profile($1) AS r",
            [username],
          )
        )[0]?.r.level.number;
      expect(await profile()).toBe(2);
      const record = await one<{ player: { level: number } }>(
        "SELECT console_player_record($1, gen_random_uuid()) AS r",
        [someone],
      );
      expect(record.player.level).toBe(3);
      await sync(someone);
      expect(await profile()).toBe(3);
    });

    it("still answers the player's own level when their stored level was removed", async () => {
      await newItem("tail-prize");
      const someone = await player(3);
      await save({
        levels: [...original.levels, { level: 31, xpFrom: 90_000, itemId: "tail-prize" }],
      });
      await f.owner("UPDATE player_xp SET level = 31 WHERE player_id = $1", [someone]);
      await save(original);
      const [mine] = await f.asPlayer<{ level: number }>(
        someone,
        "SELECT level FROM own_level(NULL)",
      );
      expect(mine).toEqual({ level: 2 });
      await sync(someone);
      expect(await stored(someone)).toMatchObject({ level: 2 });
    });
  });

  describe("audit and revert", () => {
    it("audits the levels before and after, and a revert puts the earlier table back through the same checks", async () => {
      const changed = edit({ 30: { xpFrom: START(30) - 77 } });
      await save(changed, true);
      const [entry] = await f.owner<{
        id: string;
        before: Doc;
        after: Doc;
        target_type: string;
        target_id: string;
      }>(
        `SELECT id, before, after, target_type, target_id FROM audit_log WHERE action = 'catalog.xp_table.update'
         ORDER BY id DESC LIMIT 1`,
      );
      expect(entry).toMatchObject({
        target_type: "xp_level",
        target_id: "all",
        before: original,
        after: changed,
      });
      expect(await refusal(save(null, false, "1"))).toBe("CA409");
      await save(null, false, entry?.id ?? "");
      expect(docOf(await table())).toEqual(original);
      expect(
        await f.owner(
          "SELECT count(*)::int AS n FROM audit_log WHERE action = 'catalog.xp_table.revert'",
        ),
      ).toEqual([{ n: 1 }]);
    });

    it("needs a confirmation for a revert that lowers", async () => {
      await save(edit({ 30: { xpFrom: START(30) + 500 } }));
      const [entry] = await f.owner<{ id: string }>(
        "SELECT id FROM audit_log WHERE action LIKE 'catalog.xp_table.%' ORDER BY id DESC LIMIT 1",
      );
      expect(await refusal(save(null, false, entry?.id ?? ""))).toMatch(/^CA428:/);
      expect(await refusal(save(null, true, entry?.id ?? ""))).toBe("none");
    });
  });
});
