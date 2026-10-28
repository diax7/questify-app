import { describe, expect, it } from "vitest";
import { MESSAGES, type Messages } from "#src/i18n/messages";
import {
  PUSH_PLACEHOLDERS,
  PUSH_TEMPLATES,
  pushMoment,
  pushName,
  pushTemplateIssues,
  renderNotice,
  type NoticeContent,
  type PushTexts,
} from "#src/push/templates";

/** Fixture texts shaped like the owed pushes (T-501 wires no kind of its own). */
const FIXTURE_MESSAGES: Messages = {
  ...MESSAGES,
  "push.test_flash.body": { ar: "{questOne} بوقت محدود: {quest}", en: "Flash {questOne}: {quest}" },
  "push.test_flash.nameless": {
    ar: "{questOne} بوقت محدود في الفعالية الآن",
    en: "A flash {questOne} is on now",
  },
  "push.test_prize.body": {
    ar: "فزت بجائزة: {reward}. يمكنك استلامها قبل {date}.",
    en: "You won a prize: {reward}. Collect it by {date}.",
  },
  "push.test_prize.nameless": {
    ar: "فزت بجائزة. يمكنك استلامها قبل {date}.",
    en: "You won a prize. Collect it by {date}.",
  },
  "push.test_soon.body": { ar: "تبدأ الفعالية الساعة {time}", en: "The event starts at {time}" },
  "push.test_soon.nameless": { ar: "تبدأ الفعالية قريبًا", en: "The event starts soon" },
  "push.test_leak.body": { ar: "مرحبًا {username}", en: "Hello {username}" },
  "push.test_leak.nameless": { ar: "مرحبًا", en: "Hello" },
};

const TEXTS: PushTexts = {
  messages: FIXTURE_MESSAGES,
  templates: {
    test_flash: { body: "push.test_flash.body", nameless: "push.test_flash.nameless" },
    test_prize: { body: "push.test_prize.body", nameless: "push.test_prize.nameless" },
    test_soon: { body: "push.test_soon.body", nameless: "push.test_soon.nameless" },
    test_leak: { body: "push.test_leak.body", nameless: "push.test_leak.nameless" },
  },
};

const EVENT = { ar: "مهرجان الشتاء", en: "Winter Fest" };
const content = (over: Partial<NoticeContent> = {}): NoticeContent => ({
  kind: "test_flash",
  params: { event: EVENT, quest: { ar: "ابحث عن الصقر", en: "Find the falcon" } },
  terms: null,
  timezone: "Asia/Riyadh",
  language: "en",
  ...over,
});

