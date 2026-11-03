import { randomUUID } from "node:crypto";
import {
  DEFAULT_COMPOSED_PLAYER_INTRO,
  PLAYER_INTRO_KEYS,
  parseComposedConfig,
  playerIntroAdminSchema,
  readPlayerIntro,
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

const URL = "/v1/admin/catalog/player-intro";
const doc = (overrides: Json = {}): Json => ({
  order: PLAYER_INTRO_KEYS,
  hidden: [],
  ...overrides,
});
const reversed = [...PLAYER_INTRO_KEYS].toReversed();

/**
 * The player intro's cards over HTTP (T-802b, FR-1803): admin-only (404 to everyone else), every body checked by the shared
 * check before the door, a save audited with the layout before and after, a revert that can itself be reverted, and the change
 * in the public configuration at once (the settings cache is cleared).
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("player intro cards over HTTP", () => {
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
        "SELECT actor_id, before, after FROM audit_log WHERE action = $1 AND target_id = 'player_intro' AND id > $2 ORDER BY id",
        [action, mark],
      )
    ).rows;
  /** The intro part of the configuration any app downloads before signing in. */
  const published = async (): Promise<unknown> => {
    const answer = await test.app.inject({ method: "GET", url: "/v1/config" });
    expect(answer.statusCode).toBe(200);
    const parsed = parseComposedConfig(answer.json());
    return parsed.ok ? parsed.config.playerIntro : undefined;
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
      expect(await published()).toEqual(DEFAULT_COMPOSED_PLAYER_INTRO);
    });
  });

  describe("reading and saving", () => {
    it("lists the shipped intro, never cached, with nothing to revert yet", async () => {
      const answer = await admin("GET");
      expect(answer.statusCode).toBe(200);
      expect(answer.headers["cache-control"]).toMatch(/no-store/);
      expect(playerIntroAdminSchema.parse(answer.json())).toEqual({
        order: PLAYER_INTRO_KEYS,
        hidden: [],
        revertible: false,
      });
    });

    it("has nothing to revert while the intro was never changed", async () => {
      const answer = await admin("POST", {}, undefined, "/revert");
      expect(answer.statusCode).toBe(409);
      expect((answer.json() as { code: string }).code).toBe("nothing_to_revert");
    });

    it("saves a reorder and a hidden card, audits who changed what, and shows it in the public configuration at once", async () => {
      expect(await published()).toEqual(DEFAULT_COMPOSED_PLAYER_INTRO);
      const saved = await admin("PUT", doc({ order: reversed, hidden: ["quests"] }));
      expect(saved.statusCode).toBe(200);
      expect(saved.json()).toMatchObject({ hidden: ["quests"], revertible: true });
      const [entry, ...rest] = await audits("catalog.player_intro.update");
      expect(rest).toEqual([]);
      expect(entry?.actor_id).toBe(adminId);
      expect(entry?.before).toMatchObject({ order: PLAYER_INTRO_KEYS, hidden: [] });
      expect(entry?.after).toMatchObject({ order: reversed, hidden: ["quests"] });
      expect(await published()).toEqual({ cards: ["prizes", "points", "join"] });
      expect(readPlayerIntro((await admin("GET")).json()).order).toEqual(reversed);
    });

    it("plays one card when three are hidden", async () => {
      await admin("PUT", doc({ hidden: ["join", "quests", "prizes"] }));
      expect(await published()).toEqual({ cards: ["points"] });
    });

    it("refuses what the shared check refuses, with the issues and their paths", async () => {
      const cases: [Json, string][] = [
        [doc({ hidden: [...PLAYER_INTRO_KEYS] }), "hidden"],
        [doc({ hidden: ["ghost"] }), "hidden.0"],
        [doc({ hidden: ["join", "join"] }), "hidden.1"],
        [doc({ order: PLAYER_INTRO_KEYS.slice(1) }), "order"],
        [doc({ order: [...PLAYER_INTRO_KEYS, "join"] }), "order.4"],
        [{ order: PLAYER_INTRO_KEYS }, "hidden"],
        [doc({ extra: 1 }), "extra"],
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
      expect((await audits("catalog.player_intro.update")).length).toBe(0);
      expect(await published()).toEqual(DEFAULT_COMPOSED_PLAYER_INTRO);
    });
  });

  describe("a revert", () => {
    it("puts back the intro before the latest change, audits it, and a second revert undoes the first", async () => {
      await admin("PUT", doc({ order: reversed }));
      await admin("PUT", doc({ order: reversed, hidden: ["quests"] }));
      const key = randomUUID();
      const reverted = await admin("POST", {}, key, "/revert");
      expect(reverted.statusCode).toBe(200);
      expect(reverted.json()).toMatchObject({ order: reversed, hidden: [] });
      expect((await admin("POST", {}, key, "/revert")).json()).toEqual(reverted.json());
      expect((await audits("catalog.player_intro.revert")).length).toBe(1);
      expect(await published()).toEqual({ cards: reversed });
      const again = await admin("POST", {}, undefined, "/revert");
      expect(again.json()).toMatchObject({ hidden: ["quests"] });
      expect(await published()).toEqual({ cards: ["prizes", "points", "join"] });
    });

    it("takes no confirmation and no other field", async () => {
      await admin("PUT", doc({ hidden: ["quests"] }));
      expect((await admin("POST", { confirmed: true }, undefined, "/revert")).statusCode).toBe(400);
    });
  });
});
