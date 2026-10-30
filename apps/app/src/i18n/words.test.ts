import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TERMS,
  MESSAGES,
  NO_OVERRIDES,
  createTranslator,
  readEventTerms,
  type EventTerms,
  type Language,
} from "@questify/shared";
import { withWords } from "#src/i18n/words.ts";

const translate = createTranslator(MESSAGES, NO_OVERRIDES);

const translatorFor = (terms: EventTerms, language: Language) =>
  withWords((key, params) => translate(key, language, params), terms, language);

const MISSIONS = readEventTerms({
  quest: { ar: { one: "مغامرة", many: "مغامرات" }, en: { one: "mission", many: "missions" } },
  category: { ar: { one: "مرحلة", many: "مراحل" }, en: { one: "stage", many: "stages" } },
  player: { ar: { one: "طالب", many: "طلاب" }, en: { one: "student", many: "students" } },
});

describe("withWords", () => {
  it("shows Questify's own words when the event renames none", () => {
    expect(translatorFor(DEFAULT_TERMS, "en")("nav.quests")).toBe("Quests");
    expect(translatorFor(DEFAULT_TERMS, "ar")("nav.quests")).toBe("مهام");
    expect(translatorFor(DEFAULT_TERMS, "en")("questsTab.notOpen.ended")).toBe(
      "This quest has ended.",
    );
  });

  it("shows an event that renamed 'quest' to 'mission' as Missions, in English", () => {
    const t = translatorFor(MISSIONS, "en");
    expect(t("nav.quests")).toBe("Missions");
    expect(t("questsTab.notOpen.notStarted")).toBe("This mission hasn't started yet.");
    expect(t("history.quest", { title: "Find the fox" })).toBe("Mission: Find the fox");
    expect(t("questsTab.category.inOrder")).toBe("In order: each mission opens the next");
    expect(t("scanner.revealed", { name: "Vault" })).toBe("You found a secret stage: Vault");
  });

  it("shows the Arabic words as the organizer typed them", () => {
    const t = translatorFor(MISSIONS, "ar");
    expect(t("nav.quests")).toBe("مغامرات");
    expect(t("history.quest", { title: "ابحث عن الثعلب" })).toBe("مغامرة: ابحث عن الثعلب");
    expect(t("eventHome.noRank")).toBe("أنجز مغامرة لتدخل الترتيب.");
    expect(
      t("questsTab.summary", { currency: "جواهر", earned: 1, available: 9, finished: 2, total: 4 }),
    ).toBe("جواهر: 1 / 9 · مغامرات: 2 / 4");
  });

  it("fills the player word into staff texts", () => {
    expect(translatorFor(MISSIONS, "en")("operator.noStations")).toBe(
      "No mission takes student codes yet. Ask the organizer to turn it on.",
    );
    expect(translatorFor(MISSIONS, "ar")("operator.noStations")).toBe(
      "لا شيء يقبل مسح رمز طالب بعد. اطلب من المنظِّم تفعيله.",
    );
  });

  it("lets a screen's own value win over the event's word", () => {
    const t = translatorFor(MISSIONS, "en");
    expect(t("history.quest", { title: "x", questOneCap: "Task" })).toBe("Task: x");
  });

  it("leaves no event-word placeholder unfilled in any text", () => {
    for (const language of ["ar", "en"] as const) {
      const t = translatorFor(MISSIONS, language);
      for (const key of Object.keys(MESSAGES)) {
        expect(t(key as keyof typeof MESSAGES), key).not.toMatch(
          /\{(quest|category|player)(One|Many|Cap|OneCap)\}/,
        );
      }
    }
  });
});

const ROOT = join(__dirname, "..", "..");
const SCANNED = [
  "app/operator",
  "src/operator",
  "app/event",
  "src/event",
  "src/components",
  "src/nfc",
  "src/screens",
];

function sourceFiles(directory: string): string[] {
  return readdirSync(join(ROOT, directory), { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

/** The message keys a source file names as string literals, such as `t("quests.title")` or a table of reasons. */
function keysNamedIn(files: readonly string[]): Set<string> {
  const found = new Set<string>();
  for (const file of files) {
    for (const match of readFileSync(file, "utf8").matchAll(
      /"([a-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+)"/g,
    )) {
      const key = match[1] ?? "";
      if (key in MESSAGES) {
        found.add(key);
      }
    }
  }
  return found;
}

// A {placeholder} such as {quest} or {player} carries a name or a title, not a word, so it is not text.
const prose = (text: string): string => text.replace(/\{[A-Za-z0-9]+\}/g, "");

const HARD_CODED_AR = /مهم|فئ/;
const HARD_CODED_EN = /\b(quests?|categor(?:y|ies))\b/i;

// Questify-level texts that an event's words never reach (FR-942: Questify home keeps the defaults), with why.
const QUESTIFY_LEVEL = new Set<string>(["locker.empty"]); // Lifetime locker, outside any event vocabulary.

// "Player mode" is the app's mode beside staff mode, not the event's word for its people.
const PLAYER_MODE = new Set<string>([
  "operator.playerMode",
  "operator.switchToPlayer",
  "profile.public",
]);

describe("texts of staff mode and the event screens", () => {
  const keys = new Set([
    ...keysNamedIn(SCANNED.flatMap(sourceFiles)),
    ...Object.keys(MESSAGES).filter((key) => key.startsWith("operator.")),
  ]);

  it("finds the texts these screens use", () => {
    expect(keys.size).toBeGreaterThan(300);
    expect(keys.has("operator.red.questNotOpen")).toBe(true);
    expect(keys.has("questsTab.empty")).toBe(true);
  });

  it("never hard-codes 'quest' or 'category' where the event's word applies (FR-942)", () => {
    const hardCoded = [...keys]
      .filter((key) => !QUESTIFY_LEVEL.has(key))
      .filter((key) => {
        const text = MESSAGES[key as keyof typeof MESSAGES];
        return HARD_CODED_AR.test(prose(text.ar)) || HARD_CODED_EN.test(prose(text.en));
      });
    expect(hardCoded).toEqual([]);
  });

  it("never hard-codes the player word where the event's applies (FR-941)", () => {
    const hardCoded = [...keys]
      .filter((key) => !PLAYER_MODE.has(key))
      .filter((key) => {
        const text = MESSAGES[key as keyof typeof MESSAGES];
        return /لاعب/.test(prose(text.ar)) || /\bplayers?\b/i.test(prose(text.en));
      });
    expect(hardCoded).toEqual([]);
  });
});
