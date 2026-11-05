import { randomUUID } from "node:crypto";
import {
  achievementsAdminListSchema,
  amountsAdminSchema,
  gemShopAdminListSchema,
  levelTitlesAdminSchema,
  templatesAdminListSchema,
  type TemplateAdmin,
} from "@questify/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createStaff,
  signInConsole,
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
type Json = Record<string, unknown>;

const docOf = (template: TemplateAdmin): Json => ({
  name: template.name,
  description: template.description,
  body: template.body,
  enabled: template.enabled,
});
const title = (levelFrom: number, ar: string, en: string) => ({ levelFrom, name: { ar, en } });

/**
 * The console's catalog editors over HTTP (T-709b, T-709c, FR-1403): admin-only (404 to everyone else), every body checked by the
 * shared schema before the door, a save audited with the fields before and after, and a revert that puts the earlier fields
 * back through the same checks and can itself be reverted.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("console catalog editors over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let adminId: string;
  let adminCookie: string;
  let memberCookie: string;
  let strangerCookie: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db);
    adminId = await createStaff(db.owner, { email: "admin@questify.test", admin: true });
    const memberId = await createStaff(db.owner, { email: "owner@najd.test" });
    await createStaff(db.owner, { email: "stranger@najd.test" });
    const [org] = (
      await db.owner.query<{ id: string }>(
        "INSERT INTO organizer (name, slug) VALUES ('Najd Events', 'najd') RETURNING id",
      )
    ).rows;
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [org?.id, memberId],
    );
    adminCookie = await signInConsole(test, "admin@questify.test");
    memberCookie = await signInFully(test, "owner@najd.test");
    strangerCookie = await signInFully(test, "stranger@najd.test");
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  const call = (method: Method, url: string, cookie: string, payload?: object, key?: string) =>
    test.app.inject({
      method,
      url,
      headers: withSession(cookie, { "idempotency-key": key ?? randomUUID() }, url),
      ...(payload === undefined ? {} : { payload }),
    });
  const admin = (method: Method, url: string, payload?: object, key?: string) =>
    call(method, url, adminCookie, payload, key);
  const audits = async (action: string, target: string) =>
    (
      await db.owner.query<{ actor_id: string; before: Json | null; after: Json }>(
        "SELECT actor_id, before, after FROM audit_log WHERE action = $1 AND target_id = $2 ORDER BY id",
        [action, target],
      )
    ).rows;
  /** Waits until a backend running `fragment` is waiting on a lock. */
  const waitsOnLock = async (fragment: string): Promise<void> => {
    for (let tries = 0; tries < 100; tries += 1) {
      const { rows } = await db.owner.query(
        `SELECT 1 FROM pg_stat_activity
         WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE $1`,
        [`%${fragment}%`],
      );
      if (rows.length > 0) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`nothing waited on a lock in ${fragment}`);
  };
  const templates = async (): Promise<TemplateAdmin[]> =>
    templatesAdminListSchema.parse((await admin("GET", "/v1/admin/catalog/templates")).json())
      .templates;

  describe("who may ask", () => {
    it("answers 404 to a member and a stranger and 401 or 403 to nobody signed in, on every route", async () => {
      const paths: [Method, string, object?][] = [
        ["GET", "/v1/admin/catalog/templates"],
        ["PUT", "/v1/admin/catalog/templates/conference", {}],
        ["POST", "/v1/admin/catalog/templates/conference/revert", {}],
        ["GET", "/v1/admin/catalog/achievements"],
        ["PUT", "/v1/admin/catalog/achievements/quests-done", {}],
        ["POST", "/v1/admin/catalog/achievements/quests-done/revert", {}],
        ["GET", "/v1/admin/catalog/level-titles"],
        ["PUT", "/v1/admin/catalog/level-titles", {}],
        ["POST", "/v1/admin/catalog/level-titles/revert", {}],
        ["GET", "/v1/admin/catalog/gem-shop"],
        ["PUT", "/v1/admin/catalog/gem-shop/shop-map-reader", {}],
        ["POST", "/v1/admin/catalog/gem-shop/shop-map-reader/revert", {}],
        ["GET", "/v1/admin/catalog/amounts"],
        ["PUT", "/v1/admin/catalog/amounts", {}],
        ["POST", "/v1/admin/catalog/amounts/revert", {}],
      ];
      for (const cookie of [memberCookie, strangerCookie]) {
        for (const [method, url, payload] of paths) {
          expect((await call(method, url, cookie, payload)).statusCode, `${method} ${url}`).toBe(
            404,
          );
        }
      }
      for (const [method, url, payload] of paths) {
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
  });

  describe("reads at once", () => {
    it("answers every tab an admin opens at the same moment, not 429 for the one that lost the race", async () => {
      const tabs = ["templates", "achievements", "amounts", "level-titles", "gem-shop", "xp-table"];
      for (let round = 0; round < 3; round += 1) {
        const answers = await Promise.all(
          tabs.map((tab) => admin("GET", `/v1/admin/catalog/${tab}`)),
        );
        expect(answers.map((answer) => answer.statusCode)).toEqual(tabs.map(() => 200));
      }
    });
  });

  describe("event templates", () => {
    it("lists the shipped templates, never cached, none revertible yet", async () => {
      const answer = await admin("GET", "/v1/admin/catalog/templates");
      expect(answer.statusCode).toBe(200);
      expect(answer.headers["cache-control"]).toMatch(/no-store/);
      const rows = await templates();
      expect(rows.map((row) => row.key)).toEqual(["conference", "festival", "campus", "corporate"]);
      expect(rows.every((row) => !row.revertible)).toBe(true);
    });

    it("saves an edit, audits who changed what, and reverts it and the revert", async () => {
      const original = (await templates()).find((row) => row.key === "festival") as TemplateAdmin;
      const edited = { ...docOf(original), name: { ar: "مهرجان", en: "Festival Plus" } };
      const saved = await admin("PUT", "/v1/admin/catalog/templates/festival", edited);
      expect(saved.statusCode).toBe(200);
      expect((saved.json() as { template: TemplateAdmin }).template).toMatchObject({
        key: "festival",
        name: { en: "Festival Plus" },
        revertible: true,
      });
      const [entry] = await audits("catalog.template.update", "festival");
      expect(entry?.actor_id).toBe(adminId);
      expect(entry?.before?.["name"]).toEqual(original.name);
      expect(entry?.after["name"]).toEqual({ ar: "مهرجان", en: "Festival Plus" });

      const reverted = await admin("POST", "/v1/admin/catalog/templates/festival/revert", {});
      expect(reverted.statusCode).toBe(200);
      expect((reverted.json() as { template: TemplateAdmin }).template.name).toEqual(original.name);
      expect((await audits("catalog.template.revert", "festival")).length).toBe(1);

      const again = await admin("POST", "/v1/admin/catalog/templates/festival/revert", {});
      expect((again.json() as { template: TemplateAdmin }).template.name.en).toBe("Festival Plus");
    });

    it("refuses a body that fails the template schema, a switched-off quest type, and unsafe text, with the issues", async () => {
      const original = (await templates()).find((row) => row.key === "campus") as TemplateAdmin;
      const base = docOf(original);
      const body = original.body as { categories: { quests: Json[] }[] };
      const quiz = structuredClone(body);
      const [category] = quiz.categories;
      const [firstQuest] = category?.quests ?? [];
      expect(firstQuest).toBeDefined();
      (firstQuest as Json)["type"] = "quiz";
      const bidi = { ...base, name: { ar: "اسم", en: `Na${String.fromCharCode(0x202e)}me` } };
      const swapped = { ...base, name: { ar: "Name", en: "Name" } };
      for (const payload of [
        { ...base, body: quiz },
        { ...base, body: { config: {} } },
        { ...base, enabled: "yes" },
        bidi,
        swapped,
        { ...base, extra: true },
      ]) {
        const answer = await admin("PUT", "/v1/admin/catalog/templates/campus", payload);
        expect(answer.statusCode, JSON.stringify(payload).slice(0, 80)).toBe(422);
        const problem = answer.json() as { code: string; details: { issues: unknown[] } };
        expect(problem.code).toBe("invalid_catalog");
        expect(problem.details.issues.length).toBeGreaterThan(0);
      }
      expect((await audits("catalog.template.update", "campus")).length).toBe(0);
    });

    it("makes a new template, switches it off by an edit, and has nothing to revert on a new one", async () => {
      const corporate = (await templates()).find((row) => row.key === "corporate") as TemplateAdmin;
      const created = await admin("PUT", "/v1/admin/catalog/templates/summit", {
        ...docOf(corporate),
        name: { ar: "قمة", en: "Summit" },
      });
      expect(created.statusCode).toBe(200);
      expect((await templates()).at(-1)?.key).toBe("summit");
      const revert = await admin("POST", "/v1/admin/catalog/templates/summit/revert", {});
      expect(revert.statusCode).toBe(409);
      expect((revert.json() as { code: string }).code).toBe("nothing_to_revert");
      const off = await admin("PUT", "/v1/admin/catalog/templates/summit", {
        ...docOf(corporate),
        name: { ar: "قمة", en: "Summit" },
        enabled: false,
      });
      expect((off.json() as { template: TemplateAdmin }).template.enabled).toBe(false);
    });

    it("answers 409 stale when another admin changes the template after the revert read its latest entry", async () => {
      const original = (await templates()).find((row) => row.key === "campus") as TemplateAdmin;
      await admin("PUT", "/v1/admin/catalog/templates/campus", {
        ...docOf(original),
        name: { ar: "حرم", en: "Campus One" },
      });
      const holder = await connectAsOwner(db);
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT 1 FROM event_template WHERE key = 'campus' FOR UPDATE");
        const revert = admin("POST", "/v1/admin/catalog/templates/campus/revert", {});
        await waitsOnLock("admin_template_save");
        await holder.query(
          `INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, before, after)
           VALUES ('admin', $1, 'catalog.template.update', 'event_template', 'campus', '{}', '{}')`,
          [adminId],
        );
        await holder.query("COMMIT");
        const answer = await revert;
        expect(answer.statusCode).toBe(409);
        expect((answer.json() as { code: string }).code).toBe("stale");
      } finally {
        await holder.end();
      }
      expect((await templates()).find((row) => row.key === "campus")?.name.en).toBe("Campus One");
    });

    it("refuses a key that is not one, and a repeated revert with the same key changes once", async () => {
      expect((await admin("PUT", "/v1/admin/catalog/templates/Bad-Key", {})).statusCode).toBe(400);
      const key = randomUUID();
      const original = (await templates()).find((row) => row.key === "conference") as TemplateAdmin;
      await admin("PUT", "/v1/admin/catalog/templates/conference", {
        ...docOf(original),
        description: { ar: "وصف جديد", en: "A new description" },
      });
      const first = await admin("POST", "/v1/admin/catalog/templates/conference/revert", {}, key);
      const second = await admin("POST", "/v1/admin/catalog/templates/conference/revert", {}, key);
      expect(second.json()).toEqual(first.json());
      expect((await audits("catalog.template.revert", "conference")).length).toBe(1);
    });
  });

  describe("achievements", () => {
    const URL = "/v1/admin/catalog/achievements/quests-done";

    it("saves a name and a raise, answers 409 with the gems for a lowering until confirmed, and reverts", async () => {
      const list = achievementsAdminListSchema.parse(
        (await admin("GET", "/v1/admin/catalog/achievements")).json(),
      ).achievements;
      expect(list).toHaveLength(5);
      const original = list.find((row) => row.id === "quests-done");
      const doc = {
        name: { ar: "صائد المهام", en: "Quest Hunter Pro" },
        bronze: original?.bronze,
        silver: (original?.silver ?? 0) + 10,
        gold: original?.gold,
      };
      const saved = await admin("PUT", URL, doc);
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toMatchObject({ achievement: { ...doc, revertible: true } });
      const lower = { ...doc, bronze: 1, gold: (original?.gold ?? 0) - 1 };
      const asked = await admin("PUT", URL, lower);
      expect(asked.statusCode).toBe(409);
      expect(asked.json()).toMatchObject({
        code: "confirmation_required",
        details: { gems: { bronze: 10, gold: 50 } },
      });
      expect((await admin("PUT", URL, { ...lower, confirmed: false })).statusCode).toBe(409);
      const paid = await admin("PUT", URL, { ...lower, confirmed: true });
      expect(paid.json()).toMatchObject({ achievement: { bronze: 1 } });
      const revertAsk = await admin("POST", `${URL}/revert`, {});
      expect(revertAsk.statusCode).toBe(200);
      expect(revertAsk.json()).toMatchObject({ achievement: { bronze: original?.bronze } });
      const undoRaise = await admin("POST", `${URL}/revert`, {});
      expect(undoRaise.statusCode).toBe(409);
      expect(undoRaise.json()).toMatchObject({ details: { gems: { bronze: 10, gold: 50 } } });
      expect((await admin("POST", `${URL}/revert`, { confirmed: true })).statusCode).toBe(200);
      expect(
        (await admin("PUT", "/v1/admin/catalog/achievements/nothing-here", doc)).statusCode,
      ).toBe(404);
    });

    it.each([
      { bronze: 5, silver: 5, gold: 10 },
      { bronze: 0, silver: 5, gold: 10 },
      { bronze: 1.5, silver: 5, gold: 10 },
      { bronze: 1, silver: 5 },
      { bronze: 1, silver: 5, gold: 10, confirmed: "yes" },
      { bronze: 1, silver: 5, gold: 10, threshold: 2 },
    ])("refuses %j before the door", async (extra) => {
      const refused = await admin("PUT", URL, { name: { ar: "مهام", en: "Quests" }, ...extra });
      expect(refused.statusCode, JSON.stringify(extra)).toBeGreaterThanOrEqual(400);
      expect(refused.statusCode, JSON.stringify(extra)).toBeLessThan(500);
    });

    it("takes no confirmation on another editor's revert", async () => {
      const refused = await admin("POST", "/v1/admin/catalog/level-titles/revert", {
        confirmed: true,
      });
      expect(refused.statusCode).toBe(400);
    });
  });

  describe("amounts", () => {
    const URL = "/v1/admin/catalog/amounts";

    it("reads the amounts in force, saves a change with its audit, refuses one out of range, and reverts", async () => {
      const shown = amountsAdminSchema.parse((await admin("GET", URL)).json());
      expect(shown).toMatchObject({
        xp: { questXp: 100, dailyFinishXp: 20, dailyRightXp: 10, dailyWordXp: 50 },
        gems: { levelUp: 20, bronze: 10, silver: 25, gold: 50 },
        stored: { xp: true, gems: false },
        revertible: false,
      });
      const doc = { xp: shown.xp, gems: { ...shown.gems, levelUp: 30 } };
      const saved = await admin("PUT", URL, doc);
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toMatchObject({ ...doc, stored: { gems: true }, revertible: true });
      const [entry] = await audits("catalog.amounts.update", "amounts");
      expect(entry).toMatchObject({ actor_id: adminId, after: doc });
      for (const bad of [
        { ...doc, gems: { ...doc.gems, levelUp: 1001 } },
        { ...doc, xp: { ...doc.xp, dailyWordXp: 1001 } },
        { ...doc, gems: { ...doc.gems, extra: 1 } },
        { xp: doc.xp },
      ]) {
        expect((await admin("PUT", URL, bad)).statusCode, JSON.stringify(bad)).toBe(422);
      }
      const key = randomUUID();
      const reverted = await admin("POST", `${URL}/revert`, {}, key);
      expect(reverted.json()).toMatchObject({ gems: { levelUp: 20 } });
      expect((await admin("POST", `${URL}/revert`, {}, key)).json()).toEqual(reverted.json());
      expect((await audits("catalog.amounts.revert", "amounts")).length).toBe(1);
    });
  });

  describe("level titles", () => {
    it("saves the whole set, refuses a set without level 1, and reverts", async () => {
      const first = levelTitlesAdminSchema.parse(
        (await admin("GET", "/v1/admin/catalog/level-titles")).json(),
      );
      expect(first.titles.map((row) => row.levelFrom)).toEqual([1, 6, 11, 16, 21, 26]);
      const saved = await admin("PUT", "/v1/admin/catalog/level-titles", {
        titles: [title(1, "مبتدئ", "Rookie"), title(8, "ماهر", "Skilled")],
      });
      expect(saved.statusCode).toBe(200);
      expect(levelTitlesAdminSchema.parse(saved.json())).toMatchObject({ revertible: true });
      const refused = await admin("PUT", "/v1/admin/catalog/level-titles", {
        titles: [title(2, "ماهر", "Skilled")],
      });
      expect(refused.statusCode).toBe(422);
      const reverted = await admin("POST", "/v1/admin/catalog/level-titles/revert", {});
      expect(levelTitlesAdminSchema.parse(reverted.json()).titles).toEqual(first.titles);
      expect((await audits("catalog.level_titles.update", "all")).length).toBe(1);
    });
  });

  describe("gem shop", () => {
    it("saves price, status and place, refuses what is out of range, and reverts", async () => {
      const list = gemShopAdminListSchema.parse(
        (await admin("GET", "/v1/admin/catalog/gem-shop")).json(),
      ).items;
      expect(list).toHaveLength(12);
      const saved = await admin("PUT", "/v1/admin/catalog/gem-shop/shop-star-navigator", {
        price: 95,
        status: "retired",
        position: 2,
      });
      expect(saved.json()).toMatchObject({
        item: { itemId: "shop-star-navigator", price: 95, status: "retired", revertible: true },
      });
      for (const payload of [
        { price: 0, status: "active", position: 1 },
        { price: 10, status: "free", position: 1 },
        { price: 10, status: "active", position: 1001 },
        { price: 1.5, status: "active", position: 1 },
      ]) {
        const answer = await admin(
          "PUT",
          "/v1/admin/catalog/gem-shop/shop-star-navigator",
          payload,
        );
        expect(answer.statusCode, JSON.stringify(payload)).toBe(422);
      }
      const reverted = await admin(
        "POST",
        "/v1/admin/catalog/gem-shop/shop-star-navigator/revert",
        {},
      );
      expect(reverted.json()).toMatchObject({
        item: { price: 80, status: "active", position: 6, revertible: true },
      });
      expect(
        (
          await admin("PUT", "/v1/admin/catalog/gem-shop/level-4", {
            price: 5,
            status: "active",
            position: 1,
          })
        ).statusCode,
      ).toBe(404);
    });
  });
});
