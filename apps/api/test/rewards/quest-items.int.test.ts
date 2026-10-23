import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createStaff,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type Row = Record<string, unknown>;

/**
 * Quest items over HTTP (T-304d): the item editor with its refusals and audit, the item picker on quests and
 * categories, the pay answers' `item` and `bonus.item`, the desk's and the player's `source`, the removal's `item`, and
 * the misses list.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("quest items over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let organizer = "";
  let editorCookie = "";
  let strangerCookie = "";
  let counter = 0;

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db);
    const orgs: string[] = [];
    for (const slug of ["item-org", "item-other"]) {
      const [made] = (
        await db.owner.query<{ id: string }>(
          "INSERT INTO organizer (name, slug) VALUES ('Najd Events', $1) RETURNING id",
          [slug],
        )
      ).rows;
      orgs.push(made?.id ?? "");
    }
    organizer = orgs[0] ?? "";
    for (const [email, org] of [
      ["editor@items.test", orgs[0]],
      ["stranger@items.test", orgs[1]],
    ] as const) {
      const id = await createStaff(db.owner, { email });
      await db.owner.query(
        "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'editor')",
        [org, id],
      );
    }
    editorCookie = await signInFully(test, "editor@items.test");
    strangerCookie = await signInFully(test, "stranger@items.test");
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  const owner = async <T extends Row>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;

  const newEvent = async (desk: string | null = "Hall B") => {
    counter += 1;
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at, desk_location_en)
       VALUES ($1, $2, 'Item Fest', 'live', now() - interval '1 hour', now() + interval '2 days', $3) RETURNING id`,
      [organizer, `ITEMH${counter}`, desk],
    );
    const [category] = await owner<{ id: string }>(
      "INSERT INTO category (event_id, name_en) VALUES ($1, 'General') RETURNING id",
      [event?.id],
    );
    return { id: event?.id ?? "", category: category?.id ?? "" };
  };
  const newItem = async (event: string, stock = 5) =>
    (
      await owner<{ id: string }>(
        "INSERT INTO quest_item (event_id, name_en, name_ar, stock_total) VALUES ($1, 'T-shirt', 'قميص', $2) RETURNING id",
        [event, stock],
      )
    )[0]?.id ?? "";
  const newQuest = async (event: string, category: string, item: string | null, points = 50) =>
    (
      await owner<{ id: string }>(
        `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config, item_id)
         VALUES ($1, $2, 'enter_code', 'Code', $3, '{"code":"ABC"}', $4) RETURNING id`,
        [event, category, points, item],
      )
    )[0]?.id ?? "";
  const newPlayer = async (event: string) => {
    counter += 1;
    const [player] = await owner<{ id: string }>(
      "INSERT INTO player (username) VALUES ($1) RETURNING id",
      [`item_h_${counter}`],
    );
    const token = randomBytes(32).toString("base64url");
    await owner(
      "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
      [player?.id, createHash("sha256").update(token).digest()],
    );
    const [enrolled] = await owner<{ id: string }>(
      "INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES ($1, $2, $3) RETURNING id",
      [organizer, event, player?.id],
    );
    return { id: player?.id ?? "", token, enrollment: enrolled?.id ?? "" };
  };

  const dashboard = (
    cookie: string,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    payload?: object,
  ) =>
    test.app.inject({
      method,
      url: `/v1/organizers/${organizer}${path}`,
      headers: withSession(cookie, { "idempotency-key": randomUUID() }),
      ...(payload === undefined ? {} : { payload }),
    });
  const complete = (token: string, quest: string) =>
    test.app.inject({
      method: "POST",
      url: `/v1/quests/${quest}/complete`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": randomUUID() },
      payload: { proof: { type: "code", code: "ABC" } },
    });
  const asPlayer = (token: string, url: string, method: "GET" | "POST" = "GET", payload?: object) =>
    test.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": randomUUID() },
      ...(payload === undefined ? {} : { payload }),
    });

  describe("the item editor", () => {
    it("adds, edits, lists and removes an item, auditing each write", async () => {
      const { id: event } = await newEvent();
      const made = await dashboard(editorCookie, "POST", `/events/${event}/quest-items`, {
        name: { en: " Cap ", ar: "قبعة" },
        stockTotal: 20,
      });
      expect(made.statusCode).toBe(201);
      const item = made.json().item as { id: string };
      expect(made.json().item).toMatchObject({
        name: { en: "Cap", ar: "قبعة" },
        description: { ar: null, en: null },
        stockTotal: 20,
        unitsOut: 0,
        stockLeft: 20,
        missed: 0,
        quests: [],
        categories: [],
      });
      const edited = await dashboard(
        editorCookie,
        "PATCH",
        `/events/${event}/quest-items/${item.id}`,
        {
          stockTotal: 30,
          description: { en: "One size" },
        },
      );
      expect(edited.json().item).toMatchObject({ stockTotal: 30, description: { en: "One size" } });
      const listed = await dashboard(editorCookie, "GET", `/events/${event}/quest-items`);
      expect(listed.json().items).toHaveLength(1);
      const gone = await dashboard(
        editorCookie,
        "DELETE",
        `/events/${event}/quest-items/${item.id}`,
      );
      expect(gone.statusCode).toBe(204);
      expect((await dashboard(editorCookie, "GET", `/events/${event}/quest-items`)).json()).toEqual(
        {
          items: [],
        },
      );
      expect(
        (
          await owner<{ action: string }>(
            "SELECT action FROM audit_log WHERE event_id = $1 AND action LIKE 'quest_item.%' ORDER BY id",
            [event],
          )
        ).map((row) => row.action),
      ).toEqual(["quest_item.create", "quest_item.update", "quest_item.remove"]);
    });

    it("refuses a nameless item, no desk, a linked removal, stock below what is out, and a stranger", async () => {
      const { id: event, category } = await newEvent();
      expect(
        (
          await dashboard(editorCookie, "POST", `/events/${event}/quest-items`, {
            name: { en: " " },
            stockTotal: 1,
          })
        ).json(),
      ).toMatchObject({ code: "invalid_request", details: { field: "name" } });
      const { id: bare } = await newEvent(null);
      const noDesk = await dashboard(editorCookie, "POST", `/events/${bare}/quest-items`, {
        name: { en: "Cap" },
        stockTotal: 1,
      });
      expect([noDesk.statusCode, noDesk.json().code]).toEqual([409, "desk_needed"]);
      const item = await newItem(event, 1);
      const quest = await newQuest(event, category, item);
      const linked = await dashboard(
        editorCookie,
        "DELETE",
        `/events/${event}/quest-items/${item}`,
      );
      expect([linked.statusCode, linked.json().code]).toEqual([409, "item_in_use"]);
      const player = await newPlayer(event);
      await complete(player.token, quest);
      const below = await dashboard(editorCookie, "PATCH", `/events/${event}/quest-items/${item}`, {
        stockTotal: 0,
      });
      expect(below.json()).toMatchObject({
        code: "stock_below_reserved",
        details: { unitsOut: 1 },
      });
      for (const response of [
        await dashboard(strangerCookie, "GET", `/events/${event}/quest-items`),
        await dashboard(strangerCookie, "GET", `/events/${event}/quest-items/${item}/misses`),
        await dashboard(editorCookie, "PATCH", `/events/${event}/quest-items/${randomUUID()}`, {
          stockTotal: 1,
        }),
      ]) {
        expect(response.statusCode).toBe(404);
      }
    });

    it("keeps a one-language name, edits each language on its own, and audits only a real change", async () => {
      const { id: event } = await newEvent();
      const path = `/events/${event}/quest-items`;
      const made = await dashboard(editorCookie, "POST", path, {
        name: { ar: "قبعة" },
        stockTotal: 2,
      });
      expect(made.statusCode).toBe(201);
      const item = made.json().item as { id: string };
      expect(made.json().item).toMatchObject({ name: { ar: "قبعة", en: null } });
      const mug = (
        await dashboard(editorCookie, "POST", path, { name: { en: "Mug" }, stockTotal: 1 })
      ).json().item as { id: string };
      const edit = (id: string, body: object) =>
        dashboard(editorCookie, "PATCH", `${path}/${id}`, body);

      expect((await edit(item.id, { name: { en: "Cap" } })).json().item).toMatchObject({
        name: { ar: "قبعة", en: "Cap" },
      });
      expect((await edit(item.id, { name: { ar: null } })).json().item).toMatchObject({
        name: { ar: null, en: "Cap" },
      });
      expect((await edit(item.id, { name: { ar: "قبعة" } })).json().item).toMatchObject({
        name: { ar: "قبعة", en: "Cap" },
      });
      const nameless = await edit(item.id, { name: { ar: " ", en: null } });
      expect([nameless.statusCode, nameless.json()]).toMatchObject([
        400,
        { code: "invalid_request", details: { field: "name" } },
      ]);
      const other = await edit(mug.id, { stockTotal: 3 });
      expect(other.json().item).toMatchObject({ id: mug.id, name: { en: "Mug" }, stockTotal: 3 });

      const updates = async () =>
        (
          await owner(
            "SELECT 1 FROM audit_log WHERE target_id = $1 AND action = 'quest_item.update'",
            [item.id],
          )
        ).length;
      const before = await updates();
      expect((await edit(item.id, { stockTotal: 2, name: { en: "Cap" } })).statusCode).toBe(200);
      expect(await updates()).toBe(before);
    });

    it("lets the stock come down to exactly what is out", async () => {
      const { id: event, category } = await newEvent();
      const item = await newItem(event, 2);
      const quest = await newQuest(event, category, item);
      await complete((await newPlayer(event)).token, quest);
      const lowered = await dashboard(
        editorCookie,
        "PATCH",
        `/events/${event}/quest-items/${item}`,
        {
          stockTotal: 1,
        },
      );
      expect(lowered.statusCode).toBe(200);
      expect(lowered.json().item).toMatchObject({ stockTotal: 1, unitsOut: 1, stockLeft: 0 });
    });

    it("refuses every write once the event is archived, and an unknown item or event", async () => {
      const { id: event } = await newEvent();
      const item = await newItem(event);
      const path = `/events/${event}/quest-items`;
      counter += 1;
      const [foreign] = await owner<{ id: string }>(
        `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at, desk_location_en)
         SELECT id, $1, 'Other Fest', 'live', now() - interval '1 hour', now() + interval '2 days', 'Hall C'
         FROM organizer WHERE slug = 'item-other' RETURNING id`,
        [`ITEMH${counter}`],
      );
      const foreignPath = `/events/${foreign?.id}/quest-items`;
      for (const response of [
        await dashboard(editorCookie, "POST", foreignPath, { name: { en: "Cap" }, stockTotal: 1 }),
        await dashboard(editorCookie, "PATCH", `${foreignPath}/${item}`, { stockTotal: 9 }),
        await dashboard(editorCookie, "DELETE", `${foreignPath}/${item}`),
        await dashboard(editorCookie, "DELETE", `${path}/${randomUUID()}`),
        await dashboard(editorCookie, "GET", `${path}/${randomUUID()}/misses`),
      ]) {
        expect([response.statusCode, response.json().code]).toEqual([404, "not_found"]);
      }
      await owner("UPDATE event SET status = 'archived' WHERE id = $1", [event]);
      for (const response of [
        await dashboard(editorCookie, "POST", path, { name: { en: "Cap" }, stockTotal: 1 }),
        await dashboard(editorCookie, "PATCH", `${path}/${item}`, { stockTotal: 9 }),
        await dashboard(editorCookie, "DELETE", `${path}/${item}`),
      ]) {
        expect([response.statusCode, response.json().code]).toEqual([409, "event_archived"]);
      }
      expect((await dashboard(editorCookie, "GET", path)).json().items).toMatchObject([
        { id: item, stockTotal: 5 },
      ]);
    });

    it("stops at 100 active items, not counting a removed one", async () => {
      const { id: event } = await newEvent();
      await owner(
        `INSERT INTO quest_item (event_id, name_en, stock_total, status)
         SELECT $1, 'Item ' || n, 1, CASE WHEN n = 1 THEN 'removed' ELSE 'active' END
         FROM generate_series(1, 100) n`,
        [event],
      );
      const add = () =>
        dashboard(editorCookie, "POST", `/events/${event}/quest-items`, {
          name: { en: "One more" },
          stockTotal: 1,
        });
      expect((await add()).statusCode).toBe(201);
      const refused = await add();
      expect([refused.statusCode, refused.json()]).toMatchObject([
        409,
        { code: "limit_reached", details: { limit: 100 } },
      ]);
    });
  });

  describe("the item picker", () => {
    it("links an item to a quest and a category, clears it, and refuses a removed or foreign one", async () => {
      const { id: event, category } = await newEvent();
      const { id: other } = await newEvent();
      const item = await newItem(event);
      const foreign = await newItem(other);
      const quest = await newQuest(event, category, null);
      const linked = await dashboard(editorCookie, "PATCH", `/events/${event}/quests/${quest}`, {
        itemId: item,
        confirm: true,
      });
      expect(linked.json().quest).toMatchObject({ itemId: item });
      const grouped = await dashboard(
        editorCookie,
        "PATCH",
        `/events/${event}/categories/${category}`,
        { itemId: item, confirm: true },
      );
      expect(grouped.json().category).toMatchObject({ itemId: item });
      const listed = await dashboard(editorCookie, "GET", `/events/${event}/quest-items`);
      expect(listed.json().items[0]).toMatchObject({
        quests: [{ id: quest }],
        categories: [{ id: category }],
      });
      const cleared = await dashboard(editorCookie, "PATCH", `/events/${event}/quests/${quest}`, {
        itemId: null,
        confirm: true,
      });
      expect(cleared.json().quest).toMatchObject({ itemId: null });
      const refused = await dashboard(editorCookie, "PATCH", `/events/${event}/quests/${quest}`, {
        itemId: foreign,
        confirm: true,
      });
      expect([refused.statusCode, refused.json().code]).toEqual([422, "invalid_item"]);
      const made = await dashboard(editorCookie, "POST", `/events/${event}/quests`, {
        categoryId: category,
        type: "enter_code",
        title: { en: "New" },
        points: 0,
        config: { code: "NAJD2030" },
        itemId: foreign,
      });
      expect(made.json().code).toBe("invalid_item");
      const removed = await newItem(event);
      await owner("UPDATE quest_item SET status = 'removed' WHERE id = $1", [removed]);
      const group = await dashboard(
        editorCookie,
        "PATCH",
        `/events/${event}/categories/${category}`,
        { itemId: removed, confirm: true },
      );
      expect(group.json().code).toBe("invalid_item");
    });
  });

  describe("what the player and the desk see", () => {
    it("answers the item and the bonus's item with the completion, and the source in the player's items", async () => {
      const { id: event, category } = await newEvent();
      const item = await newItem(event);
      const groupItem = await newItem(event, 0);
      await owner("UPDATE category SET item_id = $2 WHERE id = $1", [category, groupItem]);
      const quest = await newQuest(event, category, item);
      const player = await newPlayer(event);
      const done = await complete(player.token, quest);
      expect(done.json()).toMatchObject({
        points: 50,
        item: {
          name: { en: "T-shirt", ar: "قميص" },
          outcome: "pending",
          until: { timeZone: "Asia/Riyadh" },
        },
        bonus: {
          categoryId: category,
          points: 0,
          item: { name: { en: "T-shirt" }, outcome: "out_of_stock", until: null },
        },
      });
      const shop = await asPlayer(player.token, `/v1/events/${event}/shop`);
      expect(shop.json().redemptions).toMatchObject([
        { kind: "item", price: 0, status: "reserved", source: "quest", name: { en: "T-shirt" } },
      ]);
      const cancel = await asPlayer(
        player.token,
        `/v1/redemptions/${shop.json().redemptions[0].id}/cancel`,
        "POST",
      );
      expect(cancel.json().code).toBe("rank_prize");
    });

    it("labels the item at the desk and answers the removal's item; lists the misses", async () => {
      const { id: event, category } = await newEvent();
      const item = await newItem(event, 1);
      const quest = await newQuest(event, category, item);
      const winner = await newPlayer(event);
      const late = await newPlayer(event);
      await complete(winner.token, quest);
      await complete(late.token, quest);
      const desk = await newPlayer(event);
      await owner(
        "INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities) VALUES ($1, $2, $3, '{hand_over}')",
        [organizer, event, desk.id],
      );
      const [name] = await owner<{ username: string }>(
        "SELECT username FROM player WHERE id = $1",
        [winner.id],
      );
      const found = await asPlayer(desk.token, `/v1/operator/events/${event}/desk/find`, "POST", {
        query: name?.username,
      });
      expect(found.json().items).toMatchObject([{ kind: "item", source: "quest", rank: null }]);
      const misses = await dashboard(
        editorCookie,
        "GET",
        `/events/${event}/quest-items/${item}/misses`,
      );
      expect(misses.json().misses).toMatchObject([
        { source: "quest", sourceName: { en: "Code" }, reason: "out_of_stock" },
      ]);
      const [entry] = await owner<{ id: string }>(
        "SELECT id FROM ledger_entry WHERE enrollment_id = $1 AND kind = 'quest'",
        [winner.enrollment],
      );
      const removed = await dashboard(
        editorCookie,
        "POST",
        `/events/${event}/entries/${entry?.id}/remove`,
        { reason: "Played twice" },
      );
      expect(removed.json()).toMatchObject({ scoreDelta: -50, item: "cancelled" });
    });

    it("lists a category's misses newest first, with the player's name, avatar and why", async () => {
      const { id: event, category } = await newEvent();
      const item = await newItem(event, 0);
      const named = await newPlayer(event);
      const gone = await newPlayer(event);
      await owner(
        `INSERT INTO quest_item_miss (organizer_id, event_id, enrollment_id, quest_item_id, source_category_id,
                                      source_period, reason, created_at)
         VALUES ($1, $2, $3, $5, $6, now(), 'claim_closed', now() - interval '1 minute'),
                ($1, $2, $4, $5, $6, now(), 'out_of_stock', now())`,
        [organizer, event, named.enrollment, gone.enrollment, item, category],
      );
      await owner(
        "UPDATE player SET status = 'deleted', deleted_at = now(), username = NULL WHERE id = $1",
        [gone.id],
      );
      const [player] = await owner<{ username: string; avatar: string }>(
        "SELECT username, avatar FROM player WHERE id = $1",
        [named.id],
      );
      const misses = await dashboard(
        editorCookie,
        "GET",
        `/events/${event}/quest-items/${item}/misses`,
      );
      expect(misses.json().misses).toEqual([
        {
          username: null,
          avatar: expect.any(String),
          at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
          source: "category",
          sourceName: { ar: null, en: "General" },
          reason: "out_of_stock",
        },
        {
          username: player?.username,
          avatar: player?.avatar,
          at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
          source: "category",
          sourceName: { ar: null, en: "General" },
          reason: "claim_closed",
        },
      ]);
    });
  });
});