describe("renderNotice", () => {
  it("fills the template with the frozen names in each language, the event's name as the title", () => {
    expect(renderNotice(content(), TEXTS)).toEqual({
      title: "Winter Fest",
      body: "Flash quest: Find the falcon",
      pushable: true,
    });
    expect(renderNotice(content({ language: "ar" }), TEXTS)).toEqual({
      title: "مهرجان الشتاء",
      body: "مهمة بوقت محدود: ابحث عن الصقر",
      pushable: true,
    });
  });

  it("uses the other language's name when one is missing, and the event's words for quests", () => {
    const rendered = renderNotice(
      content({
        params: { event: { en: "Winter Fest" }, quest: { ar: "", en: "Find the falcon" } },
        terms: {
          quest: {
            ar: { one: "مغامرة", many: "مغامرات" },
            en: { one: "adventure", many: "adventures" },
          },
        },
        language: "ar",
      }),
      TEXTS,
    );
    expect(rendered).toEqual({
      title: "Winter Fest",
      body: "مغامرة بوقت محدود: Find the falcon",
      pushable: true,
    });
  });

  it.each([
    ["an address", "Visit example.com"],
    ["a link", "go to https://x"],
    ["an email", "me@x"],
    ["a phone number", "Call 0551234567"],
    ["an invisible character", `Find${String.fromCharCode(0x200b)}the falcon`],
  ])("sends the nameless variant when the quest's name holds %s", (_case, name) => {
    const rendered = renderNotice(
      content({ params: { event: EVENT, quest: { en: name } } }),
      TEXTS,
    );
    expect(rendered).toEqual({
      title: "Winter Fest",
      body: "A flash quest is on now",
      pushable: true,
    });
  });

  it("sends the nameless variant when the name is missing or not a pair of texts", () => {
    for (const quest of [undefined, null, "Find the falcon", 42, { ar: 1, en: [] }]) {
      expect(renderNotice(content({ params: { event: EVENT, quest } }), TEXTS).body).toBe(
        "A flash quest is on now",
      );
    }
  });

  it("titles the push Questify when the event's name fails the rule or is missing", () => {
    for (const event of [{ en: "win at prize.sa" }, undefined, { ar: " ", en: "" }]) {
      expect(renderNotice(content({ params: { event, quest: EVENT } }), TEXTS).title).toBe(
        "Questify",
      );
    }
    expect(renderNotice(content({ params: "broken" }), TEXTS)).toEqual({
      title: "Questify",
      body: "A flash quest is on now",
      pushable: true,
    });
  });

  it("cuts a long name to 40 units without splitting a pair", () => {
    const long = `${"a".repeat(39)}😀tail`;
    const rendered = renderNotice(
      content({ params: { event: EVENT, quest: { en: long } } }),
      TEXTS,
    );
    expect(rendered.body).toBe(`Flash quest: ${"a".repeat(39)}...`);
  });

  it("shows a date and a time in the event's zone with Western digits", () => {
    const at = "2026-10-29T13:30:00Z";
    expect(
      renderNotice(
        content({ kind: "test_prize", params: { reward: { en: "Mug" }, date: at } }),
        TEXTS,
      ).body,
    ).toBe("You won a prize: Mug. Collect it by 29 Oct.");
    const ar = renderNotice(
      content({ kind: "test_soon", params: { time: at }, language: "ar" }),
      TEXTS,
    ).body;
    expect(ar).toBe("تبدأ الفعالية الساعة 16:30");
    expect(ar).not.toMatch(/[٠-٩]/);
    expect(
      renderNotice(
        content({ kind: "test_soon", params: { time: at }, timezone: "Asia/Dubai" }),
        TEXTS,
      ).body,
    ).toBe("The event starts at 17:30");
  });

  it("falls back to the nameless body when a moment is unreadable", () => {
    expect(
      renderNotice(content({ kind: "test_soon", params: { time: "not a time" } }), TEXTS).body,
    ).toBe("The event starts soon");
    expect(
      renderNotice(content({ kind: "test_prize", params: { reward: { en: "Mug" } } }), TEXTS),
    ).toEqual({ title: "Questify", body: "You have a new message", pushable: false });
  });

  it("gives the generic center text for a kind without a template, never pushed", () => {
    expect(renderNotice(content({ kind: "unknown_kind" }), TEXTS)).toEqual({
      title: "Winter Fest",
      body: "You have a new message",
      pushable: false,
    });
    expect(renderNotice(content({ kind: "unknown_kind", language: "ar" }))).toEqual({
      title: "مهرجان الشتاء",
      body: "لديك رسالة جديدة",
      pushable: false,
    });
  });

  it("never fills a placeholder outside the allowlist", () => {
    const rendered = renderNotice(
      content({ kind: "test_leak", params: { username: { en: "sara_k" } } }),
      TEXTS,
    );
    expect(rendered.body).toBe("Hello");
  });

  it("never lets a name with digits, @, :// or control characters reach a rendered push (random names)", () => {
    let seed = 20261028;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const invisible = [0x07, 0x200e, 0xfe0f].map((code) => String.fromCharCode(code));
    const alphabet = ["a", "ب", " ", ".", "@", "://", "0", "9", "٣", "x", ...invisible];
    const bad = (text: string): boolean =>
      text.includes("@") ||
      text.includes("://") ||
      /[0-9٠-٩]{9}/.test(text) ||
      invisible.some((char) => text.includes(char));
    for (let round = 0; round < 500; round += 1) {
      const length = 1 + Math.floor(next() * 30);
      let name = "";
      for (let i = 0; i < length; i += 1)
        name += alphabet[Math.floor(next() * alphabet.length)] ?? "";
      const rendered = renderNotice(
        content({ params: { event: { en: name }, quest: { en: name } } }),
        TEXTS,
      );
      expect(bad(rendered.title), name).toBe(false);
      expect(bad(rendered.body), name).toBe(false);
      expect(rendered.body.includes(name.trim()) && pushName({ en: name }, "en") === null).toBe(
        false,
      );
    }
  });
});

