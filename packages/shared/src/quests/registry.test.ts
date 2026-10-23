import { describe, expect, it } from "vitest";
import { MESSAGES } from "#src/i18n/messages";
import {
  QR_QUEST_TYPES,
  parseVerification,
  QUEST_TYPES,
  QUEST_TYPE_NAMES,
  isLivePoll,
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
    expect(QR_QUEST_TYPES).toEqual(["scan_qr", "location"]);
    expect(QUEST_TYPES.location.verifications).toEqual(["quest_qr"]);
    for (const type of QUEST_TYPE_NAMES) {
      expect(typeof QUEST_TYPES[type].usesQuestQr, type).toBe("boolean");
    }
  });

  it("knows its own types and nothing else", () => {
    expect(QUEST_TYPE_NAMES).toEqual([
      "scan_qr",
      "enter_code",
      "submission",
      "vote",
      "quiz",
      "challenge",
      "survey",
      "share",
      "passport",
      "location",
      "meet",
      "game",
    ]);
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

  it("take a live block of choices, results and 1 to 1,440 minutes, and nothing else in it (T-306)", () => {
    const options = [option("a"), option("b")];
    const live = { choices: "several", results: "at_close", minutes: 1440 };
    expect(parseQuestConfig("vote", { options, live })).toEqual({ options, live });
    for (const changed of [
      { ...live, minutes: 0 },
      { ...live, minutes: 1441 },
      { ...live, minutes: 2.5 },
      { ...live, choices: "all" },
      { ...live, results: "later" },
      { ...live, extra: true },
      { choices: "one", results: "never" },
    ]) {
      expect(
        parseQuestConfig("vote", { options, live: changed }),
        JSON.stringify(changed),
      ).toBeUndefined();
    }
    expect(parseQuestConfig("vote", { options, choices: "several" })).toBeUndefined();
    expect(parseQuestConfig("vote", { options, live: { ...live, minutes: 1 } })).toBeDefined();
  });

  it("are live polls only with the live block", () => {
    expect(isLivePoll("vote", { live: { choices: "one" } })).toBe(true);
    expect(isLivePoll("vote", {})).toBe(false);
    expect(isLivePoll("quiz", { live: {} })).toBe(false);
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

describe("challenge quests", () => {
  it("hold no config and are verified only by staff scanning My QR", () => {
    expect(parseQuestConfig("challenge", {})).toEqual({});
    expect(parseQuestConfig("challenge", { code: "X" })).toBeUndefined();
    expect(parseVerification("challenge", undefined)).toEqual(["my_qr"]);
    expect(parseVerification("challenge", ["quest_qr"])).toBeUndefined();
    expect(parseVerification("challenge", [])).toBeUndefined();
    expect(QUEST_TYPES.challenge.oneTry).toBe(false);
  });
});

const ask = (id: string, kind: string, extra: object = {}) => ({
  id,
  text: { en: `Question ${id}` },
  kind,
  ...extra,
});

describe("survey quests", () => {
  it("take choice, rating and text questions, each required by default", () => {
    const config = {
      questions: [
        ask("c", "choice", { choices: [option("a"), option("b")] }),
        ask("r", "rating"),
        ask("t", "text", { required: false }),
      ],
    };
    expect(parseQuestConfig("survey", config)).toEqual({
      questions: [
        { ...config.questions[0], required: true },
        { ...config.questions[1], required: true },
        config.questions[2],
      ],
    });
    expect(QUEST_TYPES.survey.oneTry).toBe(true);
  });

  it.each([
    ["no questions", { questions: [] }],
    ["21 questions", { questions: Array.from({ length: 21 }, (_, i) => ask(`q${i}`, "rating")) }],
    ["a repeated question id", { questions: [ask("q", "rating"), ask("q", "text")] }],
    ["an unknown kind", { questions: [ask("q", "stars")] }],
    [
      "a choice question with one choice",
      { questions: [ask("q", "choice", { choices: [option("a")] })] },
    ],
    [
      "a choice question with 11 choices",
      {
        questions: [
          ask("q", "choice", { choices: Array.from({ length: 11 }, (_, i) => option(`o${i}`)) }),
        ],
      },
    ],
    [
      "repeated choices",
      { questions: [ask("q", "choice", { choices: [option("a"), option("a")] })] },
    ],
    [
      "choices on a rating",
      { questions: [ask("q", "rating", { choices: [option("a"), option("b")] })] },
    ],
    [
      "question text over 300",
      { questions: [{ ...ask("q", "text"), text: { en: "x".repeat(301) } }] },
    ],
  ])("refuse %s", (_name, config) => {
    expect(parseQuestConfig("survey", config)).toBeUndefined();
  });
});

describe("share quests", () => {
  it("take the organizer's message and an optional https link", () => {
    expect(parseQuestConfig("share", { message: { ar: "شارك" } })).toEqual({
      message: { ar: "شارك" },
    });
    expect(
      parseQuestConfig("share", { message: { en: "Join" }, link: "https://example.com/x" }),
    ).toMatchObject({ link: "https://example.com/x" });
    expect(QUEST_TYPES.share.oneTry).toBe(true);
  });

  it.each([
    ["no message", {}],
    ["an empty message", { message: {} }],
    ["a message over 500", { message: { en: "x".repeat(501) } }],
    ["an http link", { message: { en: "x" }, link: "http://example.com" }],
    ["a script link", { message: { en: "x" }, link: "javascript:alert(1)" }],
    ["a link with a space inside", { message: { en: "x" }, link: "https://example.com/a b" }],
    ["a link over 300", { message: { en: "x" }, link: `https://example.com/${"a".repeat(290)}` }],
  ])("refuse %s", (_name, config) => {
    expect(parseQuestConfig("share", config)).toBeUndefined();
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

describe("passport quests", () => {
  it("are finished once, need a whole count from 1 to 30, and carry no quest code of their own", () => {
    expect(QUEST_TYPES.passport.oneTry).toBe(true);
    expect(QUEST_TYPES.passport.usesQuestQr).toBe(false);
    expect(parseQuestConfig("passport", { needed: 5 })).toEqual({ needed: 5 });
    for (const needed of [0, 31, 2.5, "5", undefined]) {
      expect(parseQuestConfig("passport", { needed }), String(needed)).toBeUndefined();
    }
    expect(parseQuestConfig("passport", { needed: 1, steps: [] })).toBeUndefined();
    expect(parseVerification("passport", undefined, undefined)).toEqual([]);
  });
});

describe("meet quests", () => {
  it("default to a daily cap of 5 and take 1 to 50 whole meetings", () => {
    expect(parseQuestConfig("meet", {})).toEqual({ dailyCap: 5 });
    expect(parseQuestConfig("meet", { dailyCap: 1 })).toEqual({ dailyCap: 1 });
    expect(parseQuestConfig("meet", { dailyCap: 50 })).toEqual({ dailyCap: 50 });
    for (const dailyCap of [0, 51, 2.5, "5", null]) {
      expect(parseQuestConfig("meet", { dailyCap }), String(dailyCap)).toBeUndefined();
    }
    expect(parseQuestConfig("meet", { dailyCap: 5, extra: 1 })).toBeUndefined();
  });

  it("carry no quest QR and no verification, and never refresh", () => {
    expect(QUEST_TYPES.meet.usesQuestQr).toBe(false);
    expect(QUEST_TYPES.meet.verifications).toEqual([]);
    expect(QUEST_TYPES.meet.oneTry).toBe(false);
    expect(parseVerification("meet", undefined)).toEqual([]);
  });
});

describe("game quests", () => {
  it("take a game and a level, one attempt by default", () => {
    expect(QUEST_TYPES.game.oneTry).toBe(true);
    expect(QUEST_TYPES.game.verifications).toEqual([]);
    expect(parseQuestConfig("game", { game: "memory_match", level: "medium" })).toEqual({
      game: "memory_match",
      level: "medium",
      attempts: 1,
      cooldownMinutes: null,
    });
    expect(
      parseQuestConfig("game", { game: "slide_puzzle", level: "hard", attempts: 10 }),
    ).toMatchObject({
      attempts: 10,
    });
  });

  it("take unlimited attempts only with a cooldown, and a cooldown only with unlimited attempts", () => {
    expect(
      parseQuestConfig("game", {
        game: "memory_match",
        level: "easy",
        attempts: null,
        cooldownMinutes: 1,
      }),
    ).toMatchObject({ attempts: null, cooldownMinutes: 1 });
    expect(
      parseQuestConfig("game", {
        game: "memory_match",
        level: "easy",
        attempts: null,
        cooldownMinutes: 1440,
      }),
    ).toMatchObject({ cooldownMinutes: 1440 });
    for (const bad of [
      { attempts: null },
      { attempts: null, cooldownMinutes: 0 },
      { attempts: null, cooldownMinutes: 1441 },
      { attempts: 2, cooldownMinutes: 5 },
      { attempts: 0 },
      { attempts: 11 },
      { attempts: 1.5 },
    ]) {
      expect(
        parseQuestConfig("game", { game: "memory_match", level: "easy", ...bad }),
        JSON.stringify(bad),
      ).toBeUndefined();
    }
  });

  it("take all four games and refuse an unknown game or level", () => {
    for (const game of ["catch", "tap_rush"]) {
      expect(parseQuestConfig("game", { game, level: "easy" })).toEqual({
        game,
        level: "easy",
        attempts: 1,
        cooldownMinutes: null,
      });
    }
    expect(parseQuestConfig("game", { game: "snake", level: "easy" })).toBeUndefined();
    expect(parseQuestConfig("game", { game: "memory_match", level: "expert" })).toBeUndefined();
    expect(
      parseQuestConfig("game", { game: "memory_match", level: "easy", extra: 1 }),
    ).toBeUndefined();
  });
});
