import { randomUUID } from "node:crypto";
import {
  DEFAULT_COMPOSED_QUESTIFY_HOME,
  QUESTIFY_HOME_KEYS,
  homeLayoutAdminSchema,
  parseComposedConfig,
  readQuestifyHome,
} from "@questify/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createStaff,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type Method = "GET" | "PUT" | "POST";
type Json = Record<string, unknown>;

const URL = "/v1/admin/catalog/home-layout";
const slide = (title: string, action: Json = { type: "none" }): Json => ({
  title: { ar: "", en: title },
  subtitle: { ar: "", en: "" },
  action,
});
const doc = (overrides: Json = {}): Json => ({
  order: QUESTIFY_HOME_KEYS,
  hidden: [],
  banner: [],
  ...overrides,
});
const reversed = [...QUESTIFY_HOME_KEYS].toReversed();

/**
 * Questify home's layout over HTTP (T-713, FR-1838): admin-only (404 to everyone else), every body checked by the shared check
 * before the door, a save audited with the layout before and after, a revert that can itself be reverted, and the change in
 * the public configuration at once (the settings cache is cleared).
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("Questify home layout over HTTP", () => {
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
    adminCookie = await signInFully(test, "admin@questify.test");
    memberCookie = await signInFully(test, "owner@najd.test");
    strangerCookie = await signInFully(test, "stranger@najd.test");
  });
  // The audit log is append-only, so each test counts the entries made after the last one that existed.
  let mark = "0";
  beforeEach(async () => {
    const { rows } = await db.owner.query<{ id: string }>(
      "SELECT coalesce(max(id), 0) AS id FROM audit_log",
    );
    mark = rows[0]?.id ?? "0";
  });
  // Saving the default also clears the settings cache, which a delete from the table would leave stale.
  afterEach(async () => {
    await call("PUT", URL, adminCookie, doc());
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  const call = (method: Method, url: string, cookie: string, payload?: unknown, key?: string) =>
    test.app.inject({
      method,
      url,
      headers: withSession(cookie, { "idempotency-key": key ?? randomUUID() }),
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
  const admin = (method: Method, payload?: unknown, key?: string, path = "") =>
    call(method, `${URL}${path}`, adminCookie, payload, key);
  const audits = async (action: string) =>
    (
      await db.owner.query<{ actor_id: string; before: Json | null; after: Json }>(
        "SELECT actor_id, before, after FROM audit_log WHERE action = $1 AND target_id = 'questify_home' AND id > $2 ORDER BY id",
        [action, mark],
      )
    ).rows;
  /** The Questify home part of the configuration any app downloads before signing in. */
  const published = async (): Promise<unknown> => {
    const answer = await test.app.inject({ method: "GET", url: "/v1/config" });
    expect(answer.statusCode).toBe(200);
    const parsed = parseComposedConfig(answer.json());
    return parsed.ok ? parsed.config.questifyHome : undefined;
  };

  describe("who may ask", () => {
    it("answers 404 to a member and a stranger and 401 or 403 to nobody signed in, on every route", async () => {
      const routes: [Method, string, object?][] = [
        ["GET", URL],
        ["PUT", URL, doc()],
        ["POST", `${URL}/revert`, {}],
      ];
      for (const cookie of [memberCookie, strangerCookie]) {
        for (const [method, url, payload] of routes) {
          expect((await call(method, url, cookie, payload)).statusCode, `${method} ${url}`).toBe(
            404,
          );
        }
      }
      for (const [method, url, payload] of routes) {
        const anonymous = await test.app.inject({
          method,
          url,
          headers: { "idempotency-key": randomUUID() },
          ...(payload === undefined ? {} : { payload }),
        });
        expect(anonymous.statusCode, `${method} ${url}`).toBeGreaterThanOrEqual(401);
        expect(anonymous.statusCode, `${method} ${url}`).toBeLessThanOrEqual(403);
      }
      expect(await published()).toEqual(DEFAULT_COMPOSED_QUESTIFY_HOME);
    });
  });

  describe("reading and saving", () => {
    it("lists the default layout, never cached, with nothing to revert yet", async () => {
      const answer = await admin("GET");
      expect(answer.statusCode).toBe(200);
      expect(answer.headers["cache-control"]).toMatch(/no-store/);
      expect(homeLayoutAdminSchema.parse(answer.json())).toEqual({
        order: QUESTIFY_HOME_KEYS,
        hidden: [],
        banner: [],
        revertible: false,
      });
    });

    it("has nothing to revert while the layout was never changed", async () => {
      const answer = await admin("POST", {}, undefined, "/revert");
      expect(answer.statusCode).toBe(409);
      expect((answer.json() as { code: string }).code).toBe("nothing_to_revert");
    });

    it("saves a reorder, a hidden block and slides, audits who changed what, and shows it in the public configuration at once", async () => {
      expect(await published()).toEqual(DEFAULT_COMPOSED_QUESTIFY_HOME);
      const input = doc({
        order: ["dailyWord", ...QUESTIFY_HOME_KEYS.filter((key) => key !== "dailyWord")],
        hidden: ["streak"],
        banner: [
          slide("Welcome"),
          slide("Tickets", { type: "link", url: "https://questify.example/t" }),
        ],
      });
      const saved = await admin("PUT", input);
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toMatchObject({ hidden: ["streak"], revertible: true });
      const [entry, ...rest] = await audits("catalog.home_layout.update");
      expect(rest).toEqual([]);
      expect(entry?.actor_id).toBe(adminId);
      expect(entry?.before).toMatchObject({ order: QUESTIFY_HOME_KEYS, hidden: [] });
      expect(entry?.after).toMatchObject({ hidden: ["streak"] });
      const config = (await published()) as { blocks: string[]; banner: unknown[] };
      expect(config.blocks[0]).toBe("dailyWord");
      expect(config.blocks).not.toContain("streak");
      expect(config.banner).toHaveLength(2);
      expect(readQuestifyHome((await admin("GET")).json()).order[0]).toBe("dailyWord");
    });

    it("leaves a hidden banner's slides out of the public configuration", async () => {
      await admin("PUT", doc({ hidden: ["banner"], banner: [slide("Draft")] }));
      expect(await published()).toMatchObject({ banner: [] });
      expect(readQuestifyHome((await admin("GET")).json()).banner).toHaveLength(1);
    });

    it("refuses what the shared check refuses, with the issues and their paths", async () => {
      const cases: [Json, string][] = [
        [doc({ hidden: ["events"] }), "hidden"],
        [doc({ order: QUESTIFY_HOME_KEYS.slice(1) }), "order"],
        [doc({ banner: [slide("")] }), "banner.0.title"],
        [doc({ banner: [slide("A", { type: "agenda" })] }), "banner.0.action"],
        [
          doc({ banner: [slide("A", { type: "link", url: "http://questify.example" })] }),
          "banner.0.action.url",
        ],
        [doc({ banner: Array.from({ length: 6 }, () => slide("S")) }), "banner"],
        [{ order: QUESTIFY_HOME_KEYS }, "hidden"],
      ];
      for (const [body, path] of cases) {
        const answer = await admin("PUT", body);
        expect(answer.statusCode, path).toBe(422);
        const issues = (answer.json() as { details: { issues: { path: string }[] } }).details
          .issues;
        expect(
          issues.map((issue) => issue.path),
          path,
        ).toContain(path);
      }
      expect((await audits("catalog.home_layout.update")).length).toBe(0);
      expect(await published()).toEqual(DEFAULT_COMPOSED_QUESTIFY_HOME);
    });

    it("cleans a slide's text before it is stored", async () => {
      const saved = await admin(
        "PUT",
        doc({ banner: [{ ...slide("x"), title: { ar: "عرض ٣٠٪​", en: "" } }] }),
      );
      expect(saved.statusCode).toBe(200);
      expect((saved.json() as { banner: { title: Json }[] }).banner[0]?.title).toEqual({
        ar: "عرض 30٪",
        en: "",
      });
    });
  });

  describe("a revert", () => {
    it("puts back the layout before the latest change, audits it, and a second revert undoes the first", async () => {
      await admin("PUT", doc({ order: reversed }));
      await admin("PUT", doc({ order: reversed, hidden: ["quests"], banner: [slide("Two")] }));
      const key = randomUUID();
      const reverted = await admin("POST", {}, key, "/revert");
      expect(reverted.statusCode).toBe(200);
      expect(reverted.json()).toMatchObject({ order: reversed, hidden: [], banner: [] });
      expect((await admin("POST", {}, key, "/revert")).json()).toEqual(reverted.json());
      expect((await audits("catalog.home_layout.revert")).length).toBe(1);
      expect(await published()).toMatchObject({ blocks: reversed, banner: [] });
      const again = await admin("POST", {}, undefined, "/revert");
      expect(again.json()).toMatchObject({ hidden: ["quests"] });
      expect((await published()) as { banner: unknown[] }).toMatchObject({ banner: [{}] });
    });

    it("takes no confirmation and no other field", async () => {
      await admin("PUT", doc({ hidden: ["quests"] }));
      expect((await admin("POST", { confirmed: true }, undefined, "/revert")).statusCode).toBe(400);
    });
  });
});
