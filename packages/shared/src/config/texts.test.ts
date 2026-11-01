import { describe, expect, it } from "vitest";
import { MESSAGES } from "#src/i18n/messages";
import { createTranslator } from "#src/i18n/translate";
import type { MessageKey } from "#src/i18n/messages";
import { DEFAULT_TERMS, wordParams } from "./terms";
import {
  EVENT_TEXT_KEYS,
  EVENT_TEXT_MAX,
  NO_EVENT_TEXTS,
  readEventTexts,
  validateEventTexts,
  withEventTexts,
  type TextCatalog,
} from "./texts";

const PRIZES = { ar: { "nav.rewards": "الهدايا" }, en: { "nav.rewards": "Prizes" } };

// No label on the approved list carries a count yet; this catalog has one that does.
const withCount: TextCatalog = {
  messages: {
    "nav.left": { ar: "المتبقي {count}", en: "{count} left" },
    "nav.quests": MESSAGES["nav.quests"],
  },
  approved: ["nav.left", "nav.quests"],
};

const issuesOf = (input: unknown, catalog?: TextCatalog) => {
  const result = validateEventTexts(input, catalog);
  return result.ok ? [] : result.issues;
};

describe("the approved list", () => {
  it("names only short labels the app ships, none of them legal, consent or store text", () => {
    for (const key of EVENT_TEXT_KEYS) {
      expect(key.startsWith("nav."), key).toBe(true);
      expect(MESSAGES[key], key).toBeDefined();
      for (const language of ["ar", "en"] as const) {
        const shown = MESSAGES[key][language].replace(/\{(\w+)\}/g, "word");
        expect(shown.length, `${key} ${language}`).toBeLessThanOrEqual(EVENT_TEXT_MAX);
      }
    }
  });
});

describe("validateEventTexts", () => {
  it("accepts an override in both languages and returns what to store", () => {
    expect(validateEventTexts(PRIZES)).toStrictEqual({ ok: true, value: PRIZES });
  });

  it("accepts one language alone, and nothing at all", () => {
    expect(validateEventTexts({ en: PRIZES.en })).toStrictEqual({
      ok: true,
      value: { ar: {}, en: PRIZES.en },
    });
    expect(validateEventTexts({})).toStrictEqual({ ok: true, value: NO_EVENT_TEXTS });
  });

  it("leaves a blank text out, so the platform text shows", () => {
    expect(
      validateEventTexts({ ar: { "nav.rewards": "   " }, en: { "nav.rewards": "" } }),
    ).toStrictEqual({ ok: true, value: NO_EVENT_TEXTS });
  });

  it("trims, collapses spaces and writes Arabic-Indic digits as 0-9", () => {
    const result = validateEventTexts({
      ar: { "nav.scan": "  امسح   ٢٠٢٦ " },
      en: { "nav.scan": "\tScan​  now\u0000" },
    });
    expect(result).toStrictEqual({
      ok: true,
      value: { ar: { "nav.scan": "امسح 2026" }, en: { "nav.scan": "Scan now" } },
    });
  });

  it("removes bidi override and control characters instead of keeping them", () => {
    const result = validateEventTexts({ en: { "nav.rewards": "‮sezirP‬\u0007" } });
    expect(result).toStrictEqual({
      ok: true,
      value: { ar: {}, en: { "nav.rewards": "sezirP" } },
    });
  });

  it("refuses a key that is not on the approved list, named by language and key", () => {
    for (const key of [
      "legal.terms.title",
      "wizard.rewards.name",
      "common.loading",
      "__proto__",
      "constructor",
    ]) {
      expect(issuesOf({ en: { [key]: "x" } }), key).toEqual([
        { path: `en.${key}`, message: "is not a text an event can change" },
      ]);
    }
  });

  it("refuses every legal and consent text the app ships", () => {
    const legal = Object.keys(MESSAGES).filter((key) =>
      /^(legal|consent|acceptance|terms|privacy|guidelines|delete|account)\b/i.test(key),
    );
    expect(legal.length).toBeGreaterThan(5);
    for (const key of legal) {
      expect(validateEventTexts({ ar: { [key]: "x" }, en: { [key]: "x" } }).ok, key).toBe(false);
    }
  });

  it("refuses a text longer than the limit, counted in characters", () => {
    expect(validateEventTexts({ en: { "nav.rewards": "a".repeat(EVENT_TEXT_MAX) } }).ok).toBe(true);
    expect(issuesOf({ en: { "nav.rewards": "a".repeat(EVENT_TEXT_MAX + 1) } })).toEqual([
      { path: "en.nav.rewards", message: `must have at most ${EVENT_TEXT_MAX} characters` },
    ]);
    expect(validateEventTexts({ en: { "nav.rewards": "😀".repeat(EVENT_TEXT_MAX) } }).ok).toBe(
      true,
    );
  });

  it("refuses a placeholder the shipped text does not have", () => {
    expect(issuesOf({ en: { "nav.rewards": "{count} prizes" } })).toEqual([
      { path: "en.nav.rewards", message: "uses {count}, which this text does not have" },
    ]);
  });

  it("refuses an override that drops a placeholder carrying a value", () => {
    expect(issuesOf({ en: { "nav.left": "Remaining" } }, withCount)).toEqual([
      { path: "en.nav.left", message: "is missing {count}" },
    ]);
    expect(issuesOf({ ar: { "nav.left": "{count} باقٍ" } }, withCount)).toEqual([]);
    expect(issuesOf({ en: { "nav.left": "Only {count} to go" } }, withCount)).toEqual([]);
  });

  it("lets a label drop the event's own word placeholder, but not use another one", () => {
    expect(issuesOf({ en: { "nav.quests": "Adventures" } })).toEqual([]);
    expect(issuesOf({ en: { "nav.quests": "Big {questCap}" } })).toEqual([]);
    expect(issuesOf({ en: { "nav.quests": "{playerCap}" } })).toEqual([
      { path: "en.nav.quests", message: "uses {playerCap}, which this text does not have" },
    ]);
  });

  it("names every problem, not only the first", () => {
    expect(
      issuesOf({ ar: { "nav.rewards": "{x}" }, en: { "nav.rewards": "{y}", "nav.fake": "z" } })
        .map((issue) => issue.path)
        .sort(),
    ).toEqual(["ar.nav.rewards", "en.nav.fake", "en.nav.rewards"]);
  });

  it("refuses shapes that are not texts", () => {
    for (const input of [null, "text", 5, [], { fr: {} }, { en: [] }, { en: { "nav.home": 5 } }]) {
      expect(validateEventTexts(input).ok, JSON.stringify(input)).toBe(false);
    }
  });

  it("stores the keys in the list's order, so equal texts are one document", () => {
    const first = validateEventTexts({ en: { "nav.profile": "Me", "nav.home": "Start" } });
    const second = validateEventTexts({ en: { "nav.home": "Start", "nav.profile": "Me" } });
    expect(first).toStrictEqual(second);
    expect(first.ok && Object.keys(first.value.en)).toEqual(["nav.home", "nav.profile"]);
  });
});

