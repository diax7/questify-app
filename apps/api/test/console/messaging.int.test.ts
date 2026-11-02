/* oxlint-disable unicorn/consistent-function-scoping -- each helper sits in the describe that uses it, beside its tests */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

const PROMO_SMS = {
  title: null,
  body: {
    ar: "كويستفاي: خصم جديد بانتظارك.\nإيقاف العروض: {optOutUrl}",
    en: "Questify: a new discount is waiting for you.\nStop offers: {optOutUrl}",
  },
};

/**
 * The message templates and the support contact over HTTP (T-706, FR-1780, FR-1731): the console doors are for an active
 * admin only (404 to anyone else), a template that breaks a CST rule is refused with the fields named, a save is
 * audited and can be reverted, and the contact page reads only what is set.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("message templates and support contact", () => {
  let db: TestDatabase;
  let test: TestApp;
  let adminCookie = "";
  let ownerCookie = "";

  beforeAll(async () => {
    db = await createTestDatabase();
    test = await startApp(db);
    await createStaff(db.owner, { email: "admin@questify.test", admin: true });
    const ownerId = await createStaff(db.owner, { email: "owner@najd.test" });
    const [org] = (
      await db.owner.query<{ id: string }>(
        "INSERT INTO organizer (name, slug) VALUES ('Najd Events', 'najd') RETURNING id",
      )
    ).rows;
    await db.owner.query(
      "INSERT INTO organizer_member (organizer_id, staff_user_id, role) VALUES ($1, $2, 'owner')",
      [org?.id, ownerId],
    );
    adminCookie = await signInFully(test, "admin@questify.test");
    ownerCookie = await signInFully(test, "owner@najd.test");
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
  const listed = async (): Promise<Json[]> =>
    (await admin("GET", "/v1/admin/message-templates")).json<{ templates: Json[] }>().templates;
  const issuesOf = (body: Json): string[] =>
    (
      ((body["details"] as Json | undefined)?.["issues"] ?? []) as {
        path: string;
        message: string;
      }[]
    ).map((issue) => `${issue.path}:${issue.message}`);

  describe("who may use the doors", () => {
    it("answers 404 to a team member, and 401 to nobody signed in", async () => {
      const urls: [Method, string, object?][] = [
        ["GET", "/v1/admin/message-templates"],
        ["PUT", "/v1/admin/message-templates/promo_sms", PROMO_SMS],
        ["POST", "/v1/admin/message-templates/promo_sms/revert", {}],
        ["GET", "/v1/admin/support-contact"],
        ["PUT", "/v1/admin/support-contact", { whatsapp: null, phone: null, email: null }],
      ];
      for (const [method, url, payload] of urls) {
        expect((await call(method, url, ownerCookie, payload)).statusCode, url).toBe(404);
        const anonymous = await test.app.inject({
          method,
          url,
          headers: withSession("", { "idempotency-key": randomUUID() }),
          ...(payload === undefined ? {} : { payload }),
        });
        expect(anonymous.statusCode, url).toBe(401);
      }
    });
  });

  describe("templates", () => {
    it("lists the four seeded templates, none changed yet", async () => {
      const templates = await listed();
      expect(templates.map((row) => row["key"])).toEqual([
        "login_code_sms",
        "promo_email",
        "promo_push",
        "promo_sms",
      ]);
      expect(templates.every((row) => row["revertible"] === false)).toBe(true);
    });

    it("refuses a promotional SMS without the opt-out line and names the fields", async () => {
      const refused = await admin("PUT", "/v1/admin/message-templates/promo_sms", {
        title: null,
        body: { ar: "كويستفاي: خصم جديد.", en: "Questify: a new discount." },
      });
      expect(refused.statusCode).toBe(422);
      expect(issuesOf(refused.json())).toEqual([
        "body.ar:placeholderMissing",
        "body.en:placeholderMissing",
      ]);
      const stored = (await listed()).find((row) => row["key"] === "promo_sms");
      expect(((stored ?? {})["body"] as Json)["en"]).toContain("a new offer is waiting");
    });

    it("refuses a login-code SMS that does not say what the code is for", async () => {
      const refused = await admin("PUT", "/v1/admin/message-templates/login_code_sms", {
        title: null,
        body: { ar: "كويستفاي: {code}", en: "Questify: {code}" },
      });
      expect(refused.statusCode).toBe(422);
      expect(issuesOf(refused.json())).toEqual([
        "body.ar:purposeMissing",
        "body.en:purposeMissing",
      ]);
    });

    it("refuses an unknown key, a malformed body and an unknown field", async () => {
      expect((await admin("PUT", "/v1/admin/message-templates/other", PROMO_SMS)).statusCode).toBe(
        400,
      );
      expect((await admin("PUT", "/v1/admin/message-templates/promo_sms", {})).statusCode).toBe(
        422,
      );
      expect(
        (await admin("PUT", "/v1/admin/message-templates/promo_sms", { ...PROMO_SMS, x: 1 }))
          .statusCode,
      ).toBe(422);
    });

    it("saves a promotional SMS with the opt-out line, audits it, and reverts it", async () => {
      const saved = await admin("PUT", "/v1/admin/message-templates/promo_sms", PROMO_SMS);
      expect(saved.statusCode).toBe(200);
      const template = saved.json<{ template: Json }>().template;
      expect(template["revertible"]).toBe(true);
      expect((template["body"] as Json)["en"]).toBe(PROMO_SMS.body.en);
      const { rows } = await db.owner.query<{ action: string; before: Json; after: Json }>(
        "SELECT action, before, after FROM audit_log WHERE target_type = 'message_template' ORDER BY id",
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.action).toBe("catalog.message_template.update");
      expect(((rows[0]?.before ?? {})["body"] as Json)["en"]).toContain("a new offer is waiting");
      const back = await admin("POST", "/v1/admin/message-templates/promo_sms/revert", {});
      expect(back.statusCode).toBe(200);
      expect((back.json<{ template: Json }>().template["body"] as Json)["en"]).toContain(
        "a new offer is waiting",
      );
    });

    it("answers 409 when there is nothing to revert", async () => {
      expect(
        (await admin("POST", "/v1/admin/message-templates/promo_push/revert", {})).statusCode,
      ).toBe(409);
    });

    it("saves an email and a push with their titles, and refuses an SMS title", async () => {
      expect(
        (
          await admin("PUT", "/v1/admin/message-templates/promo_email", {
            title: { ar: "خصومات", en: "Discounts" },
            body: {
              ar: "عرض لك من كويستفاي.\n{optOutUrl}",
              en: "An offer from Questify.\n{optOutUrl}",
            },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await admin("PUT", "/v1/admin/message-templates/promo_push", {
            title: { ar: "كويستفاي", en: "Questify" },
            body: { ar: "خصم جديد", en: "A new discount" },
          })
        ).statusCode,
      ).toBe(200);
      const withTitle = await admin("PUT", "/v1/admin/message-templates/promo_sms", {
        ...PROMO_SMS,
        title: { ar: "ع", en: "a" },
      });
      expect(withTitle.statusCode).toBe(422);
    });
  });

  describe("the support contact", () => {
    const contact = {
      whatsapp: "+966501234567",
      phone: "+966112345678",
      email: "help@questify.sa",
    };

    it("starts empty for everyone", async () => {
      const publicRead = await test.app.inject({ method: "GET", url: "/v1/support-contact" });
      expect(publicRead.statusCode).toBe(200);
      expect(publicRead.json()).toEqual({ whatsapp: null, phone: null, email: null });
      expect(publicRead.headers["cache-control"]).toBe("public, max-age=60");
    });

    it("shows what an admin saves, and only the fields that are set", async () => {
      const saved = await admin("PUT", "/v1/admin/support-contact", contact);
      expect(saved.statusCode).toBe(200);
      expect((await test.app.inject({ method: "GET", url: "/v1/support-contact" })).json()).toEqual(
        contact,
      );
      expect(
        (await admin("PUT", "/v1/admin/support-contact", { ...contact, whatsapp: null }))
          .statusCode,
      ).toBe(200);
      expect((await test.app.inject({ method: "GET", url: "/v1/support-contact" })).json()).toEqual(
        {
          ...contact,
          whatsapp: null,
        },
      );
      const read = await admin("GET", "/v1/admin/support-contact");
      expect(read.json<{ contact: Json }>().contact["email"]).toBe("help@questify.sa");
    });

    it("refuses a number without a country code and an address without a domain", async () => {
      for (const bad of [
        { ...contact, whatsapp: "0501234567" },
        { ...contact, phone: "+0123" },
        { ...contact, email: "help@" },
        { ...contact, email: "a b@questify.sa" },
        { ...contact, extra: 1 },
      ]) {
        expect((await admin("PUT", "/v1/admin/support-contact", bad)).statusCode).toBe(422);
      }
    });

    it("audits each change with the fields before and after", async () => {
      const { rows } = await db.owner.query<{ before: Json; after: Json }>(
        "SELECT before, after FROM audit_log WHERE target_type = 'support_contact' ORDER BY id",
      );
      expect(rows).toHaveLength(2);
      expect(rows[0]?.before).toEqual({ whatsapp: null, phone: null, email: null });
      expect(rows[1]?.after).toEqual({ ...contact, whatsapp: null });
    });
  });
});
