/* oxlint-disable unicorn/consistent-function-scoping -- each helper sits in the describe that uses it, beside its tests */
import { describe, expect, it } from "vitest";
import {
  MESSAGE_TEMPLATE_KEYS,
  TEMPLATE_RULES,
  fillSamples,
  messageTemplateDocSchema,
  placeholdersIn,
  templateIssues,
  type MessageTemplateDoc,
  type MessageTemplateKey,
} from "#src/messaging/templates";

const LOGIN: MessageTemplateDoc = {
  title: null,
  body: {
    ar: "رمز الدخول إلى كويستفاي: {code}. لا تشاركه مع أحد.",
    en: "Your Questify sign-in code is {code}. Do not share it.",
  },
};
const PROMO_SMS: MessageTemplateDoc = {
  title: null,
  body: {
    ar: "كويستفاي: عرض جديد بانتظارك.\nإيقاف العروض: {optOutUrl}",
    en: "Questify: a new offer is waiting for you.\nStop offers: {optOutUrl}",
  },
};
const PROMO_EMAIL: MessageTemplateDoc = {
  title: { ar: "عروض جديدة من كويستفاي", en: "New offers from Questify" },
  body: {
    ar: "لدينا عرض جديد لك في كويستفاي.\n\nلإيقاف رسائل العروض: {optOutUrl}",
    en: "We have a new offer for you on Questify.\n\nTo stop offers: {optOutUrl}",
  },
};
const PROMO_PUSH: MessageTemplateDoc = {
  title: { ar: "كويستفاي", en: "Questify" },
  body: { ar: "عرض جديد بانتظارك.", en: "A new offer is waiting for you." },
};
const GOOD: Readonly<Record<MessageTemplateKey, MessageTemplateDoc>> = {
  login_code_sms: LOGIN,
  promo_sms: PROMO_SMS,
  promo_email: PROMO_EMAIL,
  promo_push: PROMO_PUSH,
};

const codes = (key: MessageTemplateKey, doc: MessageTemplateDoc): string[] =>
  templateIssues(key, doc).map((issue) => `${issue.path}:${issue.message}`);

describe("the shipped templates", () => {
  it("pass their own rules, and every key has a rule", () => {
    for (const key of MESSAGE_TEMPLATE_KEYS) {
      expect(messageTemplateDocSchema.safeParse(GOOD[key]).success, key).toBe(true);
      expect(codes(key, GOOD[key]), key).toEqual([]);
      expect(TEMPLATE_RULES[key]).toBeDefined();
    }
  });
});

describe("a login-code SMS", () => {
  it("is refused without a purpose, in either language", () => {
    const doc = {
      title: null,
      body: { ar: "كويستفاي: {code}", en: "Questify: {code}" },
    };
    expect(codes("login_code_sms", doc)).toEqual([
      "body.ar:purposeMissing",
      "body.en:purposeMissing",
    ]);
  });

  it("is refused without its code, or with a placeholder it is not given", () => {
    const noCode = {
      title: null,
      body: { ar: LOGIN.body.ar.replace("{code}", "123456"), en: LOGIN.body.en },
    };
    expect(codes("login_code_sms", noCode)).toEqual(["body.ar:placeholderMissing"]);
    const extra = { title: null, body: { ar: LOGIN.body.ar, en: `${LOGIN.body.en} {name}` } };
    expect(codes("login_code_sms", extra)).toEqual(["body.en:placeholderUnknown"]);
  });

  it("is refused without the brand name, with a title, or when it needs more than 3 parts", () => {
    const noBrand = {
      title: null,
      body: { ar: "رمز الدخول: {code}", en: "Your sign-in code is {code}" },
    };
    expect(codes("login_code_sms", noBrand)).toEqual([
      "body.ar:brandMissing",
      "body.en:brandMissing",
    ]);
    expect(codes("login_code_sms", { ...LOGIN, title: { ar: "ع", en: "a" } })).toContain(
      "title:titleNotAllowed",
    );
    const long = {
      title: null,
      body: { ar: LOGIN.body.ar, en: `${LOGIN.body.en} ${"[".repeat(250)}` },
    };
    expect(codes("login_code_sms", long)).toContain("body.en:smsPartsLimit");
  });
});

