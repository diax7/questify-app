import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "#src/db/context";
import { questifyFixture, type QuestifyFixture } from "#test/support/questify";
import { addMember, connectAsOwner, TEST_DATABASE_URL } from "#test/support/test-db";

type Row = {
  id: string;
  kind: string;
  name: { ar: string; en: string };
  visualKey: string | null;
  source: { level: number } | { shop: { status: string } } | null;
  locked: { art: string | null };
};

/** A call's SQLSTATE and detail, or "none". */
const refusal = (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "none",
    (error: { code?: string; detail?: string }) =>
      error.detail === undefined || error.detail === ""
        ? `${error.code}`
        : `${error.code}:${error.detail}`,
  );
const because = (reason: string) => `CA409:{"reason": "${reason}"}`;
const NAME = { ar: "إطار الفجر", en: "Dawn frame" };
const SOUVENIR = "souvenir-0123456789abcdef0123456789abcdef";

/**
 * T-709d's item catalog in the database (migration 0124, ADR-441): Questify's items are listed with their source and art
 * lock, souvenirs never; names always change, art only while the item is not in the shop and no one reached the level it
 * rewards; a new item is made with its art and optionally put on sale; the exclusive-source guard lets a shop item change
 * its names only.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("console items (database)", () => {
  let f: QuestifyFixture;
  let admin: RequestContext = {};

  const one = async <T>(sql: string, values: unknown[] = [], seat = admin): Promise<T> =>
    (await f.run<{ r: T }>(seat, sql, values))[0]?.r as T;
  const items = () => one<Row[]>("SELECT admin_items() AS r");
  const listed = async (id: string) => (await items()).find((row) => row.id === id);
  const create = (doc: unknown) =>
    one<Row>("SELECT admin_item_create($1, $2) AS r", [doc, randomUUID()]);
  const save = (id: string, doc: unknown, revertOf: string | null = null) =>
    one<Row>("SELECT admin_item_save($1, $2, $3, $4) AS r", [id, doc, revertOf, randomUUID()]);
  const frame = (id: string, visualKey = "frame-06", shop?: unknown) => ({
    id,
    kind: "frame",
    name: NAME,
    visualKey,
    ...(shop === undefined ? {} : { shop }),
  });
  const reachLevel2 = async () => {
    const player = await f.newPlayer();
    await f.play(await f.newEvent(), player, 2);
    return player;
  };

  beforeAll(async () => {
    f = await questifyFixture();
    const [row] = await f.owner<{ id: string }>(
      "INSERT INTO staff_user (email, password_hash, platform_role, status) VALUES ('items@questify.test', 'h', 'admin', 'active') RETURNING id",
    );
    admin = { isAdmin: true, staffUserId: row?.id ?? "" };
    await f.owner(
      `INSERT INTO item (id, kind, name_ar, name_en, visual_key) VALUES ($1, 'frame', 'تذكار', 'Souvenir', 'frame-01'),
       ('organizer-made', 'title', 'تذكار', 'Keepsake', NULL)`,
      [SOUVENIR],
    );
    await f.owner(
      "INSERT INTO souvenir_rule (organizer_id, event_id, item_id, audience) VALUES ($1, $2, 'organizer-made', 'all')",
      [f.ids.orgA, await f.newEvent()],
    );
  });
  afterAll(async () => {
    await f.close();
  });

  it("refuses every seat that is not an active platform admin with QE403", async () => {
    const editor = await addMember(f.db.owner, f.ids.orgA, "editor");
    const someone = await f.newPlayer();
    for (const seat of [
      f.team(),
      f.team(editor),
      { playerId: someone },
      { isAdmin: true },
    ] as RequestContext[]) {
      for (const [sql, values] of [
        ["SELECT admin_items()", []],
        [
          "SELECT admin_item_save('level-2', $1, NULL, gen_random_uuid())",
          [{ name: NAME, visualKey: "frame-01" }],
        ],
        ["SELECT admin_item_create($1, gen_random_uuid())", [frame("seat-test")]],
      ] as const) {
        expect(await refusal(f.run(seat, sql, [...values])), sql).toBe("QE403");
      }
    }
  });

  it("lists level rewards, shop items and unassigned items with their source and art lock, never a souvenir", async () => {
    await reachLevel2();
    await create(frame("loose-frame"));
    const all = await items();
    expect(all.find((row) => row.id === "level-2")).toEqual({
      id: "level-2",
      kind: "frame",
      name: { ar: "إطار الدرب", en: "Trail frame" },
      visualKey: "frame-01",
      source: { level: 2 },
      locked: { art: "owned" },
    });
    expect(all.find((row) => row.id === "level-30")).toMatchObject({
      source: { level: 30 },
      locked: { art: null },
    });
    expect(all.find((row) => row.id === "shop-map-reader")).toMatchObject({
      source: { shop: { status: "active" } },
      locked: { art: "on_sale" },
    });
    expect(all.find((row) => row.id === "loose-frame")).toMatchObject({
      source: null,
      locked: { art: null },
    });
    expect(all.map((row) => row.id)).not.toContain(SOUVENIR);
    expect(all.map((row) => row.id)).not.toContain("organizer-made");
    expect(await refusal(save(SOUVENIR, { name: NAME, visualKey: "frame-01" }))).toBe("CA404");
    expect(await refusal(save("organizer-made", { name: NAME, visualKey: null }))).toBe("CA404");
    expect(await refusal(save("no-such-item", { name: NAME, visualKey: null }))).toBe("CA404");
  });

  describe("saving", () => {
    it("renames a shop item, on sale or retired, and refuses its art (item_on_sale)", async () => {
      const shop = await listed("shop-map-reader");
      expect((await save("shop-map-reader", { name: NAME, visualKey: null })).name).toEqual(NAME);
      await f.owner(
        "UPDATE gem_shop_item SET status = 'retired' WHERE item_id = 'shop-map-reader'",
      );
      expect((await save("shop-map-reader", { name: shop?.name, visualKey: null })).name).toEqual(
        shop?.name,
      );
      const frameShop = (await items()).find(
        (row) => row.kind === "frame" && row.locked.art === "on_sale",
      );
      expect(
        await refusal(save(frameShop?.id ?? "", { name: frameShop?.name, visualKey: "frame-20" })),
      ).toBe(because("item_on_sale"));
    });

    it("refuses the art of a level reward someone reached (item_owned) and allows it on one nobody reached", async () => {
      await reachLevel2();
      expect(
        await refusal(
          save("level-2", { name: { ar: "إطار الدرب", en: "Trail frame" }, visualKey: "frame-09" }),
        ),
      ).toBe(because("item_owned"));
      const before = await listed("level-28");
      const changed = await save("level-28", { name: before?.name, visualKey: "frame-19" });
      expect(changed.visualKey).toBe("frame-19");
      expect(
        await refusal(save("level-28", { name: before?.name, visualKey: "frame-99" })),
      ).toMatch(/^23514/);
      expect(await refusal(save("level-28", { name: before?.name, visualKey: "chest" }))).toMatch(
        /^23514/,
      );
    });

    it("checks the document: names, art present, nothing else", async () => {
      for (const doc of [
        { name: { ar: "", en: "x" }, visualKey: null },
        { name: NAME },
        { name: NAME, visualKey: null, kind: "title" },
        ["a list"],
      ]) {
        expect(await refusal(save("level-3", JSON.stringify(doc))), JSON.stringify(doc)).toMatch(
          /^CA400/,
        );
      }
    });

    it("audits a change and puts it back through the same rules; a create has nothing to revert", async () => {
      const before = await listed("level-27");
      const renamed = { ar: "إطار جديد", en: "New frame" };
      await save("level-27", { name: renamed, visualKey: before?.visualKey });
      const [entry] = await f.owner<{ id: string; before: unknown; after: unknown }>(
        "SELECT id, before, after FROM audit_log WHERE action = 'catalog.item.update' AND target_id = 'level-27'",
      );
      expect(entry?.before).toEqual({ name: before?.name, visualKey: before?.visualKey });
      expect(entry?.after).toEqual({ name: renamed, visualKey: before?.visualKey });
      expect((await save("level-27", null, entry?.id ?? "")).name).toEqual(before?.name);
      expect(
        await f.owner(
          "SELECT count(*)::int AS n FROM audit_log WHERE action = 'catalog.item.revert'",
        ),
      ).toEqual([{ n: 1 }]);
      await create(frame("audited-new"));
      expect(
        await f.owner(
          "SELECT before FROM audit_log WHERE action = 'catalog.item.create' AND target_id = 'audited-new'",
        ),
      ).toEqual([{ before: null }]);
    });
  });

  describe("creating", () => {
    it("makes an item with and without a shop listing", async () => {
      expect(await create(frame("plain-new"))).toMatchObject({ id: "plain-new", source: null });
      expect(
        await create(frame("sale-new", "frame-11", { price: 90, position: 40, status: "active" })),
      ).toMatchObject({ source: { shop: { status: "active" } }, locked: { art: "on_sale" } });
      expect(
        await f.owner(
          "SELECT price, position, status FROM gem_shop_item WHERE item_id = 'sale-new'",
        ),
      ).toEqual([{ price: 90, position: 40, status: "active" }]);
      expect(
        await create({ id: "title-new", kind: "title", name: NAME, visualKey: null }),
      ).toMatchObject({ kind: "title", visualKey: null });
    });

    it.each([
      ["a bad id", { ...frame("x"), id: "Bad Id" }, "CA400:id"],
      ["a souvenir- id", { ...frame("x"), id: "souvenir-abc" }, "CA400:id"],
      ["an unknown kind", { ...frame("kind-x"), kind: "hat" }, "CA400:kind"],
      ["an unknown field", { ...frame("field-x"), price: 4 }, "CA400:doc"],
      ["no art key", { id: "noart-x", kind: "title", name: NAME }, "CA400:doc"],
      [
        "a bad shop listing",
        frame("shop-x", "frame-02", { price: 0, position: 1, status: "active" }),
        "CA400:shop",
      ],
      ["art for another kind", { ...frame("art-x"), visualKey: "chest" }, "23514:"],
      ["a bad name", { ...frame("name-x"), name: { ar: "", en: "x" } }, "CA400:name.ar"],
    ])("refuses %s", async (_name, doc, code) => {
      expect((await refusal(create(doc))).startsWith(code)).toBe(true);
    });

    it("refuses an id that exists, a level reward's included (item_exists), and lets one of two creates win", async () => {
      expect(await refusal(create(frame("level-2")))).toBe(because("exists"));
      expect(
        await refusal(
          create(frame("shop-map-reader", "frame-02", { price: 5, position: 5, status: "active" })),
        ),
      ).toBe(because("exists"));
      const outcomes = await Promise.all([
        refusal(create(frame("twin"))),
        refusal(create(frame("twin"))),
      ]);
      expect(outcomes.toSorted()).toEqual([because("exists"), "none"].toSorted());
    });
  });

  describe("the exclusive-source guard (restated)", () => {
    it("lets a shop item change its names only (GS409 on art) and keeps an active souvenir frozen (SV409)", async () => {
      expect(
        await refusal(
          f.owner("UPDATE item SET name_en = 'Dune ring two' WHERE id = 'shop-dune-ring'"),
        ),
      ).toBe("none");
      expect(
        await refusal(
          f.owner("UPDATE item SET visual_key = 'frame-03' WHERE id = 'shop-dune-ring'"),
        ),
      ).toBe("GS409:shop_item_locked");
      await f.owner(
        "UPDATE souvenir_rule SET status = 'active', activated_at = now() WHERE item_id = 'organizer-made'",
      );
      expect(
        await refusal(f.owner("UPDATE item SET name_en = 'Changed' WHERE id = 'organizer-made'")),
      ).toBe("SV409:souvenir_locked");
      expect(
        await refusal(
          f.owner(
            "INSERT INTO gem_shop_item (item_id, price, position) VALUES ('level-5', 10, 10)",
          ),
        ),
      ).toMatch(/^23514/);
    });
  });

  describe("an art change and a reach of the level that gives the item, both orders", () => {
    /** A player one quest credit (100 XP) below `level`'s start, with the transaction of that credit held open. */
    const nearly = async (level: number) => {
      const player = await f.newPlayer();
      const event = await f.newEvent({ phase: "live" });
      const enrollment = await f.join(event, player);
      const start = 50 * (level - 1) * (level + 2);
      for (let xp = 0; xp < start - 100; xp += 100) await f.earn(event, enrollment);
      return { player, event, enrollment };
    };
    const reachOn = async (client: Client, runner: Awaited<ReturnType<typeof nearly>>) => {
      const quest = await client.query<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, visible, type_config)
         SELECT $1, id, 'scan_qr', 'Quest', 10, 100, true, '{}' FROM category WHERE event_id = $1 LIMIT 1 RETURNING id`,
        [runner.event],
      );
      const done = await client.query<{ id: string }>(
        `INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method, idempotency_key)
         VALUES ($1, $2, $3, $4, 1, 'qr', $5) RETURNING id`,
        [f.ids.orgA, runner.event, runner.enrollment, quest.rows[0]?.id, randomUUID()],
      );
      return client.query(
        `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, completion_id,
                                   quest_id, actor)
         VALUES ($1, $2, $3, 'quest', 10, 10, $4, $5, 'player')`,
        [f.ids.orgA, runner.event, runner.enrollment, done.rows[0]?.id, quest.rows[0]?.id],
      );
    };
    const waiting = async (pid: number) => {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const rows = await f.owner(
          "SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'",
          [pid],
        );
        if (rows.length === 1) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`backend ${pid} never waited`);
    };
    let opened: Client[] = [];
    afterEach(async () => {
      for (const client of opened) {
        await client.query("ROLLBACK").catch(() => undefined);
        await client.end();
      }
      opened = [];
    });
    const ownerSession = async () => {
      const client = await connectAsOwner(f.db);
      opened.push(client);
      await client.query("SET lock_timeout = '2s'");
      return client;
    };

    /** Waits until a backend running `text` waits for a lock. */
    const queued = async (text: string) => {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        const rows = await f.owner(
          "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE $1",
          [`%${text}%`],
        );
        if (rows.length > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`no backend running ${text} waited`);
    };

    it("reach first: the art change waits, then sees the owner (item_owned)", async () => {
      const runner = await nearly(6);
      const reach = await ownerSession();
      await reach.query("BEGIN");
      await reachOn(reach, runner);
      const before = await listed("level-6");
      const painting = refusal(save("level-6", { name: before?.name, visualKey: "frame-12" }));
      await queued("admin_item_save");
      await reach.query("COMMIT");
      expect(await painting).toBe(because("item_owned"));
    });

    it("art first: the reach waits, then the player gets the item with the new art", async () => {
      const runner = await nearly(8);
      const before = await listed("level-8");
      const art = await ownerSession();
      await art.query("BEGIN");
      await art.query(
        "SELECT set_config('app.is_admin', 'on', true), set_config('app.staff_user_id', $1, true)",
        [admin.staffUserId],
      );
      await art.query("SELECT admin_item_save('level-8', $1, NULL, gen_random_uuid())", [
        { name: before?.name, visualKey: "frame-13" },
      ]);
      const reach = await ownerSession();
      const reachPid =
        (await reach.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid ?? 0;
      await reach.query("BEGIN");
      const reaching = reachOn(reach, runner).then(
        () => "none",
        (error: { code?: string }) => String(error.code),
      );
      await waiting(reachPid);
      await art.query("COMMIT");
      expect(await reaching).toBe("none");
      await reach.query("COMMIT");
      expect(
        await f.owner(
          `SELECT i.visual_key FROM player_item o JOIN item i ON i.id = o.item_id
           WHERE o.player_id = $1 AND o.item_id = 'level-8'`,
          [runner.player],
        ),
      ).toEqual([{ visual_key: "frame-13" }]);
    });
  });
});
