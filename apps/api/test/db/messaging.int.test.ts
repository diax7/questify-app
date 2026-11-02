/* oxlint-disable unicorn/consistent-function-scoping -- each helper sits in the describe that uses it, beside its tests */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "#src/db/context";
import { pushFixture, type PushFixture } from "#test/support/push";
import { addMember, TEST_DATABASE_URL } from "#test/support/test-db";

type Doc = Record<string, unknown>;

/** A call's SQLSTATE and detail ("CA400:body.en"), or "none". */
const refusal = (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "none",
    (error: { code?: string; detail?: string }) =>
      error.detail === undefined || error.detail === ""
        ? `${error.code}`
        : `${error.code}:${error.detail}`,
  );

const sms = (ar: string, en: string): Doc => ({ title: null, body: { ar, en } });
const OPT_OUT = sms("كويستفاي: عرض.\n{optOutUrl}", "Questify: an offer.\n{optOutUrl}");

/**
 * The message templates and the support contact in the database (T-706, migration 0127): the four templates are seeded,
 * a promotional SMS or email can never lose its opt-out placeholder and a login-code SMS never its code (the door and
 * the table both refuse it), a save is audited and reverted through the audit trail, and every door is for an active
 * platform admin only (QE403). The tables are closed to the API's role.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("message templates and contact (database)", () => {
  let f: PushFixture;
  let admin: RequestContext = {};
  let adminId = "";
  let memberId = "";

  beforeAll(async () => {
    f = await pushFixture();
    const [row] = await f.owner<{ id: string }>(
      "INSERT INTO staff_user (email, password_hash, platform_role, status) VALUES ('msg@questify.test', 'h', 'admin', 'active') RETURNING id",
    );
    adminId = row?.id ?? "";
    admin = { isAdmin: true, staffUserId: adminId };
    memberId = await addMember(f.db.owner, f.ids.orgA, "editor");
  });
  afterAll(async () => {
    await f.close();
  });

  const one = async <T>(sql: string, values: unknown[] = [], seat: RequestContext = admin) =>
    (await f.run<{ r: T }>(seat, sql, values))[0]?.r as T;
  const save = (key: string, doc: Doc, seat = admin) =>
    one<Doc>(
      "SELECT admin_message_template_save($1, $2, NULL, $3) AS r",
      [key, doc, randomUUID()],
      seat,
    );
  const audits = (kind: string) =>
    f.owner<{ action: string; actor_id: string; before: Doc | null; after: Doc }>(
      "SELECT action, actor_id, before, after FROM audit_log WHERE target_type = $1 ORDER BY id",
      [kind],
    );
  const body = (row: Doc, language: string): string => (row["body"] as Doc)[language] as string;

  describe("who may call the doors", () => {
    it("refuses everyone but an active platform admin", async () => {
      const [off] = await f.owner<{ id: string }>(
        "INSERT INTO staff_user (email, password_hash, platform_role, status) VALUES ('msg-off@questify.test', 'h', 'admin', 'disabled') RETURNING id",
      );
      const seats: RequestContext[] = [
        { staffUserId: memberId },
        { isAdmin: true, staffUserId: memberId },
        { isAdmin: true, staffUserId: off?.id ?? "" },
        { staffUserId: adminId },
        {},
      ];
      const request = randomUUID();
      const calls = [
        "SELECT admin_message_templates()",
        `SELECT admin_message_template_save('promo_push', '{}', NULL, '${request}')`,
        "SELECT admin_support_contact()",
        `SELECT admin_support_contact_save('{}', '${request}')`,
      ];
      for (const seat of seats) {
        for (const call of calls) {
          expect(await refusal(f.run(seat, call)), `${call} ${JSON.stringify(seat)}`).toBe("QE403");
        }
      }
      expect(await audits("message_template")).toEqual([]);
    });
  });

  describe("the templates", () => {
    it("seeds the four, and the seeds hold their placeholders", async () => {
      const rows = await one<Doc[]>("SELECT admin_message_templates() AS r");
      expect(rows.map((row) => row["key"])).toEqual([
        "login_code_sms",
        "promo_email",
        "promo_push",
        "promo_sms",
      ]);
      const byKey = Object.fromEntries(rows.map((row) => [row["key"], row]));
      expect(body(byKey["login_code_sms"] as Doc, "en")).toContain("{code}");
      expect(body(byKey["promo_sms"] as Doc, "ar")).toContain("{optOutUrl}");
      expect(body(byKey["promo_email"] as Doc, "en")).toContain("{optOutUrl}");
    });

    it("refuses a promotional SMS or email without the opt-out placeholder, in either language", async () => {
      expect(
        await refusal(save("promo_sms", sms("كويستفاي: عرض.", "Questify: an offer.{optOutUrl}"))),
      ).toBe("CA400:body.ar");
      expect(
        await refusal(save("promo_sms", sms("كويستفاي: عرض.{optOutUrl}", "Questify: an offer."))),
      ).toBe("CA400:body.en");
      const email = { title: { ar: "عنوان", en: "Title" }, body: { ar: "نص", en: "Text" } };
      expect(await refusal(save("promo_email", email))).toBe("CA400:body.ar");
    });

    it("refuses a login-code SMS without its code, and any placeholder the template is not given", async () => {
      expect(
        await refusal(save("login_code_sms", sms("رمز الدخول: 123", "Sign-in code: {code}"))),
      ).toBe("CA400:body.ar");
      expect(
        await refusal(
          save("promo_sms", sms("كويستفاي {optOutUrl} {name}", "Questify {optOutUrl}")),
        ),
      ).toBe("CA400:body.ar");
      expect(
        await refusal(
          save("promo_push", {
            title: { ar: "ع", en: "a" },
            body: { ar: "مرحبا {name}", en: "Hi" },
          }),
        ),
      ).toBe("CA400:body.ar");
      expect(
        await refusal(save("promo_sms", sms("كويستفاي {optOutUrl} }", "Questify {optOutUrl}"))),
      ).toBe("CA400:body.ar");
    });

    it("refuses a title on an SMS, no title on an email or push, a long text and a control character", async () => {
      expect(await refusal(save("promo_sms", { ...OPT_OUT, title: { ar: "ع", en: "a" } }))).toBe(
        "CA400:title",
      );
      expect(await refusal(save("promo_push", { title: null, body: { ar: "ع", en: "a" } }))).toBe(
        "CA400:title.ar",
      );
      expect(
        await refusal(
          save("promo_push", {
            title: { ar: "ع".repeat(61), en: "a" },
            body: { ar: "ع", en: "a" },
          }),
        ),
      ).toBe("CA400:title.ar");
      expect(
        await refusal(
          save("promo_push", {
            title: { ar: "ع", en: "a" },
            body: { ar: "ع".repeat(141), en: "a" },
          }),
        ),
      ).toBe("CA400:body.ar");
      expect(
        await refusal(save("promo_sms", sms("كويستفاي\u0007{optOutUrl}", "Questify {optOutUrl}"))),
      ).toBe("CA400:body.ar");
      expect(
        await refusal(save("promo_sms", sms("كويستفاي‎{optOutUrl}", "Questify {optOutUrl}"))),
      ).toBe("CA400:body.ar");
    });

    it("answers CA404 for a key that is not one of the four", async () => {
      expect(await refusal(save("welcome_email", OPT_OUT))).toBe("CA404");
    });

    it("saves, audits with who and the text before and after, and writes nothing for an unchanged save", async () => {
      const saved = await save("promo_sms", OPT_OUT);
      expect(body(saved, "en")).toBe("Questify: an offer.\n{optOutUrl}");
      await save("promo_sms", OPT_OUT);
      const trail = await audits("message_template");
      expect(trail).toHaveLength(1);
      expect(trail[0]?.action).toBe("catalog.message_template.update");
      expect(trail[0]?.actor_id).toBe(adminId);
      expect(((trail[0]?.before ?? {})["body"] as Doc)["en"]).toContain("a new offer");
      expect(((trail[0]?.after ?? {})["body"] as Doc)["en"]).toBe(
        "Questify: an offer.\n{optOutUrl}",
      );
    });

    it("reverts to the text before the latest change, only while that entry is the latest", async () => {
      const [entry] = await f.owner<{ id: string }>(
        "SELECT id FROM audit_log WHERE target_type = 'message_template' ORDER BY id DESC LIMIT 1",
      );
      const stale = (Number(entry?.id) - 1).toString();
      const revert = (id: string) =>
        one<Doc>("SELECT admin_message_template_save('promo_sms', NULL, $1, $2) AS r", [
          id,
          randomUUID(),
        ]);
      expect(await refusal(revert(stale))).toBe("CA409");
      const back = await revert(entry?.id ?? "");
      expect(body(back, "en")).toContain("a new offer");
      expect((await audits("message_template")).at(-1)?.action).toBe(
        "catalog.message_template.revert",
      );
    });

    it("keeps the floor in the table itself: not even the owner role can remove an opt-out", async () => {
      for (const sql of [
        "UPDATE message_template SET body_en = 'Questify: an offer.' WHERE key = 'promo_sms'",
        "UPDATE message_template SET body_ar = 'كويستفاي' WHERE key = 'promo_email'",
        "UPDATE message_template SET body_en = 'Your code' WHERE key = 'login_code_sms'",
        "UPDATE message_template SET title_ar = 'x' WHERE key = 'promo_sms'",
        "UPDATE message_template SET title_en = NULL WHERE key = 'promo_push'",
      ]) {
        expect(await refusal(f.owner(sql)), sql).toMatch(/^23514/);
      }
    });
  });

  describe("the support contact", () => {
    const contact = (extra: Doc = {}): Doc => ({
      whatsapp: "+966501234567",
      phone: "+966112345678",
      email: "help@questify.sa",
      ...extra,
    });
    const saveContact = (doc: Doc, seat = admin) =>
      one<Doc>("SELECT admin_support_contact_save($1, $2) AS r", [doc, randomUUID()], seat);
    const publicRead = () => one<Doc>("SELECT support_contact_public() AS r", [], {});

    it("is empty at first, and readable with no identity at all", async () => {
      expect(await publicRead()).toEqual({ whatsapp: null, phone: null, email: null });
    });

    it("saves the three fields, clears an empty one, and audits each change once", async () => {
      await saveContact(contact());
      expect(await publicRead()).toEqual(contact());
      await saveContact(contact());
      await saveContact(contact({ whatsapp: "  " }));
      expect(await publicRead()).toEqual(contact({ whatsapp: null }));
      const trail = await audits("support_contact");
      expect(trail).toHaveLength(2);
      expect(trail[1]?.before).toEqual(contact());
      const read = await one<Doc>("SELECT admin_support_contact() AS r");
      expect(read["email"]).toBe("help@questify.sa");
      expect(read["updatedAt"]).not.toBeNull();
    });

    it("refuses a number without a country code, a short or long one, and an address without a domain", async () => {
      for (const [field, value] of [
        ["whatsapp", "0501234567"],
        ["whatsapp", "+9665"],
        ["phone", "+9665012345678901"],
        ["phone", "+0501234567"],
        ["email", "help@"],
        ["email", "help @questify.sa"],
        ["email", `${"a".repeat(250)}@q.sa`],
      ] as const) {
        expect(await refusal(saveContact(contact({ [field]: value }))), `${field} ${value}`).toBe(
          `CA400:${field}`,
        );
      }
      expect(await publicRead()).toEqual(contact({ whatsapp: null }));
    });
  });

  describe("the tables are closed", () => {
    it("lets the API's role call the doors only and read no table", async () => {
      const grants = await f.owner<{ table_name: string }>(
        `SELECT table_name FROM information_schema.role_table_grants
         WHERE table_schema = 'public' AND table_name IN ('message_template', 'support_contact')
           AND grantee IN ('PUBLIC', 'questify_app', 'questify_outsider')`,
      );
      expect(grants).toEqual([]);
    });
  });
});
