/* oxlint-disable unicorn/consistent-function-scoping -- each helper sits in the describe that uses it, beside its tests */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createStaff,
  freshIp,
  signInFully,
  startApp,
  withSession,
  type TestApp,
} from "#test/support/auth-app";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

type Method = "GET" | "PUT" | "POST" | "DELETE";
type Json = Record<string, unknown>;

const TEXT = { ar: "نص الوثيقة", en: "The text of the document" };

/**
 * Legal versions and help over HTTP (T-707, FR-1781, FR-1782): the console door is for an active admin only (404 to anyone
 * else), a published version binds players at their next launch and sign-in and holds an organizer's team until its owner
 * accepts, and the help reads show the published articles with the language that exists.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("legal versions and help over HTTP", () => {
  let db: TestDatabase;
  let test: TestApp;
  let adminCookie = "";
  let ownerCookie = "";
  let editorCookie = "";
  let otherOwnerCookie = "";
  let organizer = "";
  let otherOrganizer = "";
  let ownerId = "";

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db);
    await createStaff(db.owner, { email: "admin@questify.test", admin: true });
    ownerId = await createStaff(db.owner, { email: "owner@najd.test" });
    const editorId = await createStaff(db.owner, { email: "editor@najd.test" });
    const otherId = await createStaff(db.owner, { email: "owner@tabuk.test" });
    const made = async (name: string, slug: string, owner: string): Promise<string> => {
      const [row] = (
        await db.owner.query<{ id: string }>(
          "INSERT INTO organizer (name, slug) VALUES ($1, $2) RETURNING id",
          [name, slug],
        )
      ).rows;
      const id = row?.id ?? "";
      await db.owner.query(
        "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
        [id, owner],
      );
      await db.owner.query(
        `INSERT INTO organizer_acceptance (organizer_id, document, version, accepted_by)
         SELECT $1, d, '0.1', $2 FROM unnest(ARRAY['organizer_terms','organizer_dpa','organizer_content_rules']) d`,
        [id, owner],
      );
      return id;
    };
    organizer = await made("Najd Events", "najd", ownerId);
    otherOrganizer = await made("Tabuk Fest", "tabuk", otherId);
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'editor')",
      [organizer, editorId],
    );
    adminCookie = await signInFully(test, "admin@questify.test");
    ownerCookie = await signInFully(test, "owner@najd.test");
    editorCookie = await signInFully(test, "editor@najd.test");
    otherOwnerCookie = await signInFully(test, "owner@tabuk.test");
  });
  afterAll(async () => {
    await test.close();
    await db.close();
  });

  const call = (method: Method, url: string, cookie: string, payload?: object) =>
    test.app.inject({
      method,
      url,
      headers: withSession(cookie, { "idempotency-key": randomUUID() }),
      ...(payload === undefined ? {} : { payload }),
    });
  const admin = (method: Method, url: string, payload?: object) =>
    call(method, url, adminCookie, payload);
  const publish = (document: string, version: string, extra: Json = {}) =>
    admin("POST", `/v1/admin/legal/${document}/versions`, { version, text: TEXT, ...extra });
  const inForce = async (): Promise<Record<string, string>> =>
    Object.fromEntries(
      (await test.app.inject({ method: "GET", url: "/v1/legal" }))
        .json<{
          documents: { document: string; version: string }[];
        }>()
        .documents.map((item) => [item.document, item.version]),
    );

  describe("who may use the console doors", () => {
    it("answers 404 to a member and a stranger, and 401 to nobody signed in", async () => {
      const urls: [Method, string, object?][] = [
        ["GET", "/v1/admin/legal"],
        ["POST", "/v1/admin/legal/terms_of_use/versions", { version: "9", text: TEXT }],
        ["GET", "/v1/admin/help"],
        ["PUT", "/v1/admin/help/faq", {}],
        ["POST", "/v1/admin/help/faq/revert", {}],
      ];
      for (const [method, url, payload] of urls) {
        for (const cookie of [ownerCookie, editorCookie, otherOwnerCookie]) {
          expect((await call(method, url, cookie, payload)).statusCode, `${method} ${url}`).toBe(
            404,
          );
        }
        const signedOut = await test.app.inject({
          method,
          url,
          headers: withSession("", { "idempotency-key": randomUUID() }),
          ...(payload === undefined ? {} : { payload }),
        });
        expect(signedOut.statusCode, `${method} ${url}`).toBe(401);
      }
      expect((await inForce())["terms_of_use"]).toBe("0.1");
    });
  });

  describe("publishing", () => {
    it("lists the six documents with their versions", async () => {
      const list = (await admin("GET", "/v1/admin/legal")).json<{ documents: Json[] }>();
      expect(list.documents.map((item) => item["document"])).toEqual([
        "community_guidelines",
        "organizer_content_rules",
        "organizer_dpa",
        "organizer_terms",
        "privacy_policy",
        "terms_of_use",
      ]);
    });

    it("refuses bodies the shared schema refuses, naming the fields, and an unknown document", async () => {
      const bad = [
        { version: "v2", text: TEXT },
        { version: "2", text: { ar: "English only", en: "x" } },
        { version: "2", text: { ar: "", en: "x" } },
        { version: "2", text: { ar: "٣ أرقام", en: "x" } },
        { version: "2", text: TEXT, extra: true },
      ];
      for (const body of bad) {
        const refused = await admin("POST", "/v1/admin/legal/terms_of_use/versions", body);
        expect(refused.statusCode, JSON.stringify(body)).toBe(422);
        expect(refused.json()).toMatchObject({ code: "invalid_catalog" });
      }
      expect((await publish("passwords", "2")).statusCode).toBe(400);
      expect((await inForce())["terms_of_use"]).toBe("0.1");
    });

    it("puts a version in force, shows its text publicly, and refuses one that is not later", async () => {
      const made = await publish("privacy_policy", "1", { note: "GDPR wording" });
      expect(made.statusCode).toBe(201);
      expect(made.json()).toMatchObject({ document: "privacy_policy", version: "1" });
      expect((await inForce())["privacy_policy"]).toBe("1");
      const text = await test.app.inject({ method: "GET", url: "/v1/legal/privacy_policy" });
      expect(text.json()).toMatchObject({ version: "1", ar: TEXT.ar, en: TEXT.en });
      expect(text.headers["cache-control"]).toContain("max-age");
      const again = await publish("privacy_policy", "1");
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({ code: "version_not_newer" });
      expect((await publish("privacy_policy", "0.9")).statusCode).toBe(409);
      expect((await test.app.inject({ method: "GET", url: "/v1/legal/nothing" })).statusCode).toBe(
        400,
      );
    });
  });

  describe("players are asked again", () => {
    const newPlayer = async (): Promise<string> => {
      const [made] = (
        await db.owner.query<{ id: string }>(
          "INSERT INTO player (username) VALUES ($1) RETURNING id",
          [`reaccept_${randomBytes(4).toString("hex")}`],
        )
      ).rows;
      const id = made?.id ?? "";
      await db.owner.query(
        `INSERT INTO player_acceptance (player_id, document, version, method)
         VALUES ($1, 'terms_of_use', '0.1', 'signup'), ($1, 'privacy_policy', '0.1', 'signup')`,
        [id],
      );
      const token = randomBytes(32).toString("base64url");
      await db.owner.query(
        "INSERT INTO player_session (player_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
        [id, createHash("sha256").update(token).digest()],
      );
      return token;
    };
    const me = async (token: string): Promise<Json> =>
      (
        await test.app.inject({
          method: "GET",
          url: "/v1/me",
          headers: { authorization: `Bearer ${token}` },
        })
      ).json<{ legal: Json }>().legal;
    const accept = (token: string, payload: object) =>
      test.app.inject({
        method: "POST",
        url: "/v1/me/acceptances",
        headers: { authorization: `Bearer ${token}` },
        payload,
      });

    it("asks a player who accepted the old version, and takes the new one once", async () => {
      const token = await newPlayer();
      expect((await publish("terms_of_use", "2")).statusCode).toBe(201);
      expect(await me(token)).toMatchObject({ toAccept: ["terms_of_use", "privacy_policy"] });
      const stale = await accept(token, { terms: "0.1", privacy: "1" });
      expect(stale.statusCode).toBe(422);
      expect(stale.json()).toMatchObject({
        code: "acceptance_required",
        details: { documents: expect.arrayContaining([{ id: "terms_of_use", version: "2" }]) },
      });
      expect((await accept(token, { terms: "2", privacy: "1" })).statusCode).toBe(200);
      expect(await me(token)).toMatchObject({ toAccept: [] });
    });

    it("refuses a sign-in request that names the old versions, and counts nothing", async () => {
      const refused = await test.app.inject({
        method: "POST",
        url: "/v1/auth/code",
        headers: { "x-forwarded-for": freshIp() },
        payload: {
          channel: "phone",
          value: "+966512345678",
          accept: { terms: "0.1", privacy: "1" },
        },
      });
      expect(refused.statusCode).toBe(422);
      expect(refused.json()).toMatchObject({
        details: { documents: expect.arrayContaining([{ id: "terms_of_use", version: "2" }]) },
      });
    });

    it("asks for the guidelines again when a new version is published", async () => {
      const token = await newPlayer();
      expect((await accept(token, { guidelines: "0.1" })).statusCode).toBe(200);
      expect(await me(token)).toMatchObject({ guidelinesAccepted: true });
      await publish("community_guidelines", "1");
      expect(await me(token)).toMatchObject({ guidelinesAccepted: false });
    });

    it("tells the apps the new versions through the configuration", async () => {
      const config = await test.app.inject({ method: "GET", url: "/v1/config" });
      const documents = config.json<{ legal: { documents: { id: string; version: string }[] } }>()
        .legal.documents;
      expect(documents).toEqual(
        expect.arrayContaining([
          { id: "terms_of_use", version: "2" },
          { id: "privacy_policy", version: "1" },
        ]),
      );
    });
  });

  describe("an organizer's team is held until its owner accepts", () => {
    const invite = (cookie: string, id = organizer) =>
      call("POST", `/v1/organizers/${id}/invites`, cookie, {
        email: `new-${randomUUID()}@najd.test`,
      });
    const pending = async (cookie: string): Promise<Json[]> => {
      const me = await test.app.inject({
        method: "GET",
        url: "/v1/staff/me",
        headers: withSession(cookie),
      });
      const found = me
        .json<{ memberships: { organizerId: string; legalPending: Json[] }[] }>()
        .memberships.find((item) => item.organizerId === organizer);
      return found?.legalPending ?? [];
    };

    it("lists the new documents to every member, and refuses writes with the documents named", async () => {
      expect((await publish("organizer_dpa", "2")).statusCode).toBe(201);
      for (const cookie of [ownerCookie, editorCookie]) {
        expect(await pending(cookie)).toEqual([{ document: "organizer_dpa", version: "2" }]);
      }
      const refused = await invite(ownerCookie);
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({
        code: "organizer_acceptance_required",
        details: { documents: [{ id: "organizer_dpa", version: "2" }] },
      });
      const read = await call("GET", `/v1/organizers/${organizer}/members`, editorCookie);
      expect(read.statusCode).toBe(200);
    });

    it("holds every organizer that accepted the old version, and each accepts for itself", async () => {
      expect((await invite(otherOwnerCookie, otherOrganizer)).statusCode).toBe(403);
      const documents = [{ document: "organizer_dpa", version: "2" }];
      const url = `/v1/organizers/${otherOrganizer}/legal/accept`;
      expect((await call("POST", url, ownerCookie, { documents })).statusCode).toBe(404);
      expect((await call("POST", url, otherOwnerCookie, { documents })).statusCode).toBe(204);
      expect((await invite(otherOwnerCookie, otherOrganizer)).statusCode).toBe(201);
    });

    it("lets only the owner accept, and only the versions in force", async () => {
      const documents = [{ document: "organizer_dpa", version: "2" }];
      const url = `/v1/organizers/${organizer}/legal/accept`;
      const editor = await call("POST", url, editorCookie, { documents });
      expect(editor.statusCode).toBe(403);
      expect(editor.json()).toMatchObject({ code: "owner_only" });
      expect((await call("POST", url, otherOwnerCookie, { documents })).statusCode).toBe(404);
      const stale = await call("POST", url, ownerCookie, {
        documents: [{ document: "organizer_dpa", version: "1" }],
      });
      expect(stale.statusCode).toBe(422);
      expect(stale.json()).toMatchObject({ code: "acceptance_required" });
      for (const body of [
        {},
        { documents: [] },
        { documents: [{ document: "terms_of_use", version: "2" }] },
      ]) {
        expect((await call("POST", url, ownerCookie, body)).statusCode).toBe(400);
      }
      expect((await invite(ownerCookie)).statusCode).toBe(403);
      expect((await call("POST", url, ownerCookie, { documents })).statusCode).toBe(204);
      expect(await pending(ownerCookie)).toEqual([]);
      expect((await invite(ownerCookie)).statusCode).toBe(201);
    });

    it("keeps leaving open while the documents wait", async () => {
      await publish("organizer_terms", "2");
      expect((await invite(ownerCookie)).statusCode).toBe(403);
      const left = await call("DELETE", `/v1/organizers/${organizer}/members/me`, editorCookie);
      expect(left.statusCode).toBe(204);
    });
  });

  describe("help", () => {
    const article = (extra: Json = {}): Json => ({
      question: { ar: "كيف أنضم؟", en: "How do I join?" },
      answer: { ar: "امسح الرمز.", en: "Scan the code." },
      position: 1,
      published: true,
      ...extra,
    });
    const publicHelp = async (): Promise<Json[]> =>
      (await test.app.inject({ method: "GET", url: "/v1/help" })).json<{ articles: Json[] }>()
        .articles;

    it("saves, lists, shows only the published ones, and shows one language when only that exists", async () => {
      expect((await admin("PUT", "/v1/admin/help/join", article())).statusCode).toBe(200);
      expect(
        (
          await admin(
            "PUT",
            "/v1/admin/help/prizes",
            article({
              position: 2,
              question: { ar: "", en: "Prizes?" },
              answer: { ar: "", en: "At the desk." },
            }),
          )
        ).statusCode,
      ).toBe(200);
      await admin("PUT", "/v1/admin/help/draft", article({ position: 3, published: false }));
      const listed = (await admin("GET", "/v1/admin/help")).json<{ articles: Json[] }>().articles;
      expect(listed.map((item) => item["id"])).toEqual(["join", "prizes", "draft"]);
      const shown = await publicHelp();
      expect(shown.map((item) => item["id"])).toEqual(["join", "prizes"]);
      expect(shown[1]).toMatchObject({ question: { ar: "", en: "Prizes?" } });
    });

    it("refuses a language half written, English in the Arabic box and a bad id", async () => {
      const bad = [
        article({ answer: { ar: "", en: "x" } }),
        article({ question: { ar: "English", en: "Q" } }),
        article({ question: { ar: "", en: "" }, answer: { ar: "", en: "" } }),
        article({ position: 0 }),
      ];
      for (const body of bad) {
        const refused = await admin("PUT", "/v1/admin/help/bad", body);
        expect(refused.statusCode, JSON.stringify(body)).toBe(422);
      }
      expect((await admin("PUT", "/v1/admin/help/Bad-Id", article())).statusCode).toBe(400);
      expect((await publicHelp()).some((item) => item["id"] === "bad")).toBe(false);
    });

    it("reverts the last change, and says when there is nothing to go back to", async () => {
      expect((await admin("POST", "/v1/admin/help/join/revert", {})).statusCode).toBe(409);
      await admin("PUT", "/v1/admin/help/join", article({ answer: { ar: "جديد", en: "New" } }));
      const reverted = await admin("POST", "/v1/admin/help/join/revert", {});
      expect(reverted.statusCode).toBe(200);
      expect(reverted.json()).toMatchObject({
        article: { answer: { ar: "امسح الرمز.", en: "Scan the code." } },
      });
      expect((await admin("POST", "/v1/admin/help/nothing/revert", {})).statusCode).toBe(409);
    });
  });
});
