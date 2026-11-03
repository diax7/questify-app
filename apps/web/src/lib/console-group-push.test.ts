import type { MessageTemplateAdmin } from "@questify/shared";
import { describe, expect, it } from "vitest";
import {
  BLANK_PUSH,
  GROUP_PUSH_ISSUE_KEYS,
  checkPush,
  isBlankPush,
  readPreview,
  readPushes,
  savedPushText,
  type PushDraft,
} from "#src/lib/console-group-push.ts";

const TEXT = {
  titleAr: "عرض الأسبوع",
  titleEn: "This week's offer",
  bodyAr: "تحدٍّ جديد بانتظارك.",
  bodyEn: "A new challenge is waiting.",
};
const event = (over: Partial<PushDraft> = {}): PushDraft => ({
  ...BLANK_PUSH,
  kind: "event",
  joinCode: "NAJD1",
  ...TEXT,
  ...over,
});
const promo = (over: Partial<PushDraft> = {}): PushDraft => ({
  ...BLANK_PUSH,
  kind: "promo",
  ...TEXT,
  ...over,
});

const problemsOf = (draft: PushDraft): Record<string, readonly string[]> => {
  const checked = checkPush(draft);
  return checked.ok ? {} : Object.fromEntries(checked.problems);
};

describe("the form's check", () => {
  it("passes an event by its join code, and sends the text cleaned", () => {
    const checked = checkPush(
      event({ joinCode: " NAJD1 ", titleEn: " This   week's offer ", bodyAr: "تحدٍّ ٣ نقاط" }),
    );
    expect(checked).toEqual({
      ok: true,
      body: {
        audience: { kind: "event", joinCode: "NAJD1" },
        title: { ar: TEXT.titleAr, en: TEXT.titleEn },
        body: { ar: "تحدٍّ 3 نقاط", en: TEXT.bodyEn },
      },
    });
  });

  it("passes opted-in players with no city and no interests, or with both", () => {
    expect(checkPush(promo())).toMatchObject({
      ok: true,
      body: { audience: { kind: "promo", cityId: null, interests: [] } },
    });
    expect(checkPush(promo({ cityId: "sa-riyadh", interests: ["music", "sport"] }))).toMatchObject({
      ok: true,
      body: { audience: { kind: "promo", cityId: "sa-riyadh", interests: ["music", "sport"] } },
    });
  });

  it("refuses a join code that cannot be one, and names the field", () => {
    expect(problemsOf(event({ joinCode: "" }))).toEqual({
      joinCode: ["console.catalog.invalid"],
    });
    expect(Object.keys(problemsOf(event({ joinCode: "no spaces" })))).toEqual(["joinCode"]);
    expect(problemsOf(promo({ joinCode: "ignored for players" }))).toEqual({});
  });

  it("says why a text is refused, per field, in messages that exist", () => {
    expect(problemsOf(event({ titleAr: "" }))).toEqual({
      "title.ar": [GROUP_PUSH_ISSUE_KEYS.required],
    });
    expect(problemsOf(event({ bodyEn: "x".repeat(141) }))).toEqual({
      "body.en": [GROUP_PUSH_ISSUE_KEYS.tooLong],
    });
    expect(problemsOf(event({ bodyEn: "See https://example.com" }))).toEqual({
      "body.en": [GROUP_PUSH_ISSUE_KEYS.looks_like_address],
    });
    expect(problemsOf(event({ bodyAr: "English" }))).toEqual({
      "body.ar": [GROUP_PUSH_ISSUE_KEYS.language],
    });
    expect(problemsOf(event({ bodyEn: "Hi {name}" }))).toEqual({
      "body.en": [GROUP_PUSH_ISSUE_KEYS.placeholderUnknown],
    });
  });

  it("reports an audience problem and a text problem together", () => {
    expect(Object.keys(problemsOf(event({ joinCode: "", titleEn: "" }))).toSorted()).toEqual([
      "joinCode",
      "title.en",
    ]);
  });

  it("knows a blank form, which shows no refusals yet", () => {
    expect(isBlankPush(BLANK_PUSH)).toBe(true);
    expect(isBlankPush({ ...BLANK_PUSH, bodyEn: "  " })).toBe(true);
    expect(isBlankPush({ ...BLANK_PUSH, bodyEn: "x" })).toBe(false);
    expect(isBlankPush({ ...BLANK_PUSH, joinCode: "NAJD1" })).toBe(false);
  });
});

const row = (key: MessageTemplateAdmin["key"], title: boolean): MessageTemplateAdmin => ({
  key,
  title: title ? { ar: "كويستفاي", en: "Questify" } : null,
  body: { ar: "عرض جديد بانتظارك.", en: "A new offer is waiting for you." },
  updatedAt: "2026-11-03T10:00:00.000Z",
  revertible: false,
});

describe("the saved promotional push", () => {
  it("starts the composer from the promo_push slot and from no other", () => {
    expect(savedPushText([row("promo_email", true), row("promo_push", true)])).toEqual({
      titleAr: "كويستفاي",
      titleEn: "Questify",
      bodyAr: "عرض جديد بانتظارك.",
      bodyEn: "A new offer is waiting for you.",
    });
    expect(savedPushText([row("promo_email", true)])).toBeUndefined();
    expect(savedPushText([row("promo_push", false)])).toBeUndefined();
    expect(savedPushText([])).toBeUndefined();
  });
});

describe("what the page reads", () => {
  const push = {
    id: "11111111-1111-4111-8111-111111111111",
    audience: "promo",
    event: null,
    cityId: "sa-riyadh",
    interests: ["music"],
    title: { ar: "عنوان", en: "Title" },
    body: { ar: "نص", en: "Body" },
    state: "sending",
    reach: 12,
    notices: 3,
    capped: 1,
    createdAt: "2026-11-03T10:00:00.000Z",
    finishedAt: null,
  };

  it("reads the list and the preview, and answers undefined for a changed shape", () => {
    expect(readPushes({ pushes: [push] })).toEqual([push]);
    expect(readPushes({ pushes: [{ ...push, state: "paused" }] })).toBeUndefined();
    expect(readPushes(null)).toBeUndefined();
    const preview = {
      audience: "event",
      event: {
        id: "22222222-2222-4222-8222-222222222222",
        joinCode: "NAJD1",
        name: { ar: null, en: "Tech Fest" },
        status: "live",
      },
      cityId: null,
      interests: [],
      reach: 4,
      capped: false,
    };
    expect(readPreview({ preview })).toEqual(preview);
    expect(readPreview({ preview: { ...preview, reach: "4" } })).toBeUndefined();
    expect(readPreview({})).toBeUndefined();
  });
});
