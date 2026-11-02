import { randomUUID } from "node:crypto";
import {
  itemAdminAnswerSchema,
  itemsAdminListSchema,
  xpTableAdminSchema,
  xpTablePreviewSchema,
  type XpTableAdmin,
} from "@questify/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createStaff,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import {
  TEST_DATABASE_URL,
  connectAsOwner,
  createTestDatabase,
  type TestDatabase,
} from "#test/support/test-db";

type Method = "GET" | "PUT" | "POST";

const docOf = (table: XpTableAdmin) => ({
  levels: table.levels.map(({ level, xpFrom, itemId }) => ({ level, xpFrom, itemId })),
});
const NAME = { ar: "إطار الفجر", en: "Dawn frame" };

/**
 * The XP table and item editors over HTTP (T-709d, FR-1403, ADR-440, ADR-441): admin-only (404 to everyone else), each body
 * checked by the shared schema before the door, a lowering answered 409 `confirmation_required` with the levels and the
 * gems until confirmed, the door's refusals as their own 409 codes with the level, a busy table as 503 with Retry-After,
 * the preview as a read, a new item as 201, and idempotent reverts.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("console XP table and items over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let adminCookie: string;
  let memberCookie: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db);
    await createStaff(db.owner, { email: "admin@questify.test", admin: true });
    await createStaff(db.owner, { email: "stranger@najd.test" });
    adminCookie = await signInFully(test, "admin@questify.test");
    memberCookie = await signInFully(test, "stranger@najd.test");
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  const call = (method: Method, url: string, cookie: string, payload?: object, key?: string) =>
    test.app.inject({
      method,
      url,
      headers: withSession(cookie, { "idempotency-key": key ?? randomUUID() }),
      ...(payload === undefined ? {} : { payload }),
    });
  const admin = (method: Method, url: string, payload?: object, key?: string) =>
    call(method, url, adminCookie, payload, key);
  const table = async () =>
    xpTableAdminSchema.parse((await admin("GET", "/v1/admin/catalog/xp-table")).json());
  const URL = "/v1/admin/catalog/xp-table";

  it("answers 404 to a stranger and 401 or 403 to nobody signed in, on every new route", async () => {
    const paths: [Method, string, object?][] = [
      ["GET", URL],
      ["PUT", URL, {}],
      ["POST", `${URL}/preview`, {}],
      ["POST", `${URL}/revert`, {}],
      ["GET", "/v1/admin/catalog/items"],
      ["POST", "/v1/admin/catalog/items", {}],
      ["PUT", "/v1/admin/catalog/items/level-2", {}],
      ["POST", "/v1/admin/catalog/items/level-2/revert", {}],
    ];
    for (const [method, url, payload] of paths) {
      expect((await call(method, url, memberCookie, payload)).statusCode, `${method} ${url}`).toBe(
        404,
      );
      const anonymous = await test.app.inject({
        method,
        url,
        headers: { "idempotency-key": randomUUID() },
        ...(payload === undefined ? {} : { payload }),
      });
      expect(anonymous.statusCode, `${method} ${url}`).toBeGreaterThanOrEqual(401);
      expect(anonymous.statusCode, `${method} ${url}`).toBeLessThanOrEqual(403);
    }
  });

  describe("the XP table", () => {
    it("lists the curve, previews a lowering, asks to confirm it with the levels and gems, saves and reverts", async () => {
      const shown = await table();
      expect(shown.levels).toHaveLength(30);
      expect(shown.revertible).toBe(false);
      const original = docOf(shown);
      const lower = {
        levels: original.levels.map((row) => (row.level === 3 ? { ...row, xpFrom: 300 } : row)),
      };
      const preview = await admin("POST", `${URL}/preview`, lower);
      expect(preview.statusCode).toBe(200);
      expect(xpTablePreviewSchema.parse(preview.json())).toMatchObject({ levelUp: 20 });
      const asked = await admin("PUT", URL, lower);
      expect(asked.statusCode).toBe(409);
      expect(asked.json()).toMatchObject({
        code: "confirmation_required",
        details: { levels: [3], levelUp: 20 },
      });
      const saved = await admin("PUT", URL, { ...lower, confirmed: true });
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toMatchObject({ revertible: true });
      const key = randomUUID();
      const reverted = await admin("POST", `${URL}/revert`, {}, key);
      expect(reverted.statusCode).toBe(200);
      expect(docOf(xpTableAdminSchema.parse(reverted.json()))).toEqual(original);
      expect((await admin("POST", `${URL}/revert`, {}, key)).statusCode).toBe(200);
      expect(
        (
          await db.owner.query(
            "SELECT count(*)::int AS n FROM audit_log WHERE action = 'catalog.xp_table.revert'",
          )
        ).rows,
      ).toEqual([{ n: 1 }]);
    });

    it("refuses a table that fails the shared schema before the door", async () => {
      const original = docOf(await table());
      for (const body of [
        { levels: original.levels.slice(0, 1) },
        { levels: original.levels.map((row) => (row.level === 4 ? { ...row, xpFrom: 1 } : row)) },
        { levels: original.levels.map((row) => (row.level === 1 ? { ...row, itemId: "x" } : row)) },
        { ...original, extra: true },
        { ...original, confirmed: "yes" },
      ]) {
        const refused = await admin("PUT", URL, body);
        expect(refused.statusCode, JSON.stringify(body).slice(0, 80)).toBeGreaterThanOrEqual(400);
        expect(refused.statusCode).toBeLessThan(500);
        expect((await admin("POST", `${URL}/preview`, body)).statusCode).toBeGreaterThanOrEqual(
          400,
        );
      }
    });

    it("answers the door's refusals as their own 409 codes with the level", async () => {
      const original = docOf(await table());
      const remap = {
        levels: original.levels.map((row) =>
          row.level === 30 ? { ...row, itemId: "shop-map-reader" } : row,
        ),
      };
      const refused = await admin("PUT", URL, remap);
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ code: "item_has_source", details: { level: 30 } });
      const unknown = await admin("PUT", URL, {
        levels: original.levels.map((row) => (row.level === 30 ? { ...row, itemId: "nope" } : row)),
      });
      expect(unknown.json()).toMatchObject({ code: "item_unknown", details: { level: 30 } });
    });

    it("answers 503 busy with Retry-After when the table stays locked past the save's budget", async () => {
      const original = docOf(await table());
      const holder = await connectAsOwner(db);
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT 1 FROM xp_level WHERE level = 1 FOR KEY SHARE");
        const started = performance.now();
        const busy = await admin("PUT", URL, {
          levels: original.levels.map((row) =>
            row.level === 30 ? { ...row, xpFrom: 50_000 } : row,
          ),
        });
        expect(busy.statusCode).toBe(503);
        expect(busy.headers["retry-after"]).toBe("2");
        expect(busy.json()).toMatchObject({ code: "busy" });
        expect(performance.now() - started).toBeLessThan(1800);
      } finally {
        await holder.query("ROLLBACK");
        await holder.end();
      }
    });
  });

  describe("items", () => {
    const ITEMS = "/v1/admin/catalog/items";

    it("lists items, makes one (201) and refuses its id twice, and edits names and art", async () => {
      const list = itemsAdminListSchema.parse((await admin("GET", ITEMS)).json()).items;
      expect(list.find((row) => row.id === "shop-map-reader")).toMatchObject({
        locked: { art: "on_sale" },
        revertible: false,
      });
      const made = await admin("POST", ITEMS, {
        id: "dawn-frame",
        kind: "frame",
        name: NAME,
        visualKey: "frame-07",
        shop: { price: 90, position: 50, status: "active" },
      });
      expect(made.statusCode).toBe(201);
      expect(itemAdminAnswerSchema.parse(made.json()).item).toMatchObject({
        source: { shop: { status: "active" } },
      });
      const again = await admin("POST", ITEMS, {
        id: "dawn-frame",
        kind: "frame",
        name: NAME,
        visualKey: "frame-07",
      });
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({ code: "item_exists" });
      const art = await admin("PUT", `${ITEMS}/dawn-frame`, { name: NAME, visualKey: "frame-08" });
      expect(art.json()).toMatchObject({ code: "item_on_sale" });
      const renamed = { ar: "إطار الشروق", en: "Sunrise frame" };
      const named = await admin("PUT", `${ITEMS}/dawn-frame`, {
        name: renamed,
        visualKey: "frame-07",
      });
      expect(named.statusCode).toBe(200);
      expect(named.json()).toMatchObject({ item: { name: renamed, revertible: true } });
      expect((await admin("POST", `${ITEMS}/dawn-frame/revert`, {})).json()).toMatchObject({
        item: { name: NAME },
      });
      expect((await admin("POST", `${ITEMS}/dawn-frame/revert`, {})).statusCode).toBe(200);
      const plain = await admin("POST", ITEMS, {
        id: "plain-title",
        kind: "title",
        name: NAME,
        visualKey: null,
      });
      expect(plain.statusCode).toBe(201);
      const nothing = await admin("POST", `${ITEMS}/plain-title/revert`, {});
      expect(nothing.statusCode).toBe(409);
      expect(nothing.json()).toMatchObject({ code: "nothing_to_revert" });
    });

    it("refuses bodies that fail the shared schema before the door", async () => {
      for (const body of [
        { id: "souvenir-abc", kind: "title", name: NAME, visualKey: null },
        { id: "bad art", kind: "frame", name: NAME, visualKey: "frame-01" },
        { id: "wrong-art", kind: "frame", name: NAME, visualKey: "chest" },
        { id: "no-name", kind: "title", visualKey: null },
      ]) {
        expect((await admin("POST", ITEMS, body)).statusCode).toBeGreaterThanOrEqual(400);
      }
      expect(
        (
          await admin("PUT", `${ITEMS}/level-2`, {
            name: NAME,
            visualKey: "frame-01",
            kind: "frame",
          })
        ).statusCode,
      ).toBeGreaterThanOrEqual(400);
      expect(
        (await admin("PUT", `${ITEMS}/souvenir-${"0".repeat(32)}`, { name: NAME, visualKey: null }))
          .statusCode,
      ).toBe(404);
    });
  });
});
