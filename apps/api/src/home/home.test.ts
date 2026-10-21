import { describe, expect, it } from "vitest";
import { finished, isOpen, pickUpNext, type MemberQuest } from "#src/home/home";

const NOW = new Date("2026-11-01T12:00:00Z");
const before = new Date("2026-11-01T11:00:00Z");
const after = new Date("2026-11-01T13:00:00Z");

const quest = (id: string, fields: Partial<MemberQuest> = {}): MemberQuest => ({
  id,
  title: { ar: `مهمة ${id}`, en: `Quest ${id}` },
  description: { ar: null, en: null },
  type: "scan_qr",
  points: 10,
  repeatCap: 1,
  opensAt: null,
  closesAt: null,
  done: 0,
  ...fields,
});

describe("finished", () => {
  it("is done to the repeat cap, not before", () => {
    expect(finished(quest("a", { repeatCap: 3, done: 2 }))).toBe(false);
    expect(finished(quest("a", { repeatCap: 3, done: 3 }))).toBe(true);
  });
});

describe("isOpen", () => {
  it("needs a live event", () => {
    for (const status of ["draft", "scheduled", "ended", "archived"] as const) {
      expect(isOpen(quest("a"), status, NOW)).toBe(false);
    }
    expect(isOpen(quest("a"), "live", NOW)).toBe(true);
  });

  it("holds from its opening time up to, not at, its closing time", () => {
    expect(isOpen(quest("a", { opensAt: NOW }), "live", NOW)).toBe(true);
    expect(isOpen(quest("a", { opensAt: after }), "live", NOW)).toBe(false);
    expect(isOpen(quest("a", { closesAt: NOW }), "live", NOW)).toBe(false);
    expect(isOpen(quest("a", { closesAt: after, opensAt: before }), "live", NOW)).toBe(true);
    expect(isOpen(quest("a", { closesAt: before }), "live", NOW)).toBe(false);
  });

  it("is closed for a player who finished it", () => {
    expect(isOpen(quest("a", { done: 1 }), "live", NOW)).toBe(false);
  });
});

describe("pickUpNext", () => {
  it("names the pinned quest while it is open for this player", () => {
    const quests = [quest("a", { points: 50 }), quest("b", { points: 5, type: "enter_code" })];
    expect(pickUpNext(quests, "b", "live", NOW)).toEqual({
      questId: "b",
      title: { ar: "مهمة b", en: "Quest b" },
      points: 5,
      type: "enter_code",
    });
  });

  it("falls back to the most points when the pin is finished, closed, hidden or gone", () => {
    const open = [quest("a", { points: 20 }), quest("b", { points: 30 })];
    expect(pickUpNext([...open, quest("p", { done: 1 })], "p", "live", NOW)?.questId).toBe("b");
    expect(pickUpNext([...open, quest("p", { closesAt: before })], "p", "live", NOW)?.questId).toBe(
      "b",
    );
    expect(pickUpNext(open, "not-in-the-list", "live", NOW)?.questId).toBe("b");
    expect(pickUpNext(open, null, "live", NOW)?.questId).toBe("b");
  });

  it("keeps the event's order on a tie", () => {
    const quests = [quest("first", { points: 30 }), quest("second", { points: 30 })];
    expect(pickUpNext(quests, null, "live", NOW)?.questId).toBe("first");
  });

  it("skips finished and closed quests for the best", () => {
    const quests = [
      quest("done", { points: 90, done: 1 }),
      quest("later", { points: 80, opensAt: after }),
      quest("open", { points: 1 }),
    ];
    expect(pickUpNext(quests, null, "live", NOW)?.questId).toBe("open");
  });

  it("is null with nothing open, or outside a live event", () => {
    expect(pickUpNext([quest("a", { done: 1 })], null, "live", NOW)).toBeNull();
    expect(pickUpNext([], null, "live", NOW)).toBeNull();
    expect(pickUpNext([quest("a")], "a", "scheduled", NOW)).toBeNull();
    expect(pickUpNext([quest("a")], "a", "ended", NOW)).toBeNull();
  });
});
