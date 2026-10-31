import { DEFAULT_TERMS, FRESH_SETUP, SETUP_STEPS, stepNumber } from "@questify/shared";
import { describe, expect, it } from "vitest";
import { translatorFor } from "#src/lib/language.ts";
import {
  alonePath,
  readOverrides,
  readSetup,
  setupPath,
  stepNameKey,
  stepOfPage,
  stepOfQuery,
  stepTitleKey,
  withOverrides,
} from "#src/lib/setup.ts";

const base = { language: "en", organizerId: "o1", eventId: "e1" } as const;

describe("guided setup helpers", () => {
  it("builds the wizard's address, with a step and the single-step mode", () => {
    expect(setupPath(base)).toBe("/en/organizers/o1/events/e1/setup");
    expect(setupPath(base, { step: "rewards" })).toBe(
      "/en/organizers/o1/events/e1/setup?step=rewards",
    );
    expect(setupPath(base, { step: "rewards", only: true })).toBe(
      "/en/organizers/o1/events/e1/setup?step=rewards&only=1",
    );
    expect(setupPath(base, { step: "rewards", only: true, from: "rewards" })).toBe(
      "/en/organizers/o1/events/e1/setup?step=rewards&only=1&from=rewards",
    );
  });

  it("reads a step from the query and refuses a name that is not a step", () => {
    expect(stepOfQuery("sponsors")).toBe("sponsors");
    expect(stepOfQuery("nope")).toBeUndefined();
    expect(stepOfQuery(null)).toBeUndefined();
    expect(stepOfQuery("")).toBeUndefined();
  });

  it("maps the build pages to the step that explains them", () => {
    expect(stepOfPage("rewards")).toBe("rewards");
    expect(stepOfPage("prizes")).toBeUndefined();
    expect(stepOfPage("big-screen")).toBe("screens");
    expect(stepOfPage("operators")).toBeUndefined();
    expect(stepOfPage("players")).toBeUndefined();
    expect(stepOfPage("")).toBeUndefined();
  });

  it("names every step with an Arabic and an English text", () => {
    for (const step of SETUP_STEPS) {
      for (const language of ["ar", "en"] as const) {
        const t = translatorFor(language);
        expect(t(stepNameKey(step)), step).not.toBe(stepNameKey(step));
        expect(t(stepTitleKey(step)), step).not.toBe(stepTitleKey(step));
      }
    }
    expect(SETUP_STEPS.map(stepNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("reads the API's progress and drops an answer of another shape", () => {
    expect(readSetup({ setup: { ...FRESH_SETUP, updatedAt: null } })).toEqual(FRESH_SETUP);
    expect(
      readSetup({ setup: { ...FRESH_SETUP, steps: ["open"], updatedAt: null } }),
    ).toBeUndefined();
    expect(readSetup(undefined)).toBeUndefined();
    expect(readSetup("text")).toBeUndefined();
  });

  it("keeps only text overrides", () => {
    expect(readOverrides({ ar: { a: "x", b: 4 }, en: "no" })).toEqual({ ar: { a: "x" }, en: {} });
    expect(readOverrides(undefined)).toEqual({ ar: {}, en: {} });
    expect(readOverrides(null)).toEqual({ ar: {}, en: {} });
  });
});

describe("the wizard's translator", () => {
  const english = translatorFor("en");
  const arabic = translatorFor("ar");

  it("shows an admin's changed text in place of the shipped one", () => {
    const t = withOverrides(english, "en", DEFAULT_TERMS, {
      ar: {},
      en: { "wizard.sponsors.title": "Who backs your event?" },
    });
    expect(t("wizard.sponsors.title")).toBe("Who backs your event?");
    expect(t("wizard.rewards.name")).toBe("Rewards");
  });

  it("falls back to the shipped text for a blank text or a missing placeholder", () => {
    const t = withOverrides(english, "en", DEFAULT_TERMS, {
      ar: {},
      en: { "wizard.sponsors.title": "   ", "wizard.quests.title": "Which kinds will you use?" },
    });
    expect(t("wizard.sponsors.title")).toBe("Do you have sponsors?");
    expect(t("wizard.quests.title")).toBe(english("wizard.quests.title"));
  });

  it("fills the event's words into a changed text and the other language is unaffected", () => {
    const changed = withOverrides(english, "en", DEFAULT_TERMS, {
      ar: {},
      en: { "wizard.quests.title": "Where do {questMany} start?" },
    });
    expect(changed("wizard.quests.title")).toBe("Where do quests start?");
    const other = withOverrides(arabic, "ar", DEFAULT_TERMS, {
      ar: {},
      en: { "wizard.quests.title": "Where do {questMany} start?" },
    });
    expect(other("wizard.quests.title")).toBe(arabic("wizard.quests.title"));
  });
});

describe("alonePath", () => {
  it("opens the numbered step alone and keeps the page Done returns to", () => {
    expect(alonePath(base, 4, "rewards")).toBe(
      "/en/organizers/o1/events/e1/setup?step=rewards&only=1&from=rewards",
    );
    expect(alonePath(base, 1, undefined)).toBe(
      "/en/organizers/o1/events/e1/setup?step=basics&only=1",
    );
  });
});
