import { MESSAGES, QUEST_TYPE_NAMES, reviewDemoView, type ReviewDemoRaw } from "@questify/shared";
import { describe, expect, it } from "vitest";
import {
  CHECKLIST_GROUPS,
  itemKeyOf,
  prepareBody,
  readPrepared,
  readReviewDemo,
} from "#src/lib/console-review-demo.ts";

const ID = "6f1f2d0e-5a4b-4f4e-9c1a-0a1b2c3d4e5f";
const raw: ReviewDemoRaw = {
  exists: true,
  organizerId: ID,
  eventId: ID,
  joinCode: "DEMO1A2B3C",
  eventName: { ar: "عرض مراجعة التطبيق", en: "App Review Demo" },
  endsAt: "2027-01-01T00:00:00.000Z",
  contact: "+966500000710",
  reviewer: null,
  windowUntil: null,
  codeSet: false,
  preparedFor: null,
  preparedAt: null,
  fictionalPlayers: 12,
  readiness: {
    questTypes: ["scan_qr", "quiz"],
    verifications: ["quest_qr"],
    rewards: 2,
    livePoll: true,
    communityGoal: false,
    flashQuest: false,
    boost: false,
    nfcTag: false,
    station: false,
    sessions: false,
    overrides: { shop: true },
  },
};

describe("readReviewDemo", () => {
  it("reads the console's answer and refuses any other shape", () => {
    expect(readReviewDemo({ demo: { exists: false } })).toEqual({ exists: false });
    expect(readReviewDemo({ demo: reviewDemoView(raw) })).toMatchObject({ exists: true });
    expect(readReviewDemo({ demo: { exists: true } })).toBeUndefined();
    expect(readReviewDemo(undefined)).toBeUndefined();
  });
});

describe("readPrepared", () => {
  it("takes only a six-digit code", () => {
    const demo = reviewDemoView(raw);
    expect(readPrepared({ code: "042424", windowUntil: "x", demo })).toMatchObject({
      code: "042424",
    });
    expect(readPrepared({ code: "4242", windowUntil: "x", demo })).toBeUndefined();
  });
});

describe("prepareBody", () => {
  it("holds the days to 1 to 30 and the version to 1 to 20 characters", () => {
    expect(prepareBody("14", " 1.4.0 ")).toEqual({ days: 14, version: "1.4.0" });
    expect(prepareBody("1", "1")).toEqual({ days: 1, version: "1" });
    expect(prepareBody("30", "x".repeat(20))).toEqual({ days: 30, version: "x".repeat(20) });
    for (const [days, version] of [
      ["0", "1.0"],
      ["31", "1.0"],
      ["2.5", "1.0"],
      ["14", "  "],
      ["14", "x".repeat(21)],
    ] as const) {
      expect(prepareBody(days, version)).toBeUndefined();
    }
  });
});

describe("the readiness checklist", () => {
  const view = reviewDemoView(raw);
  const checklist = view.exists ? view.checklist : [];

  it("lists every quest type, then the verifications, then the review-day items", () => {
    expect(checklist.filter((item) => item.kind === "questType").map((item) => item.key)).toEqual(
      QUEST_TYPE_NAMES,
    );
    expect(checklist.find((item) => item.key === "quiz")).toMatchObject({ present: true });
    expect(checklist.find((item) => item.key === "meet")).toMatchObject({ present: false });
    expect(checklist.find((item) => item.key === "rewards")).toMatchObject({ present: true });
    expect(checklist.find((item) => item.key === "station")).toMatchObject({ present: false });
    expect(CHECKLIST_GROUPS.map((group) => group.kind)).toEqual([
      "questType",
      "verification",
      "reviewDay",
    ]);
  });

  it("names every line in both languages", () => {
    for (const item of checklist) {
      const key = itemKeyOf(item);
      expect(key, item.key).toBeDefined();
      expect(MESSAGES[key ?? "console.reviewDemo.title"].ar).not.toBe("");
    }
    expect(itemKeyOf({ kind: "reviewDay", key: "unknown", present: false })).toBeUndefined();
    expect(itemKeyOf({ kind: "questType", key: "unknown", present: false })).toBeUndefined();
  });
});