/** A shipped kind's body in English, then Arabic, in Riyadh's zone. */
const both = (kind: string, params: Record<string, unknown>) =>
  (["en", "ar"] as const).map(
    (language) =>
      renderNotice({ kind, params, terms: null, timezone: "Asia/Riyadh", language }).body,
  );

describe("the personal pushes (T-501d, ADR-353)", () => {
  const AT = "2026-10-29T13:30:00Z";

  it("says each decision and answer in fixed text, with no name to fill", () => {
    // An acceptance can come before the start (a scheduled private event): it never says "play now".
    expect(both("join_accepted", {})).toEqual([
      "Your request to join was accepted.",
      "قُبل طلب انضمامك.",
    ]);
    expect(both("join_declined", {})).toEqual([
      "Your request to join wasn't accepted.",
      "لم يُقبل طلب انضمامك.",
    ]);
    expect(both("help_answered", {})).toEqual([
      "The event team answered you.",
      "ردّ عليك فريق الفعالية.",
    ]);
    expect(both("help_answered_questify", {})).toEqual([
      "The Questify team answered you.",
      "ردّ عليك فريق Questify.",
    ]);
    expect(both("help_solved", {})).toEqual(["Your request was marked solved.", "حُلّ طلبك."]);
  });

  it("names the prize and its deadline's date and time in the event's zone", () => {
    expect(
      both("rank_prize", { reward: { ar: "كأس", en: "Gold cup" }, date: AT, time: AT }),
    ).toEqual([
      "You won a prize: Gold cup. Collect it at the prize desk by 29 Oct, 16:30.",
      "فزت بجائزة: كأس. يمكنك استلامها من مكتب الجوائز حتى 29 أكتوبر، الساعة 16:30.",
    ]);
    expect(both("rank_prize", { reward: { en: "win.sa" }, date: AT, time: AT })).toEqual([
      "You won a prize. Collect it at the prize desk by 29 Oct, 16:30.",
      "فزت بجائزة. يمكنك استلامها من مكتب الجوائز حتى 29 أكتوبر، الساعة 16:30.",
    ]);
  });

  it("names the quest of a decision, never the reason", () => {
    const quest = { ar: "ابحث عن الصقر", en: "Find the falcon" };
    expect(both("submission_approved", { quest })).toEqual([
      "Your answer to “Find the falcon” was approved.",
      "قُبلت إجابتك في «ابحث عن الصقر».",
    ]);
    expect(both("submission_rejected", { quest })).toEqual([
      "Your answer to “Find the falcon” wasn't accepted. You can open it to see why.",
      "لم تُقبل إجابتك في «ابحث عن الصقر». يمكنك فتحها لمعرفة السبب.",
    ]);
    expect(both("submission_rejected", { reason: { en: "Too short" } })).toEqual([
      "Your answer wasn't accepted. You can open it to see why.",
      "لم تُقبل إجابتك. يمكنك فتحها لمعرفة السبب.",
    ]);
    expect(both("submission_approved", {})).toEqual(["Your answer was approved.", "قُبلت إجابتك."]);
  });

  it("names the reward and, for a hold ending, the time it ends", () => {
    const reward = { ar: "قبعة", en: "Cap" };
    expect(both("reward_ready", { reward })).toEqual([
      "Your reward “Cap” is ready at the prize desk.",
      "جائزتك «قبعة» جاهزة للاستلام من مكتب الجوائز.",
    ]);
    expect(both("reward_ready", {})).toEqual([
      "Your reward is ready at the prize desk.",
      "جائزتك جاهزة للاستلام من مكتب الجوائز.",
    ]);
    expect(both("reward_ending", { reward, time: AT })).toEqual([
      "Your reward “Cap” is held for you until 16:30.",
      "جائزتك «قبعة» محجوزة لك حتى الساعة 16:30.",
    ]);
    expect(both("reward_ending", { time: AT })).toEqual([
      "Your reward is held for you until 16:30.",
      "جائزتك محجوزة لك حتى الساعة 16:30.",
    ]);
  });

  it("never pushes a deadline it cannot show", () => {
    expect(renderNotice({ ...content({ kind: "rank_prize" }), params: { reward: {} } })).toEqual({
      title: "Questify",
      body: "You have a new message",
      pushable: false,
    });
  });
});