describe("a promotional template", () => {
  it("is refused without the opt-out link, SMS and email alike", () => {
    const bare = (doc: MessageTemplateDoc): MessageTemplateDoc => ({
      ...doc,
      body: {
        ar: doc.body.ar.replace("{optOutUrl}", ""),
        en: doc.body.en.replace("{optOutUrl}", ""),
      },
    });
    expect(codes("promo_sms", bare(PROMO_SMS))).toEqual([
      "body.ar:placeholderMissing",
      "body.en:placeholderMissing",
    ]);
    expect(codes("promo_email", bare(PROMO_EMAIL))).toEqual([
      "body.ar:placeholderMissing",
      "body.en:placeholderMissing",
    ]);
  });

  it("is accepted with the opt-out line", () => {
    expect(codes("promo_sms", PROMO_SMS)).toEqual([]);
  });

  it("counts the opt-out link at its real length towards the SMS parts", () => {
    const ar = `كويستفاي ${"ع".repeat(130)} {optOutUrl}`;
    expect(codes("promo_sms", { title: null, body: { ar, en: PROMO_SMS.body.en } })).toEqual([
      "body.ar:smsPartsLimit",
    ]);
  });

  it("counts the 46-character opt-out token (key id byte): a text that filled 3 parts with 44 is refused", () => {
    // "كويستفاي " (9) + filler + " " + the 79-character link: 201 UTF-16 units is the most 3 UCS-2 parts hold.
    const withFiller = (units: number) => `كويستفاي ${"ع".repeat(units)} {optOutUrl}`;
    expect(fillSamples(withFiller(112), "ar")).toHaveLength(201);
    expect(
      codes("promo_sms", { title: null, body: { ar: withFiller(112), en: PROMO_SMS.body.en } }),
    ).toEqual([]);
    // Exactly 201 units with the old 44-character sample, so it was accepted at save before this change.
    expect(
      codes("promo_sms", { title: null, body: { ar: withFiller(114), en: PROMO_SMS.body.en } }),
    ).toEqual(["body.ar:smsPartsLimit"]);
  });

  it("refuses a stray brace, a wrong-language text and an empty one", () => {
    expect(
      codes("promo_sms", {
        title: null,
        body: { ...PROMO_SMS.body, en: `${PROMO_SMS.body.en} }` },
      }),
    ).toEqual(["body.en:braces"]);
    expect(
      codes("promo_sms", { title: null, body: { ar: PROMO_SMS.body.ar, en: PROMO_SMS.body.ar } }),
    ).toContain("body.en:language");
    expect(codes("promo_sms", { title: null, body: { ar: "", en: PROMO_SMS.body.en } })).toEqual([
      "body.ar:required",
    ]);
  });

  it("needs a title in both languages for email and push, within their lengths", () => {
    expect(codes("promo_email", { ...PROMO_EMAIL, title: null })).toEqual([
      "title.ar:required",
      "title.en:required",
    ]);
    expect(
      codes("promo_push", { ...PROMO_PUSH, title: { ar: "ع".repeat(61), en: "Questify" } }),
    ).toEqual(["title.ar:tooLong"]);
    expect(
      codes("promo_push", { ...PROMO_PUSH, body: { ar: "ع".repeat(141), en: PROMO_PUSH.body.en } }),
    ).toEqual(["body.ar:tooLong"]);
  });

  it("never lets a push carry a placeholder", () => {
    expect(
      codes("promo_push", { ...PROMO_PUSH, body: { ar: PROMO_PUSH.body.ar, en: "Hi {name}" } }),
    ).toEqual(["body.en:placeholderUnknown"]);
  });
});

describe("placeholders", () => {
  it("lists the names between braces and fills them with stand-ins of the real length", () => {
    expect(placeholdersIn("a {code} b {optOutUrl} {x1} {1x} {}")).toEqual([
      "code",
      "optOutUrl",
      "x1",
    ]);
    expect(fillSamples("Code {code}", "en")).toBe("Code 123456");
    expect(fillSamples("{optOutUrl}", "ar")).toMatch(
      /^https:\/\/questify\.sa\/ar\/opt-out\?t=X{46}$/,
    );
    expect(fillSamples("{unknown}", "en")).toBe("{unknown}");
  });
});

describe("the document schema", () => {
  it("refuses Arabic-Indic digits, control characters and unknown fields", () => {
    const body = (text: string) => ({ title: null, body: { ar: text, en: "ok" } });
    expect(messageTemplateDocSchema.safeParse(body("رمز ١٢٣")).success).toBe(false);
    expect(messageTemplateDocSchema.safeParse(body("a\u0007b")).success).toBe(false);
    expect(messageTemplateDocSchema.safeParse({ ...body("x"), extra: 1 }).success).toBe(false);
  });
});
