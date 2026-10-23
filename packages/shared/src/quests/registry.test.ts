import { describe, expect, it } from "vitest";
import { MESSAGES } from "#src/i18n/messages";
import {
  QR_QUEST_TYPES,
  parseVerification,
  QUEST_TYPES,
  QUEST_TYPE_NAMES,
  isQuestType,
  parseQuestConfig,
  unavailableSubmissionKind,
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
    expect(QUEST_TYPE_NAMES).toEqual(["scan_qr", "enter_code", "submission", "vote", "quiz"]);
    expect(isQuestType("scan_qr")).toBe(true);
    expect(isQuestType("submission")).toBe(true);
    expect(isQuestType("photo")).toBe(false);
    expect(isQuestType("toString")).toBe(false);
  });
});

describe("submission quests", () => {
  it("default to text, reviewed, no resubmission", () => {
    expect(parseQuestConfig("submission", {})).toEqual({
      accepts: ["text"],
      autoApprove: false,
      resubmit: false,
    });
    expect(parseQuestConfig("submission", { autoApprove: true, resubmit: true })).toMatchObject({
      autoApprove: true,
      resubmit: true,
    });
  });

  it("refuse photo and video, and name which one was asked for", () => {
    expect(parseQuestConfig("submission", { accepts: ["photo"] })).toBeUndefined();
    expect(parseQuestConfig("submission", { accepts: ["text", "video"] })).toBeUndefined();
    expect(parseQuestConfig("submission", { accepts: [] })).toBeUndefined();
    expect(unavailableSubmissionKind({ accepts: ["text", "video"] })).toBe("video");
    expect(unavailableSubmissionKind({ accepts: ["photo", "video"] })).toBe("video");
    expect(unavailableSubmissionKind({ accepts: ["photo"] })).toBe("photo");
    expect(unavailableSubmissionKind({ accepts: ["text"] })).toBeUndefined();
    expect(unavailableSubmissionKind({ accepts: "photo" })).toBeUndefined();
    expect(unavailableSubmissionKind(null)).toBeUndefined();
    expect(unavailableSubmissionKind("x")).toBeUndefined();
  });
});

const option = (id: string) => ({ id, text: { en: `Option ${id}` } });
const question = (id: string, right = "a") => ({
  id,
  text: { ar: "سؤال" },
  choices: [option("a"), option("b")],
  right,
});

describe("vote quests", () => {
  it("take 2 to 10 options of the organizer's text, with distinct ids", () => {
    expect(parseQuestConfig("vote", { options: [option("a"), option("b")] })).toEqual({
      options: [option("a"), option("b")],
    });
    expect(parseQuestConfig("vote", { options: [option("a")] })).toBeUndefined();
    expect(
      parseQuestConfig("vote", { options: Array.from({ length: 11 }, (_, i) => option(`o${i}`)) }),
    ).toBeUndefined();
    expect(parseQuestConfig("vote", { options: [option("a"), option("a")] })).toBeUndefined();
    expect(
      parseQuestConfig("vote", { options: [option("a"), { id: "b", text: {} }] }),
    ).toBeUndefined();
    expect(
      parseQuestConfig("vote", { options: [option("a"), { id: "b c", text: { en: "x" } }] }),
    ).toBeUndefined();
    expect(QUEST_TYPES.vote.oneTry).toBe(true);
  });
});

describe("quiz quests", () => {
  it("take 1 to 20 questions with one right choice each, and no timer by default", () => {
    expect(parseQuestConfig("quiz", { questions: [question("q1")] })).toEqual({
      questions: [question("q1")],
      timerSeconds: null,
    });
    expect(
      parseQuestConfig("quiz", { questions: [question("q1")], timerSeconds: 30 }),
    ).toMatchObject({ timerSeconds: 30 });
    expect(QUEST_TYPES.quiz.oneTry).toBe(true);
    expect(QUEST_TYPES.scan_qr.oneTry).toBe(false);
  });

  it.each([
    ["no questions", { questions: [] }],
    ["21 questions", { questions: Array.from({ length: 21 }, (_, i) => question(`q${i}`)) }],
    ["a repeated question id", { questions: [question("q1"), question("q1")] }],
    ["a right answer that is not a choice", { questions: [question("q1", "z")] }],
    ["one choice", { questions: [{ ...question("q1"), choices: [option("a")] }] }],
    [
      "repeated choices",
      { questions: [{ ...question("q1"), choices: [option("a"), option("a")] }] },
    ],
    ["a timer under 5 s", { questions: [question("q1")], timerSeconds: 4 }],
    ["a timer over 300 s", { questions: [question("q1")], timerSeconds: 301 }],
    [
      "question text over 300",
      { questions: [{ ...question("q1"), text: { en: "x".repeat(301) } }] },
    ],
  ])("refuse %s", (_name, config) => {
    expect(parseQuestConfig("quiz", config)).toBeUndefined();
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

describe("quest verification methods (FR-301)", () => {
  it("gives a new quest its type's first method and keeps an existing quest's own", () => {
    expect(parseVerification("scan_qr", undefined)).toEqual(["quest_qr"]);
    expect(parseVerification("scan_qr", undefined, ["my_qr"])).toEqual(["my_qr"]);
    expect(parseVerification("enter_code", undefined)).toEqual([]);
  });

  it("stores the chosen methods once each, in the type's order", () => {
    expect(parseVerification("scan_qr", ["my_qr", "quest_qr", "my_qr"])).toEqual([
      "quest_qr",
      "my_qr",
    ]);
    expect(parseVerification("scan_qr", ["my_qr"])).toEqual(["my_qr"]);
    expect(parseVerification("enter_code", [])).toEqual([]);
  });

  it.each([
    ["no method for a scan quest", "scan_qr", []],
    ["an unknown method", "scan_qr", ["nfc"]],
    ["a method the type does not offer", "enter_code", ["my_qr"]],
    ["not a list", "scan_qr", "my_qr"],
  ] as const)("refuses %s", (_name, type, value) => {
    expect(parseVerification(type, value)).toBeUndefined();
  });
});
