import { readEventTerms } from "@questify/shared";
import { describe, expect, it } from "vitest";
import {
  directionOf,
  isolate,
  languageCookie,
  negotiateLanguage,
  otherLanguage,
  pathAfterLanguage,
  translatorFor,
} from "#src/lib/language.ts";

describe("negotiateLanguage", () => {
  it("uses the saved choice first", () => {
    expect(negotiateLanguage("ar", "en-US,en;q=0.9")).toBe("ar");
    expect(negotiateLanguage("en", "ar-SA")).toBe("en");
  });

  it("ignores a saved value that is not a language", () => {
    expect(negotiateLanguage("fr", "ar-SA")).toBe("ar");
    expect(negotiateLanguage("", "ar")).toBe("ar");
  });

  it("takes the browser's best Arabic or English entry by preference", () => {
    expect(negotiateLanguage(undefined, "fr-FR,ar-SA;q=0.8,en;q=0.5")).toBe("ar");
    expect(negotiateLanguage(undefined, "en;q=0.2, ar;q=0.9")).toBe("ar");
    expect(negotiateLanguage(undefined, "EN-gb")).toBe("en");
  });

  it("keeps the browser's order when weights are equal, and skips refused languages", () => {
    expect(negotiateLanguage(undefined, "en, ar")).toBe("en");
    expect(negotiateLanguage(undefined, "ar;q=0, en;q=0.1")).toBe("en");
  });

  it("falls back to English for any other language or no header", () => {
    expect(negotiateLanguage(undefined, "fr-FR,de")).toBe("en");
    expect(negotiateLanguage(undefined, null)).toBe("en");
    expect(negotiateLanguage(undefined, "")).toBe("en");
  });
});

describe("language helpers", () => {
  it("pairs each language with the other and with its direction", () => {
    expect(otherLanguage("ar")).toBe("en");
    expect(otherLanguage("en")).toBe("ar");
    expect(directionOf("ar")).toBe("rtl");
    expect(directionOf("en")).toBe("ltr");
  });

  it("takes the language off an address and leaves the rest as it is", () => {
    expect(pathAfterLanguage("/en/console/tickets")).toBe("/console/tickets");
    expect(pathAfterLanguage("/ar/organizers/o1/events")).toBe("/organizers/o1/events");
    expect(pathAfterLanguage("/en")).toBe("");
    expect(pathAfterLanguage("/english/page")).toBe("/english/page");
  });

  it("remembers the language for a year, site-wide, secure, readable by the page", () => {
    expect(languageCookie("ar")).toBe("qs_lang=ar; Path=/; Max-Age=31536000; SameSite=Lax; Secure");
  });

  it("isolates left-to-right text placed inside a sentence", () => {
    expect(isolate("a@b.sa")).toBe(
      `${String.fromCodePoint(0x2068)}a@b.sa${String.fromCodePoint(0x2069)}`,
    );
  });

  it("translates the shipped texts with their placeholders, digits Western", () => {
    expect(translatorFor("ar")("staff.attemptsLeft", { count: 3 })).toBe("المحاولات المتبقية: 3");
    expect(translatorFor("en")("staff.signIn")).toBe("Sign in");
  });

  it("hands back the same translator for a language, so hooks that depend on it do not loop", () => {
    expect(translatorFor("ar")).toBe(translatorFor("ar"));
    expect(translatorFor("en")).toBe(translatorFor("en"));
    expect(translatorFor("ar")).not.toBe(translatorFor("en"));
  });

  it("hands back the same translator for the same event words, however often they are read", () => {
    expect(translatorFor("en", words("mission"))).toBe(translatorFor("en", words("mission")));
    expect(translatorFor("en", words("mission"))).not.toBe(translatorFor("en", words("task")));
    expect(translatorFor("en", words("mission"))).not.toBe(translatorFor("en"));
    expect(translatorFor("en", readEventTerms({}))).toBe(translatorFor("en"));
  });

  it("keeps Questify's own translators and the latest events' after many other events", () => {
    const first = translatorFor("en", readEventTerms({ quest: wordOf(nameOf(0)) }));
    for (let index = 1; index <= 40; index += 1) {
      translatorFor("en", readEventTerms({ quest: wordOf(nameOf(index)) }));
    }
    expect(translatorFor("en")).toBe(translatorFor("en"));
    const latest = readEventTerms({ quest: wordOf(nameOf(40)) });
    expect(translatorFor("en", latest)).toBe(translatorFor("en", latest));
    expect(translatorFor("en", readEventTerms({ quest: wordOf(nameOf(0)) }))).not.toBe(first);
  });

  it("evicts the event used longest ago, not the one built first", () => {
    const kept = readEventTerms({ quest: wordOf(nameOf(100)) });
    const keptTranslator = translatorFor("en", kept);
    for (let index = 101; index <= 120; index += 1) {
      translatorFor("en", readEventTerms({ quest: wordOf(nameOf(index)) }));
      expect(translatorFor("en", kept)).toBe(keptTranslator);
    }
  });

  it("fills the event's quest and category words into the texts that name them", () => {
    const terms = readEventTerms({
      quest: { ar: { one: "مغامرة", many: "مغامرات" }, en: { one: "mission", many: "missions" } },
    });
    expect(translatorFor("en", terms)("quests.addQuest")).toBe("Add mission");
    expect(translatorFor("en")("quests.addQuest")).toBe("Add quest");
  });
});

const words = (one: string) =>
  readEventTerms({
    quest: { ar: { one: "مغامرة", many: "مغامرات" }, en: { one, many: `${one}s` } },
  });

// Words cannot hold digits, so the nth name is written in letters.
const nameOf = (index: number): string =>
  String.fromCodePoint(97 + Math.floor(index / 26), 97 + (index % 26));

const wordOf = (name: string) => ({
  ar: { one: "كلمة", many: "كلمات" },
  en: { one: name, many: `${name}s` },
});
