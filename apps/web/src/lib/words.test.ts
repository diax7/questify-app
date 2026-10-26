import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MESSAGES, readEventTerms, type MessageKey } from "@questify/shared";
import { translatorFor } from "#src/lib/language.ts";

const MISSIONS = readEventTerms({
  quest: { ar: { one: "مغامرة", many: "مغامرات" }, en: { one: "mission", many: "missions" } },
  category: { ar: { one: "مرحلة", many: "مراحل" }, en: { one: "stage", many: "stages" } },
});

describe("the dashboard's texts with an event's quest and category words", () => {
  it("shows Questify's own words when the event renames none", () => {
    expect(translatorFor("en")("quests.addQuest")).toBe("Add quest");
    expect(translatorFor("ar")("quests.addQuest")).toBe("إضافة مهمة");
    expect(translatorFor("ar")("quests.addCategory")).toBe("إضافة فئة");
  });

  it("shows an event that renamed 'quest' to 'mission' as Add mission, in English", () => {
    const t = translatorFor("en", MISSIONS);
    expect(t("quests.addQuest")).toBe("Add mission");
    expect(t("quests.addCategory")).toBe("Add stage");
    expect(t("quests.title")).toBe("Missions");
    expect(t("codes.empty")).toBe("No missions with codes yet. Add one that uses a QR.");
    expect(t("operators.quests")).toBe("Allowed missions");
    expect(t("events.flashQuests.title")).toBe("Flash missions");
    expect(t("boosts.page.category")).toBe("Stage");
    expect(t("questItems.title")).toBe("Mission items");
  });

  it("shows the Arabic words as the organizer typed them, with no article or agreement", () => {
    const t = translatorFor("ar", MISSIONS);
    expect(t("quests.addQuest")).toBe("إضافة مغامرة");
    expect(t("quests.addCategory")).toBe("إضافة مرحلة");
    expect(t("quests.title")).toBe("مغامرات");
    expect(t("events.community.title")).toBe("مغامرات للجميع");
    expect(t("codes.secret")).toBe("الرمز السري لمرحلة");
    expect(t("operators.quests")).toBe("السماح بمسح مغامرات");
  });

  it("fills a text that names the word twice", () => {
    expect(translatorFor("en", MISSIONS)("questItems.removeBody")).toBe(
      "Items already reserved for players stay reserved. Unlink it from every mission and stage first.",
    );
  });

  it("leaves no event-word placeholder unfilled in any text", () => {
    for (const language of ["ar", "en"] as const) {
      const t = translatorFor(language, MISSIONS);
      for (const key of Object.keys(MESSAGES)) {
        expect(t(key as MessageKey, { name: "x" }), key).not.toMatch(
          /\{(quest|category|player)(One|Many|Cap|OneCap)\}/,
        );
      }
    }
  });
});

const SRC = join(__dirname, "..");