describe("readEventTexts", () => {
  it("reads what was stored", () => {
    expect(readEventTexts(PRIZES)).toStrictEqual({ ...NO_EVENT_TEXTS, ...PRIZES });
  });

  it("gives no override for nothing, damage or the wrong shape", () => {
    for (const stored of [undefined, null, "x", 5, [], { ar: "x", en: [] }, { ar: null }]) {
      expect(readEventTexts(stored), JSON.stringify(stored)).toStrictEqual(NO_EVENT_TEXTS);
    }
  });

  it("drops a key that is not approved, a blank, a too long text and an unsafe one", () => {
    const stored = {
      ar: { "legal.terms.title": "x", "nav.home": "   ", "nav.scan": "ا".repeat(25) },
      en: { "nav.rewards": "Pri‮zes", "nav.profile": 5, "nav.ranking": "Board" },
    };
    expect(readEventTexts(stored)).toStrictEqual({ ar: {}, en: { "nav.ranking": "Board" } });
  });

  it("drops a text with a placeholder the label does not have, and keeps one that drops a word", () => {
    const stored = { en: { "nav.rewards": "{points}", "nav.quests": "Adventures" } };
    expect(readEventTexts(stored)).toStrictEqual({ ar: {}, en: { "nav.quests": "Adventures" } });
  });

  it("drops a text that lost a placeholder carrying a value", () => {
    expect(readEventTexts({ en: { "nav.left": "Remaining" } }, withCount).en).toEqual({});
    expect(readEventTexts({ en: { "nav.left": "{count} to go" } }, withCount).en).toEqual({
      "nav.left": "{count} to go",
    });
  });
});

describe("withEventTexts", () => {
  const texts = readEventTexts({
    ar: { "nav.rewards": "الهدايا", "nav.quests": "مغامرات" },
    en: { "nav.rewards": "Prizes", "nav.quests": "Daily {questCap}" },
  });
  const shipped = createTranslator(MESSAGES);
  const t = (key: MessageKey, language: "ar" | "en", params?: Record<string, string>) =>
    withEventTexts(
      (name: MessageKey, values) => shipped(name, language, values),
      texts,
      language,
    )(key, params);

  it("shows the override in each language and the platform text elsewhere", () => {
    expect(t("nav.rewards", "en")).toBe("Prizes");
    expect(t("nav.rewards", "ar")).toBe("الهدايا");
    expect(t("nav.scan", "en")).toBe("Scan");
    expect(t("nav.scan", "ar")).toBe(MESSAGES["nav.scan"].ar);
  });

  it("shows a language with no override in the platform's text", () => {
    const englishOnly = withEventTexts(
      (name: MessageKey) => shipped(name, "ar"),
      readEventTexts({ en: { "nav.rewards": "Prizes" } }),
      "ar",
    );
    expect(englishOnly("nav.rewards")).toBe(MESSAGES["nav.rewards"].ar);
  });

  it("fills the event's own word into a label that kept its placeholder, and replaces one that dropped it", () => {
    expect(t("nav.quests", "en", wordParams(DEFAULT_TERMS, "en"))).toBe("Daily Quests");
    expect(t("nav.quests", "ar", wordParams(DEFAULT_TERMS, "ar"))).toBe("مغامرات");
  });

  it("never reads a key the texts only inherit", () => {
    const inherited = withEventTexts((name: string) => `shipped ${name}`, NO_EVENT_TEXTS, "en");
    expect(inherited("constructor")).toBe("shipped constructor");
  });
});
