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
  verification: [],
  steps: [],
  itemId: "44444444-4444-4444-8444-444444444444",
  place: null,
  pollSentAt: null,
  flash: false,
  flashLaunchedAt: null,
};
const ZONE = "Asia/Riyadh";

describe("mergeQuest", () => {
  it("takes a game quest's config, played once, and refuses the games not available yet", () => {
    const base = { categoryId: "c", title: { en: "Play" }, points: 30 };
    expect(
      mergeQuest(
        undefined,
        "game",
        { ...base, repeatCap: 5, config: { game: "slide_puzzle", level: "hard" } },
        ZONE,
      ),
    ).toMatchObject({
      repeatCap: 1,
      verification: [],
      config: { game: "slide_puzzle", level: "hard", attempts: 1, cooldownMinutes: null },
    });
    for (const game of ["catch", "tap_rush"]) {
      expect(
        mergeQuest(undefined, "game", { ...base, config: { game, level: "easy" } }, ZONE),
      ).toMatchObject({ config: { game, level: "easy", attempts: 1, cooldownMinutes: null } });
    }
    expect(
      mergeQuest(
        undefined,
        "game",
        { ...base, config: { game: "memory_match", level: "easy", attempts: null } },
        ZONE,
      ),
    ).toEqual({ kind: "invalid", field: "config" });
  });

  it("checks the submission kinds available only on a submission quest", () => {
    const base = { categoryId: "c", title: { en: "Show us" }, points: 5 };
    const config = { accepts: ["photo"] };
    expect(mergeQuest(undefined, "submission", { ...base, config }, ZONE)).toEqual({
      kind: "submission_kind_unavailable",
      asked: "photo",
    });
    expect(mergeQuest(undefined, "challenge", { ...base, config }, ZONE)).toEqual({
      kind: "invalid",
      field: "config",
    });
  });

  it("refuses a meet quest whose daily cap is above its repeat cap, and keeps one at or below it", () => {
    const base = { categoryId: "c", title: { en: "Meet" }, points: 5 };
    expect(mergeQuest(undefined, "meet", { ...base, repeatCap: 4 }, ZONE)).toEqual({
      kind: "invalid",
      field: "dailyCap",
    });
    expect(
      mergeQuest(undefined, "meet", { ...base, repeatCap: 5, config: { dailyCap: 5 } }, ZONE),
    ).toMatchObject({ repeatCap: 5, config: { dailyCap: 5 }, verification: [] });
    expect(
      mergeQuest(undefined, "meet", { ...base, repeatCap: 1, config: { dailyCap: 1 } }, ZONE),
    ).toMatchObject({ repeatCap: 1, config: { dailyCap: 1 } });
    expect(
      mergeQuest(undefined, "meet", { ...base, repeatCap: 9, config: { dailyCap: 51 } }, ZONE),
    ).toEqual({ kind: "invalid", field: "config" });
    const stored: QuestRecord = { ...STORED, type: "meet", repeatCap: 10, config: { dailyCap: 5 } };
    expect(mergeQuest(stored, "meet", { repeatCap: 4 }, ZONE)).toEqual({
      kind: "invalid",
      field: "dailyCap",
    });
  });

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
      verification: ["quest_qr"],
      itemId: null,
      place: null,
      flash: false,
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
      verification: [],
      itemId: STORED.itemId,
      place: null,
      flash: false,
    });
  });

  it("takes a place on the spot types only, requires one for a location quest, and keeps or clears it", () => {
    const place = { lat: 24.7136, lng: 46.6753, radiusM: 50 };
    const base = { categoryId: "c", title: { en: "Spot" }, points: 5 };
    expect(mergeQuest(undefined, "location", { ...base, place }, ZONE)).toMatchObject({
      place,
      verification: ["quest_qr"],
    });
    expect(mergeQuest(undefined, "location", base, ZONE)).toEqual({
      kind: "invalid",
      field: "place",
    });
    for (const type of ["scan_qr", "challenge"] as const) {
      expect(mergeQuest(undefined, type, { ...base, place }, ZONE)).toMatchObject({ place });
    }
    expect(
      mergeQuest(undefined, "enter_code", { ...base, place, config: { code: "ABCD" } }, ZONE),
    ).toEqual({ kind: "invalid", field: "place" });
    const spot = {
      ...STORED,
      type: "location",
      config: {},
      verification: ["quest_qr"],
      place,
    } as const;
    expect(mergeQuest(spot, "location", {}, ZONE)).toMatchObject({ place });
    expect(mergeQuest(spot, "location", { place: null }, ZONE)).toEqual({
      kind: "invalid",
      field: "place",
    });
    const scan = { ...spot, type: "scan_qr" } as const;
    expect(mergeQuest(scan, "scan_qr", { place: null }, ZONE)).toMatchObject({ place: null });
    expect(auditView(spot)).toMatchObject({ place });
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
          itemId: null,
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
      verification: [],
      itemId: null,
      place: null,
      flash: false,
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
    ["verification", STORED, { verification: ["my_qr"] }],
  ] as const)("refuses, naming %s", (field, current, input) => {
    expect(mergeQuest(current, "enter_code", input, ZONE)).toEqual({ kind: "invalid", field });
  });

  it("takes a scan quest's methods and keeps them when left out", () => {
    const scan = { ...STORED, type: "scan_qr", config: {}, verification: ["my_qr"] } as const;
    expect(mergeQuest(scan, "scan_qr", {}, ZONE)).toMatchObject({ verification: ["my_qr"] });
    expect(
      mergeQuest(scan, "scan_qr", { verification: ["my_qr", "quest_qr"] }, ZONE),
    ).toMatchObject({ verification: ["quest_qr", "my_qr"] });
    expect(mergeQuest(scan, "scan_qr", { verification: [] }, ZONE)).toEqual({
      kind: "invalid",
      field: "verification",
    });
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
      closesAt: "2030-11-01T09:00:00.000Z",
    });
    expect(auditView({ ...STORED, opensAt: null, closesAt: null })).toMatchObject({
      opensAt: null,
      closesAt: null,
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

describe("a passport's audit (T-304b)", () => {
  it("keeps its steps' ids and names, and only for a passport", () => {
    const passport: QuestRecord = {
      ...STORED,
      type: "passport",
      config: { needed: 1 },
      steps: [{ id: "s1", name: { ar: null, en: "Booth" }, position: 0, qrVersion: 2 }],
    };
    expect(auditView(passport)).toMatchObject({
      steps: [{ id: "s1", nameAr: null, nameEn: "Booth" }],
    });
    expect(auditView(STORED)).not.toHaveProperty("steps");
  });
});

describe("a live poll's window (T-306)", () => {
  const options = [
    { id: "a", text: { en: "A" } },
    { id: "b", text: { en: "B" } },
  ];
  const live = { options, live: { choices: "one", results: "never", minutes: 5 } };
  const asked = {
    categoryId: "c",
    title: { en: "Poll" },
    points: 5,
    visible: true,
    opensAt: "2030-11-01T10:00",
    closesAt: "2030-11-01T11:00",
  };

  it("keeps a new or draft poll hidden with no window, whatever is asked", () => {
    expect(mergeQuest(undefined, "vote", { ...asked, config: live }, ZONE)).toMatchObject({
      visible: false,
      opensAt: null,
      closesAt: null,
    });
    const draft: QuestRecord = { ...STORED, type: "vote", config: live, visible: false };
    expect(mergeQuest(draft, "vote", asked, ZONE)).toMatchObject({
      visible: false,
      opensAt: null,
      closesAt: null,
    });
  });

  it("keeps a sent poll's window as sent, and a plain vote's as asked", () => {
    const sent: QuestRecord = {
      ...STORED,
      type: "vote",
      config: live,
      visible: true,
      pollSentAt: STORED.opensAt,
    };
    expect(mergeQuest(sent, "vote", { ...asked, visible: false }, ZONE)).toMatchObject({
      visible: true,
      opensAt: STORED.opensAt,
      closesAt: STORED.closesAt,
    });
    expect(mergeQuest(undefined, "vote", { ...asked, config: { options } }, ZONE)).toMatchObject({
      visible: true,
      opensAt: new Date("2030-11-01T07:00:00Z"),
    });
  });

  it("refuses several choices without `live` and a poll of 0 or 1,441 minutes", () => {
    for (const config of [
      { options, choices: "several" },
      { options, live: { choices: "one", results: "never", minutes: 0 } },
      { options, live: { choices: "one", results: "never", minutes: 1441 } },
      { options, live: { choices: "all", results: "never", minutes: 5 } },
    ]) {
      expect(mergeQuest(undefined, "vote", { ...asked, config }, ZONE)).toEqual({
        kind: "invalid",
        field: "config",
      });
    }
  });
});

describe("a flash quest (T-307, ADR-231)", () => {
  const NOW = new Date("2030-11-01T08:00:00Z");
  const base = { categoryId: "c", title: { en: "Drop" }, points: 20, flash: true };
  const flash: QuestRecord = {
    ...STORED,
    type: "scan_qr",
    config: {},
    verification: ["quest_qr"],
    flash: true,
    visible: false,
    opensAt: null,
    closesAt: null,
  };

  it("is a hidden draft when saved without both times, and shown with a window of 1 to 1,440 minutes", () => {
    expect(mergeQuest(undefined, "scan_qr", base, ZONE, NOW)).toMatchObject({
      flash: true,
      visible: false,
      opensAt: null,
      closesAt: null,
    });
    expect(
      mergeQuest(
        undefined,
        "scan_qr",
        { ...base, opensAt: "2030-11-01T12:00", closesAt: "2030-11-01T12:01" },
        ZONE,
        NOW,
      ),
    ).toMatchObject({ flash: true, visible: true });
    expect(
      mergeQuest(
        undefined,
        "scan_qr",
        { ...base, opensAt: "2030-11-01T12:00", closesAt: "2030-11-02T12:00" },
        ZONE,
        NOW,
      ),
    ).toMatchObject({ visible: true });
    for (const window of [
      { visible: true },
      { visible: true, opensAt: "2030-11-01T12:00" },
      { opensAt: "2030-11-01T12:00", closesAt: "2030-11-02T12:01" },
    ]) {
      expect(mergeQuest(undefined, "scan_qr", { ...base, ...window }, ZONE, NOW)).toEqual({
        kind: "invalid",
        field: "flashWindow",
      });
    }
    expect(
      mergeQuest(
        undefined,
        "scan_qr",
        { ...base, visible: false, opensAt: "2030-11-01T12:00" },
        ZONE,
      ),
    ).toMatchObject({ visible: false });
  });

  it("is never a live poll", () => {
    const poll = {
      options: [
        { id: "a", text: { en: "A" } },
        { id: "b", text: { en: "B" } },
      ],
      live: { choices: "one", results: "after_vote", minutes: 5 },
    };
    expect(mergeQuest(undefined, "vote", { ...base, config: poll }, ZONE, NOW)).toEqual({
      kind: "invalid",
      field: "flash",
    });
  });

  it("keeps a launched or started window whatever is asked, and stays flash once launched", () => {
    const opensAt = new Date("2030-11-01T07:55:00Z");
    const closesAt = new Date("2030-11-01T08:05:00Z");
    const launched = { ...flash, visible: true, opensAt, closesAt, flashLaunchedAt: opensAt };
    const asked = { visible: false, opensAt: null, closesAt: "2030-11-01T15:00" };
    expect(mergeQuest(launched, "scan_qr", asked, ZONE, NOW)).toMatchObject({
      visible: true,
      opensAt,
      closesAt,
    });
    expect(mergeQuest(launched, "scan_qr", { flash: false }, ZONE, NOW)).toEqual({
      kind: "invalid",
      field: "flashLaunched",
    });
    const started = { ...flash, visible: true, opensAt, closesAt };
    expect(mergeQuest(started, "scan_qr", asked, ZONE, NOW)).toMatchObject({ opensAt, closesAt });
    const later = { ...started, opensAt: new Date("2030-11-01T08:01:00Z") };
    expect(mergeQuest(later, "scan_qr", { visible: false }, ZONE, NOW)).toMatchObject({
      visible: false,
    });
    expect(mergeQuest(later, "scan_qr", { flash: false }, ZONE, NOW)).toMatchObject({
      flash: false,
    });
    expect(mergeQuest(started, "scan_qr", { flash: false }, ZONE, NOW)).toEqual({
      kind: "invalid",
      field: "flashLaunched",
    });
    expect(auditView(launched)).toMatchObject({ flash: true });
  });
});
