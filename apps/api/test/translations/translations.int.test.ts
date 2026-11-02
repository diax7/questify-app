import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MESSAGES, NO_OVERRIDES, createTranslator, type Overrides } from "@questify/shared";
import { withRequestContext } from "#src/db/context";
import type { PublicAccount } from "#src/auth/staff-store";
import { createTranslationService, type TranslationService } from "#src/translations/service";
import {
  createStaff,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

describe.skipIf(TEST_DATABASE_URL === undefined)("translation store", () => {
  let db: TestDatabase;
  let test: TestApp;
  let pool: Pool;
  let service: TranslationService;
  let admin: PublicAccount;
  let regular: PublicAccount;
  const clock = { now: 1_000_000 };

  beforeAll(async () => {
    db = await createTestDatabase();
    const adminId = await createStaff(db.owner, { email: "root@questify.test", admin: true });
    const regularId = await createStaff(db.owner, { email: "editor@najd.test" });
    admin = { id: adminId, email: "root@questify.test", status: "active", platformRole: "admin" };
    regular = { id: regularId, email: "editor@najd.test", status: "active", platformRole: "none" };
    pool = new Pool({ connectionString: db.appUrl, max: 4 });
    service = createTranslationService({ pool, ttlMs: 15_000, now: () => clock.now });
    test = await startApp(db, false, {}, { translations: service });
  });
  afterAll(async () => {
    await test.close();
    await pool.end();
    await db.close();
  });

  const owner = <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
    db.owner.query<T>(sql, values).then((result) => result.rows);

  const entries = () =>
    owner<{
      actor_id: string;
      action: string;
      target_id: string;
      before: unknown;
      after: unknown;
    }>(
      `SELECT actor_id, action, target_id, before, after FROM audit_log
       WHERE action = 'translation.update' ORDER BY id`,
    );

  const getBundle = (headers: Record<string, string> = {}) =>
    test.app.inject({ method: "GET", url: "/v1/translations", headers });

  const bundleOf = async (): Promise<Overrides> => (await getBundle()).json<Overrides>();

  const asRegular = <T>(sql: string) =>
    withRequestContext(
      db.app,
      { staffUserId: regular.id },
      async () => (await db.app.query(sql)).rows as T[],
    );

  const reset = async (): Promise<void> => {
    await owner("DELETE FROM translation");
    clock.now += 1_000_000;
  };

  describe("what an app downloads", () => {
    it("is empty when no one changed a text, so every text is the shipped one", async () => {
      await reset();
      const response = await getBundle();
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ ar: {}, en: {} });
      expect(response.headers["cache-control"]).toBe("no-cache");
      expect(response.headers["etag"]).toMatch(/^"[0-9a-f]{32}"$/);
    });

    it("answers 304 when the app already has this bundle", async () => {
      const first = await getBundle();
      const etag = String(first.headers["etag"]);
      const again = await getBundle({ "if-none-match": etag });
      expect(again.statusCode).toBe(304);
      expect(again.body).toBe("");
      expect((await getBundle({ "if-none-match": '"other"' })).statusCode).toBe(200);
    });
  });

  describe("saving a text", () => {
    it("changes one language and leaves the other shipped", async () => {
      await reset();
      expect(await service.save(admin, "nav.home", { en: "Start" })).toMatchObject({ ok: true });
      expect(await bundleOf()).toEqual({ ar: {}, en: { "nav.home": "Start" } });
    });

    it("changes both languages at once", async () => {
      await reset();
      await service.save(admin, "nav.home", { ar: "البداية", en: "Start" });
      expect(await bundleOf()).toEqual({
        ar: { "nav.home": "البداية" },
        en: { "nav.home": "Start" },
      });
    });

    it("keeps the other language when one is changed again", async () => {
      await reset();
      await service.save(admin, "nav.home", { ar: "البداية", en: "Start" });
      await service.save(admin, "nav.home", { en: "Begin" });
      expect(await bundleOf()).toEqual({
        ar: { "nav.home": "البداية" },
        en: { "nav.home": "Begin" },
      });
    });

    it("goes back to the shipped text for a language when it is saved blank (FR-1766)", async () => {
      await reset();
      await service.save(admin, "nav.home", { ar: "البداية", en: "Start" });
      expect(await service.save(admin, "nav.home", { en: "   " })).toMatchObject({ ok: true });
      expect(await bundleOf()).toEqual({ ar: { "nav.home": "البداية" }, en: {} });
      expect(await service.save(admin, "nav.home", { ar: "" })).toMatchObject({ ok: true });
      expect(await owner("SELECT 1 FROM translation")).toEqual([]);
      expect(await bundleOf()).toEqual({ ar: {}, en: {} });
    });

    it("blanking a language that was never changed does nothing", async () => {
      await reset();
      expect(await service.save(admin, "nav.home", { en: "" })).toMatchObject({ ok: true });
      expect(await owner("SELECT 1 FROM translation")).toEqual([]);
    });

    it("writes Arabic-Indic digits as Western digits (FR-1507)", async () => {
      await reset();
      await service.save(admin, "common.loading", { ar: "انتظر ٣٠ ثانية" });
      expect((await bundleOf()).ar["common.loading"]).toBe("انتظر 30 ثانية");
    });

    it("records who made the change", async () => {
      await reset();
      await service.save(admin, "nav.home", { en: "Start" });
      const rows = await owner<{ updated_by: string }>("SELECT updated_by FROM translation");
      expect(rows[0]?.updated_by).toBe(admin.id);
    });

    it("changes the tag, and only when something changed", async () => {
      await reset();
      const before = String((await getBundle()).headers["etag"]);
      await service.save(admin, "nav.home", { en: "Start" });
      const after = String((await getBundle()).headers["etag"]);
      expect(after).not.toBe(before);
      await service.save(admin, "nav.home", { en: "Start" });
      expect(String((await getBundle()).headers["etag"])).toBe(after);
    });
  });

  describe("what is refused", () => {
    it("a save that removes a placeholder, naming it, and writes nothing (FR-1767)", async () => {
      await reset();
      expect(await service.save(admin, "quests.pointsShort", { en: "You have {points}" })).toEqual({
        ok: false,
        reason: "invalid",
        issues: [{ path: "en", message: "is missing {currency}" }],
      });
      expect(await owner("SELECT 1 FROM translation")).toEqual([]);
    });

    it("reports both languages at once and writes neither", async () => {
      await reset();
      const result = await service.save(admin, "quests.pointsShort", {
        ar: "لديك {points}",
        en: "You have {coins} {currency}",
      });
      expect(result).toMatchObject({ ok: false, reason: "invalid" });
      expect(result.ok === false && result.reason === "invalid" && result.issues).toEqual([
        { path: "ar", message: "is missing {currency}" },
        { path: "en", message: "is missing {points}" },
        { path: "en", message: "uses {coins}, which this text does not have" },
      ]);
      expect(await owner("SELECT 1 FROM translation")).toEqual([]);
    });

    it("accepts placeholders in another order", async () => {
      await reset();
      expect(
        await service.save(admin, "quests.pointsShort", { en: "{points} {currency}" }),
      ).toMatchObject({ ok: true });
    });

    it("a key the app does not have", async () => {
      await reset();
      expect(await service.save(admin, "nope.key", { en: "x" })).toEqual({
        ok: false,
        reason: "invalid",
        issues: [{ path: "key", message: "is not a text of the app" }],
      });
    });

    it.each([
      ["an empty body", {}],
      ["a number", { en: 5 }],
      ["a field it does not know", { en: "x", fr: "y" }],
      ["no body at all", null],
    ])("%s", async (_label, body) => {
      expect(await service.save(admin, "nav.home", body)).toEqual({
        ok: false,
        reason: "invalid",
        issues: [{ path: "body", message: "must have ar, en or both, as text" }],
      });
    });

    it("a save by someone who is not an active Questify admin", async () => {
      await reset();
      for (const who of [regular, { ...admin, status: "disabled" as const }]) {
        expect(await service.save(who, "nav.home", { en: "x" })).toEqual({
          ok: false,
          reason: "forbidden",
        });
      }
      expect(await owner("SELECT 1 FROM translation")).toEqual([]);
    });
  });

  describe("how fast a change reaches an app", () => {
    it("reaches another running copy of the server within the cache time, and not before", async () => {
      await reset();
      const other = createTranslationService({ pool, ttlMs: 15_000, now: () => clock.now });
      expect((await other.bundle()).overrides).toEqual({ ar: {}, en: {} });
      await service.save(admin, "nav.home", { en: "Start" });
      clock.now += 14_999;
      expect((await other.bundle()).overrides.en).toEqual({});
      clock.now += 1;
      expect((await other.bundle()).overrides.en).toEqual({ "nav.home": "Start" });
    });

    it("keeps a reading for 15 seconds when no cache time is given", async () => {
      await reset();
      const standard = createTranslationService({ pool, now: () => clock.now });
      await standard.bundle();
      await service.save(admin, "nav.home", { en: "Start" });
      clock.now += 14_999;
      expect((await standard.bundle()).overrides.en).toEqual({});
      clock.now += 1;
      expect((await standard.bundle()).overrides.en).toEqual({ "nav.home": "Start" });
    });

    it("reaches this copy at once when it was saved here, and is reused until then", async () => {
      await reset();
      await getBundle();
      await service.save(admin, "nav.home", { en: "Start" });
      expect((await bundleOf()).en).toEqual({ "nav.home": "Start" });
      await owner("UPDATE translation SET en = 'Changed behind its back'");
      expect((await bundleOf()).en).toEqual({ "nav.home": "Start" });
    });
  });

  describe("damaged or old stored data", () => {
    it("never reaches an app: unknown keys and texts that lost a placeholder are left out", async () => {
      await reset();
      await owner(
        `INSERT INTO translation (key, ar, en) VALUES
           ('old.removed.key', 'x', 'y'),
           ('quests.pointsShort', 'لديك {points} {currency}', 'You have gems'),
           ('nav.home', NULL, 'Start')`,
      );
      expect(await bundleOf()).toEqual({
        ar: { "quests.pointsShort": "لديك {points} {currency}" },
        en: { "nav.home": "Start" },
      });
    });
  });

  describe("what a person sees (FR-1768)", () => {
    it("is the shipped text for a key that is blank, missing, or when the store cannot be reached", async () => {
      await reset();
      await service.save(admin, "nav.home", { en: "Start" });
      const downloaded = await bundleOf();
      const t = createTranslator(MESSAGES, downloaded);
      expect(t("nav.home", "en")).toBe("Start");
      expect(t("nav.home", "ar")).toBe(MESSAGES["nav.home"].ar);
      expect(t("nav.shop", "en")).toBe(MESSAGES["nav.shop"].en);
      const offline = createTranslator(MESSAGES, NO_OVERRIDES);
      expect(offline("nav.home", "en")).toBe("Home");
    });

    it("shows numbers in Western digits in both languages", async () => {
      await reset();
      const t = createTranslator(MESSAGES, await bundleOf());
      expect(t("quests.pointsShort", "ar", { points: 20000, currency: "نقاط" })).toBe(
        "نقاط: 20,000",
      );
      expect(t("quests.pointsShort", "en", { points: 20000, currency: "Points" })).toBe(
        "Points: 20,000",
      );
    });
  });

  describe("the database rules", () => {
    it("lets only an admin write, change or delete a text", async () => {
      await reset();
      await expect(
        asRegular("INSERT INTO translation (key, en) VALUES ('nav.home', 'x')"),
      ).rejects.toThrow(/row-level security/);
      await owner("INSERT INTO translation (key, en) VALUES ('nav.home', 'x')");
      await asRegular("UPDATE translation SET en = 'hacked'");
      await asRegular("DELETE FROM translation");
      expect(await owner<{ en: string }>("SELECT en FROM translation")).toEqual([{ en: "x" }]);
    });

    it("lets anyone read the texts before signing in", async () => {
      const rows = await withRequestContext(
        db.app,
        {},
        async () => (await db.app.query("SELECT key FROM translation")).rows,
      );
      expect(rows).toHaveLength(1);
    });

    it("refuses a key that is not lower-case dotted words, a blank text, and a row with no text", async () => {
      await expect(
        owner("INSERT INTO translation (key, en) VALUES ('Bad Key', 'x')"),
      ).rejects.toThrow(/check/);
      await expect(
        owner("INSERT INTO translation (key, en) VALUES ('nav.two', '  ')"),
      ).rejects.toThrow(/check/);
      await expect(owner("INSERT INTO translation (key) VALUES ('nav.three')")).rejects.toThrow(
        /check/,
      );
    });

    it("lets the API change a text but never its key", async () => {
      await expect(
        withRequestContext(db.app, { isAdmin: true }, () =>
          db.app.query("UPDATE translation SET key = 'nav.renamed'"),
        ),
      ).rejects.toThrow(/permission denied/);
      await owner("DELETE FROM translation");
    });

    it("asks the database whether the account is still an active admin (T-702)", async () => {
      await owner("DELETE FROM translation");
      const retired = await createStaff(db.owner, { email: "retired@questify.test", admin: true });
      await owner("UPDATE staff_user SET platform_role = 'none' WHERE id = $1", [retired]);
      const asRetired = (sql: string) =>
        withRequestContext(db.app, { isAdmin: true, staffUserId: retired }, () =>
          db.app.query(sql),
        );
      await expect(
        asRetired("INSERT INTO translation (key, en) VALUES ('nav.home', 'x')"),
      ).rejects.toThrow(/row-level security/);
      await owner("INSERT INTO translation (key, en) VALUES ('nav.home', 'x')");
      expect((await asRetired("UPDATE translation SET en = 'hacked'")).rowCount).toBe(0);
      expect((await asRetired("DELETE FROM translation")).rowCount).toBe(0);
      expect(await owner<{ en: string }>("SELECT en FROM translation")).toEqual([{ en: "x" }]);
      await owner("DELETE FROM translation");
    });
  });

  describe("the console matrix (T-702)", () => {
    let cookie: string;
    const asAdmin = (method: "GET" | "PUT", url: string, payload?: unknown) =>
      test.app.inject({
        method,
        url: `/v1/admin/translations${url}`,
        headers: withSession(cookie),
        ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
      });

    beforeAll(async () => {
      cookie = await signInFully(test, "root@questify.test");
    });

    it("lists a searched key with its Arabic and English text (FR-1765)", async () => {
      await reset();
      const response = await asAdmin("GET", "?q=Skip%20to%20content");
      expect(response.statusCode).toBe(200);
      expect(response.headers["cache-control"]).toBe("no-store");
      const body = response.json<{ total: number; rows: { key: string; shipped: unknown }[] }>();
      expect(body.rows.map((row) => row.key)).toEqual(["dashNav.skip"]);
      expect(body.rows[0]?.shipped).toEqual(MESSAGES["dashNav.skip"]);
    });

    it("shows what was changed beside the shipped text, and filters to it", async () => {
      await reset();
      await owner("INSERT INTO translation (key, en) VALUES ('nav.home', 'Start')");
      const response = await asAdmin("GET", "?show=changed");
      const body = response.json<{ rows: { key: string; stored: unknown; shipped: unknown }[] }>();
      expect(body.rows).toEqual([
        expect.objectContaining({
          key: "nav.home",
          stored: { ar: null, en: "Start" },
          shipped: MESSAGES["nav.home"],
        }),
      ]);
    });

    it("pages and narrows by area, and refuses a query it does not know", async () => {
      const page = await asAdmin("GET", "?area=nav&limit=3&offset=2");
      const body = page.json<{ total: number; rows: unknown[]; areas: { area: string }[] }>();
      expect(body.rows).toHaveLength(3);
      expect(body.total).toBeGreaterThan(3);
      expect(body.areas.some((entry) => entry.area === "nav")).toBe(true);
      for (const query of [
        "?limit=0",
        "?limit=101",
        "?show=everything",
        "?area=Bad.Area",
        "?x=1",
      ]) {
        expect((await asAdmin("GET", query)).statusCode, query).toBe(400);
      }
    });

    it("saves an edit, returns the row, shows it in the bundle and audits who, key, before and after", async () => {
      await reset();
      const before = (await entries()).length;
      const saved = await asAdmin("PUT", "/nav.home", { en: "Start", ar: "البداية" });
      expect(saved.statusCode).toBe(200);
      expect(saved.json<{ row: { stored: unknown } }>().row.stored).toEqual({
        ar: "البداية",
        en: "Start",
      });
      expect(await bundleOf()).toEqual({
        ar: { "nav.home": "البداية" },
        en: { "nav.home": "Start" },
      });
      const made = (await entries()).slice(before);
      expect(made).toEqual([
        {
          actor_id: admin.id,
          action: "translation.update",
          target_id: "nav.home",
          before: { ar: null, en: null },
          after: { ar: "البداية", en: "Start" },
        },
      ]);
    });

    it("reverts to the shipped text with a blank value, and audits the way back", async () => {
      const before = (await entries()).length;
      const reverted = await asAdmin("PUT", "/nav.home", { ar: "", en: "" });
      expect(reverted.statusCode).toBe(200);
      expect(reverted.json<{ row: { stored: unknown } }>().row.stored).toEqual({
        ar: null,
        en: null,
      });
      expect(await bundleOf()).toEqual({ ar: {}, en: {} });
      expect((await entries()).slice(before).map((entry) => entry.after)).toEqual([
        { ar: null, en: null },
      ]);
    });

    it("refuses a text without its placeholder, naming it, and a key the app does not have", async () => {
      await reset();
      const lost = await asAdmin("PUT", "/quests.pointsShort", { en: "You have {points}" });
      expect(lost.statusCode).toBe(422);
      expect(lost.json<{ code: string; details: { issues: unknown } }>()).toMatchObject({
        code: "invalid_translation",
        details: { issues: [{ path: "en", message: "is missing {currency}" }] },
      });
      expect((await asAdmin("PUT", "/nope.key", { en: "x" })).statusCode).toBe(422);
      expect(await owner("SELECT 1 FROM translation")).toEqual([]);
    });

    it("keeps legal and consent wording read-only and ignores a stored copy of it", async () => {
      await reset();
      const locked = await asAdmin("PUT", "/signIn.consentBody", { en: "Anything" });
      expect(locked.statusCode).toBe(422);
      expect(locked.json<{ code: string }>().code).toBe("text_locked");
      expect(await owner("SELECT 1 FROM translation")).toEqual([]);
      await owner("INSERT INTO translation (key, en) VALUES ('signIn.consentBody', 'Sneaked in')");
      expect(await bundleOf()).toEqual({ ar: {}, en: {} });
      const row = (await asAdmin("GET", "?q=signIn.consentBody")).json<{
        rows: { locked: boolean }[];
      }>().rows[0];
      expect(row?.locked).toBe(true);
    });

    it("lists a stored text the app ignores as stale, so it can be reverted", async () => {
      await reset();
      await owner(
        "INSERT INTO translation (key, en) VALUES ('quests.pointsShort', 'You have gems')",
      );
      const row = (await asAdmin("GET", "?q=quests.pointsShort")).json<{
        rows: { stale: unknown }[];
      }>().rows[0];
      expect(row?.stale).toEqual({ ar: false, en: true });
      expect(await bundleOf()).toEqual({ ar: {}, en: {} });
      expect((await asAdmin("PUT", "/quests.pointsShort", { en: "" })).statusCode).toBe(200);
      expect(await owner("SELECT 1 FROM translation")).toEqual([]);
    });

    it("answers a signed-in person who is not a platform admin 404, and a signed-out one 401", async () => {
      const other = await signInFully(test, "editor@najd.test");
      for (const [method, url] of [
        ["GET", "/v1/admin/translations"],
        ["PUT", "/v1/admin/translations/nav.home"],
      ] as const) {
        const response = await test.app.inject({
          method,
          url,
          headers: withSession(other),
          ...(method === "PUT" ? { payload: { en: "x" } } : {}),
        });
        expect(response.statusCode, url).toBe(404);
      }
      const outsider = await test.app.inject({ method: "GET", url: "/v1/admin/translations" });
      expect(outsider.statusCode).toBe(401);
      expect(await owner("SELECT 1 FROM translation")).toEqual([]);
    });
  });
});