function sourceFiles(): string[] {
  return readdirSync(SRC, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

const SOURCES = sourceFiles().map((file) => ({ file, text: readFileSync(file, "utf8") }));

/** The keys the dashboard names: literal ones, and every key under a prefix it builds with `${...}`. */
function dashboardKeys(): Set<string> {
  const prefixes = new Set<string>();
  const found = new Set<string>();
  for (const { text } of SOURCES) {
    for (const match of text.matchAll(/`([a-z][A-Za-z.]*\.)\$\{/g)) {
      prefixes.add(match[1] ?? "");
    }
    for (const match of text.matchAll(/"([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+)"/g)) {
      if ((match[1] ?? "") in MESSAGES) {
        found.add(match[1] ?? "");
      }
    }
  }
  for (const key of Object.keys(MESSAGES)) {
    if ([...prefixes].some((prefix) => key.startsWith(prefix))) {
      found.add(key);
    }
  }
  return found;
}

// A {placeholder} such as {name} carries a title, not a word, so it is not text.
const prose = (text: string): string => text.replace(/\{[A-Za-z0-9]+\}/g, "");

const HARD_CODED_AR = /مهام|مهمة|فئ/;
const HARD_CODED_EN = /\b(quests?|categor(?:y|ies))\b/i;
const EVENT_WORD = /\{(quest|category|player)(One|Many|Cap|OneCap)\}/;

// Texts an event's words never reach, with why (FR-942: Questify-level pages keep the defaults).
const QUESTIFY_LEVEL: Readonly<Record<string, string>> = {
  "terms.intro": "the Event words form names the concepts it renames",
  "terms.word.quest": "the Event words form names the concepts it renames",
  "terms.word.category": "the Event words form names the concepts it renames",
  "scan.body": "the public page of a printed code does not know the event",
  "kiosk.notOpen": "the kiosk page does not load the event's words (Q-227)",
  "kiosk.methodOff": "the kiosk page does not load the event's words (Q-227)",
  "quests.location.note": "«المهمة» here is the adjective 'important', about prizes",
  "console.questify.field.titleAr": "Questify's own quests on the console, not an event's word",
  "console.questify.field.titleEn": "Questify's own quests on the console, not an event's word",
  "console.questify.field.metric": "Questify's own quests on the console, not an event's word",
  "console.questify.editQuest": "Questify's own quests on the console, not an event's word",
  "console.questify.retireQuest": "Questify's own quests on the console, not an event's word",
  "console.questify.newQuest": "Questify's own quests on the console, not an event's word",
  "console.questify.noQuests": "Questify's own quests on the console, not an event's word",
  "console.questify.title": "Questify's own quests on the console, not an event's word",
  "console.questify.alwaysOn": "Questify's own quests on the console, not an event's word",
  "console.questify.retiredQuest": "Questify's own quests on the console, not an event's word",
  "console.questify.conflict.started": "Questify's own quests on the console, not an event's word",
  "console.questify.conflict.frozen": "Questify's own quests on the console, not an event's word",
  "console.questify.conflict.tooMany": "Questify's own quests on the console, not an event's word",
  "console.questify.conflict.campaignClosed":
    "Questify's own quests on the console, not an event's word",
  "console.questify.metric.quests": "Questify's own quests on the console, not an event's word",
};

describe("the dashboard's source", () => {
  const keys = dashboardKeys();

  it("finds the texts the dashboard uses", () => {
    expect(keys.size).toBeGreaterThan(500);
    expect(keys.has("quests.addQuest")).toBe(true);
    expect(keys.has("quests.invalid.flash")).toBe(true);
  });

  it("never hard-codes 'quest' or 'category' where the event's word applies (FR-942)", () => {
    const hardCoded = [...keys]
      .filter((key) => !(key in QUESTIFY_LEVEL))
      .filter((key) => {
        const text = MESSAGES[key as MessageKey];
        return HARD_CODED_AR.test(prose(text.ar)) || HARD_CODED_EN.test(prose(text.en));
      });
    expect(hardCoded).toEqual([]);
  });

  it("lists only exceptions that still need one", () => {
    const needless = Object.keys(QUESTIFY_LEVEL).filter((key) => {
      const text = MESSAGES[key as MessageKey];
      return !HARD_CODED_AR.test(prose(text.ar)) && !HARD_CODED_EN.test(prose(text.en));
    });
    expect(needless).toEqual([]);
  });

  it("builds a component's translator with the event's words, not Questify's", () => {
    const direct = SOURCES.filter(({ file, text }) => {
      const namesWord = [...keys].some(
        (key) =>
          EVENT_WORD.test(MESSAGES[key as MessageKey].ar + MESSAGES[key as MessageKey].en) &&
          text.includes(`"${key}"`),
      );
      const inScope = namesWord || file.endsWith("useQuestBuilder.ts");
      return inScope && /\btranslatorFor\(/.test(text);
    }).map(({ file }) => file.slice(SRC.length + 1));
    expect(direct.filter((file) => !file.endsWith("EventWords.tsx"))).toEqual([]);
  });

  it("calls the translator hook only in components and hooks", () => {
    const misplaced: string[] = [];
    for (const { file, text } of SOURCES) {
      let enclosing = "";
      for (const line of text.split(/\r?\n/)) {
        enclosing = /^(?:export )?(?:async )?function (\w+)/.exec(line)?.[1] ?? enclosing;
        const isHookOrComponent = /^[A-Z]/.test(enclosing) || enclosing.startsWith("use");
        if (line.includes("useTranslator(") && !line.includes("import") && !isHookOrComponent) {
          misplaced.push(`${file.slice(SRC.length + 1)}: ${enclosing}`);
        }
      }
    }
    expect(misplaced).toEqual([]);
  });
});
