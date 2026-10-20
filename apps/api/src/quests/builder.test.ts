import { describe, expect, it } from "vitest";
import { auditView, mergeQuest, questChanges } from "#src/quests/builder";
import type { QuestRecord } from "#src/quests/store";

const STORED: QuestRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  eventId: "22222222-2222-4222-8222-222222222222",
  categoryId: "33333333-3333-4333-8333-333333333333",
  type: "enter_code",
  title: { ar: "الرمز", en: "The code" },
  description: { ar: null, en: "On the screen" },
  points: 15,
  repeatCap: 2,
  opensAt: new Date("2030-11-01T07:00:00Z"),
  closesAt: new Date("2030-11-01T09:00:00Z"),
  visible: false,
  position: 4,
  config: { code: "NAJD2030" },
  qrVersion: 1,
};
const ZONE = "Asia/Riyadh";

describe("mergeQuest", () => {
  it("fills a new quest's defaults", () => {
    expect(
      mergeQuest(undefined, "scan_qr", { categoryId: "c", title: { en: "Find" }, points: 5 }, ZONE),
    ).toEqual({
      categoryId: "c",
      title: { ar: null, en: "Find" },
      description: { ar: null, en: null },
      points: 5,
      repeatCap: 1,
      opensAt: null,
      closesAt: null,
      visible: true,
      config: {},
    });
  });

  it("keeps every stored field the input leaves out", () => {
    expect(mergeQuest(STORED, "enter_code", {}, ZONE)).toEqual({
      categoryId: STORED.categoryId,
      title: STORED.title,
      description: STORED.description,
      points: 15,
      repeatCap: 2,
      opensAt: STORED.opensAt,
      closesAt: STORED.closesAt,
      visible: false,
      config: { code: "NAJD2030" },
    });
  });

  it("takes what is sent: blanks as none, null clears a time, the config checked against the type", () => {
    expect(
      mergeQuest(
        STORED,
        "enter_code",
        {
          categoryId: "d",
          title: { ar: "", en: " New " },
          description: { ar: "على الشاشة" },
          points: 0,
          repeatCap: 1,
          opensAt: null,
          closesAt: "2030-11-01T13:00",
          visible: true,
          config: { code: "tabuk31" },
        },
        ZONE,
      ),
    ).toEqual({
      categoryId: "d",
      title: { ar: null, en: "New" },
      description: { ar: "على الشاشة", en: null },
      points: 0,
      repeatCap: 1,
      opensAt: null,
      closesAt: new Date("2030-11-01T10:00:00Z"),
      visible: true,
      config: { code: "TABUK31" },
    });
  });

  it.each([
    ["title", undefined, { title: {}, points: 1 }],
    ["title", undefined, { title: { ar: "", en: "  " }, points: 1 }],
    ["title", STORED, { title: { ar: " ", en: "" } }],
    ["points", undefined, { title: { en: "x" } }],
    ["opensAt", STORED, { opensAt: "soon" }],
    ["closesAt", STORED, { closesAt: "later" }],
    ["closesAt", STORED, { closesAt: "2030-11-01T10:00" }],
    ["closesAt", STORED, { opensAt: "2030-11-01T13:00" }],
    ["config", STORED, { config: { code: "x" } }],
    ["config", undefined, { title: { en: "x" }, points: 1 }],
  ] as const)("refuses, naming %s", (field, current, input) => {
    expect(mergeQuest(current, "enter_code", input, ZONE)).toEqual({ kind: "invalid", field });
  });

  it("takes a title in one language alone", () => {
    expect(mergeQuest(STORED, "enter_code", { title: { ar: "الرمز" } }, ZONE)).toMatchObject({
      title: { ar: "الرمز", en: null },
    });
  });

  it("accepts a window of one minute and a window open at one end", () => {
    expect(mergeQuest(STORED, "enter_code", { closesAt: "2030-11-01T10:01" }, ZONE)).toMatchObject({
      closesAt: new Date("2030-11-01T07:01:00Z"),
    });
    expect(mergeQuest(STORED, "enter_code", { opensAt: null, closesAt: null }, ZONE)).toMatchObject(
      {
        opensAt: null,
        closesAt: null,
      },
    );
  });
});

describe("the audit view", () => {
  it("keeps the code out and says one is set", () => {
    const view = auditView(STORED);
    expect(view).toMatchObject({
      config: {},
      entryCode: "set",
      opensAt: "2030-11-01T07:00:00.000Z",
    });
    expect(JSON.stringify(view)).not.toContain("NAJD2030");
    expect(auditView({ ...STORED, type: "scan_qr", config: {} })).not.toHaveProperty("entryCode");
  });

  it("notes a changed code without writing it, and nothing for an unchanged one", () => {
    expect(questChanges(STORED, { ...STORED, points: 20 })).toEqual({
      before: { points: 15 },
      after: { points: 20 },
    });
    expect(questChanges(STORED, { ...STORED, config: { code: "TABUK31" } })).toEqual({
      before: { codeChanged: false },
      after: { codeChanged: true },
    });
  });
});
