import { describe, expect, it } from "vitest";
import {
  GROUP_PUSH_BODY_MAX,
  GROUP_PUSH_TITLE_MAX,
  checkGroupPushText,
  groupPushBodySchema,
  groupPushPreviewSchema,
  groupPushViewSchema,
  type GroupPushText,
} from "#src/group-push/group-push";
import { renderNotice } from "#src/push/templates";

const GOOD: GroupPushText = {
  title: { ar: "عرض الأسبوع", en: "This week's offer" },
  body: { ar: "تحدٍّ جديد بانتظارك في الرياض.", en: "A new challenge is waiting in Riyadh." },
};
const event = { kind: "event", joinCode: "AB12CD" } as const;

const issuesOf = (text: GroupPushText): string[] => {
  const checked = checkGroupPushText(text);
  return checked.ok ? [] : checked.issues.map((issue) => `${issue.path}:${issue.message}`);
};

describe("the text of a group push", () => {
  it("passes a title and a text in both languages and is returned cleaned", () => {
    const checked = checkGroupPushText({
      title: { ar: "  عرض   الأسبوع ", en: "This   week's offer" },
      body: { ar: "تحدٍّ جديد ٣ نقاط", en: "A new\nchallenge" },
    });
    expect(checked).toEqual({
      ok: true,
      text: {
        title: { ar: "عرض الأسبوع", en: "This week's offer" },
        body: { ar: "تحدٍّ جديد 3 نقاط", en: "A new challenge" },
      },
    });
  });

  it("refuses an empty field, naming it", () => {
    expect(issuesOf({ ...GOOD, title: { ar: "", en: GOOD.title.en } })).toEqual([
      "title.ar:required",
    ]);
    expect(issuesOf({ ...GOOD, body: { ar: GOOD.body.ar, en: "   " } })).toEqual([
      "body.en:required",
    ]);
  });

  it("holds the title to 60 and the text to 140 characters", () => {
    expect(GROUP_PUSH_TITLE_MAX).toBe(60);
    expect(GROUP_PUSH_BODY_MAX).toBe(140);
    expect(issuesOf({ ...GOOD, title: { ar: GOOD.title.ar, en: "a".repeat(61) } })).toEqual([
      "title.en:tooLong",
    ]);
    expect(issuesOf({ ...GOOD, title: { ar: GOOD.title.ar, en: "a".repeat(60) } })).toEqual([]);
    expect(issuesOf({ ...GOOD, body: { ar: GOOD.body.ar, en: "a".repeat(141) } })).toEqual([
      "body.en:tooLong",
    ]);
    expect(issuesOf({ ...GOOD, body: { ar: GOOD.body.ar, en: "a".repeat(140) } })).toEqual([]);
  });

  it("wants each language in its own script", () => {
    expect(issuesOf({ ...GOOD, body: { ar: "English text", en: GOOD.body.en } })).toEqual([
      "body.ar:language",
    ]);
    expect(issuesOf({ ...GOOD, title: { ar: GOOD.title.ar, en: "عرض" } })).toEqual([
      "title.en:language",
    ]);
  });

  it("takes no placeholder and no stray brace, so no personal value can reach a push", () => {
    expect(issuesOf({ ...GOOD, body: { ar: GOOD.body.ar, en: "Hi {username}" } })).toEqual([
      "body.en:placeholderUnknown",
    ]);
    expect(issuesOf({ ...GOOD, body: { ar: GOOD.body.ar, en: "Hi }" } })).toEqual([
      "body.en:braces",
    ]);
  });

  it("refuses an address or a phone number, as an announcement does", () => {
    expect(
      issuesOf({ ...GOOD, body: { ar: GOOD.body.ar, en: "Win at https://example.com now" } }),
    ).toEqual(["body.en:looks_like_address"]);
    expect(
      issuesOf({ ...GOOD, body: { ar: GOOD.body.ar, en: "Call 0501234567 89 for a prize" } }),
    ).toEqual(["body.en:looks_like_phone"]);
  });

  it("reports every field that fails, not only the first", () => {
    const issues = issuesOf({
      title: { ar: "", en: "" },
      body: { ar: "", en: "" },
    });
    expect([...issues].sort()).toEqual([
      "body.ar:required",
      "body.en:required",
      "title.ar:required",
      "title.en:required",
    ]);
  });
});