describe("pushName and pushMoment", () => {
  it("prefers the language asked for and refuses what fails the rule", () => {
    expect(pushName({ ar: "صقر", en: "Falcon" }, "ar")).toBe("صقر");
    expect(pushName({ ar: "صقر", en: "Falcon" }, "en")).toBe("Falcon");
    expect(pushName({ ar: "  ", en: "Falcon" }, "ar")).toBe("Falcon");
    expect(pushName({ en: "a.b" }, "en")).toBeNull();
    expect(pushName(["Falcon"], "en")).toBeNull();
  });

  it("reads an instant or answers null", () => {
    expect(pushMoment("2026-10-29T21:00:00Z", "date", "Asia/Riyadh", "en")).toBe("30 Oct");
    expect(pushMoment("2026-10-29T21:00:00Z", "time", null, "en")).toBe("00:00");
    expect(pushMoment(12, "date", "Asia/Riyadh", "en")).toBeNull();
    expect(pushMoment("2026-10-29T21:00:00Z", "date", "Not/AZone", "en")).toBeNull();
  });
});

describe("the template registry", () => {
  it("holds only templates within the allowlist, the same placeholders in both languages", () => {
    for (const [kind, template] of Object.entries(PUSH_TEMPLATES)) {
      expect(pushTemplateIssues(template), kind).toEqual([]);
    }
    for (const [kind, template] of Object.entries(TEXTS.templates)) {
      const issues = pushTemplateIssues(template, FIXTURE_MESSAGES);
      expect(issues, kind).toEqual(
        kind === "test_leak" ? ["push.test_leak.body: {username} is not allowed in a push"] : [],
      );
    }
  });

  it("flags a missing text, differing languages and a nameless body that names", () => {
    const messages: Messages = {
      "a.body": { ar: "{quest}", en: "{quest} {date}" },
      "a.nameless": { ar: "{reward}", en: "{reward}" },
    };
    expect(pushTemplateIssues({ body: "a.body", nameless: "a.nameless" }, messages)).toEqual([
      "a.body: the languages differ in placeholders",
      "a.nameless: a nameless body names {reward}",
    ]);
    expect(pushTemplateIssues({ body: "x", nameless: "a.nameless" }, messages)[0]).toBe(
      "x: no such text",
    );
  });

  it("allows only public names, a date or time and the event's words", () => {
    expect([...PUSH_PLACEHOLDERS].sort()).toEqual([
      "category",
      "categoryCap",
      "categoryMany",
      "categoryOne",
      "categoryOneCap",
      "date",
      "event",
      "playerCap",
      "playerMany",
      "playerOne",
      "playerOneCap",
      "quest",
      "questCap",
      "questMany",
      "questOne",
      "questOneCap",
      "reward",
      "time",
    ]);
  });
});
