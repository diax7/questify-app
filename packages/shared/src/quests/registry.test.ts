import { describe, expect, it } from "vitest";
import { MESSAGES } from "#src/i18n/messages";
import {
  QR_QUEST_TYPES,
  QUEST_TYPES,
  QUEST_TYPE_NAMES,
  isQuestType,
  parseQuestConfig,
} from "#src/quests/registry";

describe("the quest-type registry", () => {
  it("names each type in both languages", () => {
    for (const type of QUEST_TYPE_NAMES) {
      expect(MESSAGES, type).toHaveProperty([QUEST_TYPES[type].label]);
    }
  });

  it("says for every type whether its quests carry a printed QR", () => {
    expect(QR_QUEST_TYPES).toEqual(["scan_qr"]);
    for (const type of QUEST_TYPE_NAMES) {
      expect(typeof QUEST_TYPES[type].usesQuestQr, type).toBe("boolean");
    }
  });

  it("knows its own types and nothing else", () => {
    expect(QUEST_TYPE_NAMES).toEqual(["scan_qr", "enter_code"]);
    expect(isQuestType("scan_qr")).toBe(true);
    expect(isQuestType("submission")).toBe(false);
    expect(isQuestType("toString")).toBe(false);
  });
});

describe("parseQuestConfig", () => {
  it("takes an empty config for a QR quest and refuses anything else in it", () => {
    expect(parseQuestConfig("scan_qr", {})).toEqual({});
    expect(parseQuestConfig("scan_qr", { code: "ABCD" })).toBeUndefined();
  });

  it("upper-cases an entry code and keeps a hint", () => {
    expect(
      parseQuestConfig("enter_code", { code: " najd2030 ", hint: { en: "On the stage screen" } }),
    ).toEqual({
      code: "NAJD2030",
      hint: { en: "On the stage screen" },
    });
  });

  it.each([
    ["too short", { code: "ABC" }],
    ["too long", { code: "A".repeat(33) }],
    ["not ASCII", { code: "نجد2030" }],
    ["with a space inside", { code: "NAJD 2030" }],
    ["missing", {}],
    ["with an unknown field", { code: "NAJD2030", points: 5 }],
    ["not an object", "NAJD2030"],
    ["with an empty hint", { code: "NAJD2030", hint: { en: "  " } }],
    ["with a hint in no language", { code: "NAJD2030", hint: {} }],
  ])("refuses an entry code %s", (_name, value) => {
    expect(parseQuestConfig("enter_code", value)).toBeUndefined();
  });

  it("accepts the shortest and the longest codes", () => {
    expect(parseQuestConfig("enter_code", { code: "ab12" })).toEqual({ code: "AB12" });
    expect(parseQuestConfig("enter_code", { code: "Z".repeat(32) })).toEqual({
      code: "Z".repeat(32),
    });
  });
});