describe("the request body", () => {
  it("takes an event by its join code, trimmed", () => {
    const parsed = groupPushBodySchema.safeParse({
      audience: { kind: "event", joinCode: " AB12CD " },
      ...GOOD,
    });
    expect(parsed.success && parsed.data.audience).toEqual(event);
  });

  it("takes opted-in players by city and interests, each optional", () => {
    for (const audience of [
      { kind: "promo", cityId: null, interests: [] },
      { kind: "promo", cityId: "sa-riyadh", interests: ["sport", "music"] },
    ]) {
      expect(groupPushBodySchema.safeParse({ audience, ...GOOD }).success).toBe(true);
    }
  });

  it("refuses an unknown shape, a repeated interest, more than 8 and a malformed city or code", () => {
    const bad = [
      { kind: "everyone" },
      { kind: "event", joinCode: "x" },
      { kind: "event", joinCode: "AB12CD", cityId: null },
      { kind: "promo", cityId: "Riyadh", interests: [] },
      { kind: "promo", cityId: null, interests: ["sport", "sport"] },
      { kind: "promo", cityId: null, interests: Array.from({ length: 9 }, (_, n) => `topic-${n}`) },
      { kind: "promo", cityId: null },
    ];
    for (const audience of bad) {
      expect(
        groupPushBodySchema.safeParse({ audience, ...GOOD }).success,
        String(audience.kind),
      ).toBe(false);
    }
    expect(groupPushBodySchema.safeParse({ audience: event, ...GOOD, extra: 1 }).success).toBe(
      false,
    );
  });
});

describe("what the console reads", () => {
  const view = {
    id: "11111111-1111-4111-8111-111111111111",
    audience: "event",
    event: {
      id: "22222222-2222-4222-8222-222222222222",
      joinCode: "AB12CD",
      name: { ar: "فعالية", en: "Event" },
    },
    cityId: null,
    interests: [],
    title: GOOD.title,
    body: GOOD.body,
    state: "done",
    reach: 12,
    notices: 1,
    capped: 0,
    createdAt: "2026-11-03T10:00:00.000Z",
    finishedAt: "2026-11-03T10:00:00.000Z",
  };

  it("parses a send and a preview, and refuses a changed shape", () => {
    expect(groupPushViewSchema.safeParse(view).success).toBe(true);
    expect(groupPushViewSchema.safeParse({ ...view, state: "paused" }).success).toBe(false);
    expect(groupPushViewSchema.safeParse({ ...view, reach: -1 }).success).toBe(false);
    expect(
      groupPushPreviewSchema.safeParse({
        audience: "promo",
        event: null,
        cityId: "sa-riyadh",
        interests: [],
        reach: 100001,
        capped: true,
      }).success,
    ).toBe(true);
  });
});

describe("how the two kinds render", () => {
  const params = { title: GOOD.title, body: GOOD.body };

  it("pushes the frozen title and text in the language asked for", () => {
    for (const kind of ["group_push_event", "group_push_promo"]) {
      const base = { kind, params, terms: null, timezone: null };
      expect(renderNotice({ ...base, language: "en" })).toEqual({
        title: GOOD.title.en,
        body: GOOD.body.en,
        pushable: true,
      });
      expect(renderNotice({ ...base, language: "ar" })).toEqual({
        title: GOOD.title.ar,
        body: GOOD.body.ar,
        pushable: true,
      });
    }
  });

  it("shows the generic text and pushes nothing when the stored text no longer passes", () => {
    const rendered = renderNotice({
      kind: "group_push_promo",
      params: { title: GOOD.title, body: { ar: "x", en: "see https://example.com" } },
      terms: null,
      timezone: null,
      language: "en",
    });
    expect(rendered.pushable).toBe(false);
  });
});
