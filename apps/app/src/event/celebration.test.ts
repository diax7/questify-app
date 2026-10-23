import { describe, expect, it } from "vitest";
import { activityAnswer, readActivity } from "#src/event/activity-api.ts";
import { celebrationBeats, detailsAfter, scanStep, type ScanStep } from "#src/event/celebration.ts";
import { keyFor, type Category, type Quest, type QuestsView } from "#src/event/quests-api.ts";

const quest = (id: string, fields: Partial<Quest> = {}): Quest => ({
  id,
  title: { ar: null, en: id },
  description: { ar: null, en: null },
  type: "scan_qr",
  points: 10,
  repeatCap: 1,
  opensAt: null,
  closesAt: null,
  done: 0,
  earned: 0,
  state: "open",
  lock: null,
  steps: null,
  item: null,
  place: null,
  meet: null,
  verification: ["quest_qr"],
  ...fields,
});

const view = (...categories: Category[]): QuestsView => ({
  event: { statusNow: "live", timezone: "Asia/Riyadh" },
  categories,
});

const category = (id: string, quests: Quest[]): Category => ({
  id,
  name: { ar: null, en: id },
  orderMode: "any",
  opensAt: null,
  unlockAfter: null,
  bonus: { points: 0, earned: 0, settled: false, item: null },
  refresh: "none",
  resetsAt: null,
  quests,
});

const fresh = () => "new-key";

const levelUp = { level: 2, title: { ar: "مستكشف", en: "Explorer" } };

const checking: ScanStep = { kind: "checking", questId: "q1", token: "t1" };

describe("scanStep", () => {
  it("goes from a read to checking, then to the celebration on the server's word", () => {
    const read = scanStep({ kind: "scanning" }, { type: "read", questId: "q1", token: "t1" });
    expect(read).toEqual(checking);
    expect(
      scanStep(read, {
        type: "answered",
        answer: {
          kind: "completed",
          points: 25,
          score: 40,
          replayed: false,
          levelUp,
          bonus: { points: 50, category: { ar: null, en: "Stage" }, item: null },
          item: { name: { ar: null, en: "T-shirt" }, outcome: "pending", until: null },
        },
      }),
    ).toEqual({
      kind: "celebrating",
      questId: "q1",
      points: 25,
      replayed: false,
      levelUp,
      bonus: { points: 50, category: { ar: null, en: "Stage" }, item: null },
      item: { name: { ar: null, en: "T-shirt" }, outcome: "pending", until: null },
      met: null,
      details: undefined,
    });
  });

  it("celebrates a meeting with its quest and whom the player met (T-303c)", () => {
    const read = scanStep({ kind: "scanning" }, { type: "read", questId: "meet", token: "m" });
    expect(
      scanStep(read, {
        type: "answered",
        answer: {
          kind: "completed",
          points: 50,
          score: 50,
          replayed: false,
          levelUp: null,
          bonus: null,
          item: null,
          questId: "q9",
          met: { username: "noura", avatar: "owl" },
        },
      }),
    ).toMatchObject({ kind: "celebrating", questId: "q9", points: 50, met: "noura" });
  });

  it("shows a passport's progress after a step's stamp, and celebrates its quest when it pays", () => {
    const read = scanStep({ kind: "scanning" }, { type: "read", questId: "step1", token: "t1" });
    expect(
      scanStep(read, {
        type: "answered",
        answer: { kind: "stamped", questId: "p1", done: 4, needed: 5, fresh: true },
      }),
    ).toEqual({ kind: "stamped", done: 4, needed: 5, fresh: true });
    expect(
      scanStep(read, {
        type: "answered",
        answer: {
          kind: "completed",
          questId: "p1",
          points: 30,
          score: 30,
          replayed: false,
          levelUp: null,
          bonus: null,
          item: null,
        },
      }),
    ).toMatchObject({ kind: "celebrating", questId: "p1", points: 30 });
    const stamped = { kind: "stamped", done: 1, needed: 2, fresh: false } as const;
    expect(scanStep(stamped, { type: "again" })).toEqual({ kind: "scanning" });
  });

  it("shows a hidden category found by its secret code (T-304c)", () => {
    const read = scanStep({ kind: "scanning" }, { type: "read", questId: "cat1", token: "t1" });
    const name = { ar: "السر", en: null };
    const found = scanStep(read, {
      type: "answered",
      answer: { kind: "revealed", name, fresh: false },
    });
    expect(found).toEqual({ kind: "revealed", name, fresh: false });
    expect(scanStep(found, { type: "again" })).toEqual({ kind: "scanning" });
  });

  it("ends a refused scan in its reason, with no celebration", () => {
    expect(scanStep(checking, { type: "answered", answer: { kind: "limit" } })).toEqual({
      kind: "refused",
      answer: { kind: "limit" },
    });
    expect(scanStep(checking, { type: "answered", answer: { kind: "failed" } })).toEqual({
      kind: "refused",
      answer: { kind: "failed" },
    });
  });

  it("offers a retry of the same scan after a lost answer", () => {
    const lost = scanStep(checking, { type: "answered", answer: { kind: "network" } });
    expect(lost).toEqual({ kind: "lost", questId: "q1", token: "t1" });
    expect(scanStep(lost, { type: "retry" })).toEqual(checking);
  });

  it("ignores a read while checking, and an answer or details that do not fit", () => {
    expect(scanStep(checking, { type: "read", questId: "q2", token: "t2" })).toBe(checking);
    expect(scanStep(checking, { type: "again" })).toBe(checking);
    const scanning: ScanStep = { kind: "scanning" };
    expect(scanStep(scanning, { type: "answered", answer: { kind: "limit" } })).toBe(scanning);
    expect(scanStep(scanning, { type: "retry" })).toBe(scanning);
    expect(
      scanStep(scanning, {
        type: "details",
        details: { quest: undefined, finishedCategory: undefined, otherEvent: false },
      }),
    ).toBe(scanning);
  });

  it("scans again from a celebration or a refusal", () => {
    expect(scanStep({ kind: "refused", answer: { kind: "limit" } }, { type: "again" })).toEqual({
      kind: "scanning",
    });
  });

  it("takes the same key only to retry after a network failure, a new one after a server failure", () => {
    expect(keyFor({ key: "k1", code: "t1", retryable: true }, "t1", fresh)).toBe("k1");
    expect(keyFor({ key: "k1", code: "t1", retryable: false }, "t1", fresh)).toBe("new-key");
  });
});

describe("detailsAfter", () => {
  it("names the quest and the category this scan just finished", () => {
    const done = category("c", [quest("q1", { state: "done" }), quest("q2", { state: "done" })]);
    expect(detailsAfter(view(done), "q1", false)).toEqual({
      quest: done.quests[0],
      finishedCategory: done,
      otherEvent: false,
    });
  });

  it("finishes no category on a replay, below the cap, or with a quest left", () => {
    const done = category("c", [quest("q1", { state: "done" })]);
    expect(detailsAfter(view(done), "q1", true).finishedCategory).toBeUndefined();
    const belowCap = category("c", [quest("q1", { repeatCap: 3, done: 1, state: "open" })]);
    expect(detailsAfter(view(belowCap), "q1", false).finishedCategory).toBeUndefined();
    const left = category("c", [quest("q1", { state: "done" }), quest("q2")]);
    expect(detailsAfter(view(left), "q1", false).finishedCategory).toBeUndefined();
  });

  it("says another event when the quest is not this event's, and nothing when the quests could not be read", () => {
    expect(detailsAfter(view(category("c", [quest("q9")])), "q1", false)).toEqual({
      quest: undefined,
      finishedCategory: undefined,
      otherEvent: true,
    });
    expect(detailsAfter(undefined, "q1", false)).toEqual({
      quest: undefined,
      finishedCategory: undefined,
      otherEvent: false,
    });
  });
});

const ENTRY = {
  id: "41",
  at: "2026-11-01T12:00:00.000Z",
  kind: "quest",
  scoreDelta: 10,
  balanceDelta: 10,
  reason: { type: "quest", questId: "q1", title: { ar: null, en: "Find the word" } },
};

const ok = (body: unknown) => ({ kind: "ok" as const, status: 200, body, headers: new Headers() });
const error = (status: number, code: string) => ({
  kind: "error" as const,
  status,
  code,
  message: null,
  details: {},
  headers: new Headers(),
});

describe("readActivity and activityAnswer", () => {
  it("reads entries and the cursor", () => {
    expect(readActivity({ entries: [ENTRY], nextCursor: "41" })).toEqual({
      entries: [{ ...ENTRY, reason: undefined, title: { ar: null, en: "Find the word" } }].map(
        ({ reason: _reason, ...entry }) => entry,
      ),
      nextCursor: "41",
    });
  });

  it("shows a kind or reason this app does not know, without a title", () => {
    const spend = {
      ...ENTRY,
      kind: "spend",
      scoreDelta: 0,
      balanceDelta: -50,
      reason: { type: "reward" },
    };
    expect(readActivity({ entries: [spend], nextCursor: null })?.entries[0]).toMatchObject({
      kind: "spend",
      balanceDelta: -50,
      title: null,
    });
  });

  it("treats any other shape as a failure to load", () => {
    expect(
      readActivity({ entries: [{ ...ENTRY, scoreDelta: "10" }], nextCursor: null }),
    ).toBeUndefined();
    expect(
      readActivity({ entries: [{ ...ENTRY, reason: null }], nextCursor: null }),
    ).toBeUndefined();
    expect(readActivity({ entries: [], nextCursor: 41 })).toBeUndefined();
    expect(readActivity({ nextCursor: null })).toBeUndefined();
  });

  it("waits when pending and forgets only on the server's definite answer", () => {
    expect(activityAnswer(ok({ entries: [], nextCursor: null }))).toEqual({
      kind: "page",
      page: { entries: [], nextCursor: null },
    });
    expect(activityAnswer(error(403, "membership_pending"))).toEqual({ kind: "pending" });
    expect(activityAnswer(error(403, "not_enrolled"))).toEqual({ kind: "gone" });
    expect(activityAnswer(error(500, "internal"))).toEqual({ kind: "network" });
    expect(activityAnswer({ kind: "network" })).toEqual({ kind: "network" });
  });
});

describe("celebrationBeats", () => {
  const base = {
    kind: "celebrating",
    questId: "q1",
    points: 25,
    replayed: false,
    levelUp: null,
    bonus: null,
    item: null,
    met: null,
    details: undefined,
  } as const;
  const finished = { id: "c1" } as unknown as Category;
  const details = { quest: undefined, finishedCategory: finished, otherEvent: false };

  it("grows with rarity: the points, a level-up, then a finished category", () => {
    expect(celebrationBeats(base)).toEqual(["points"]);
    expect(celebrationBeats({ ...base, levelUp })).toEqual(["points", "level"]);
    expect(celebrationBeats({ ...base, details })).toEqual(["points", "category"]);
    expect(celebrationBeats({ ...base, levelUp, details })).toEqual([
      "points",
      "level",
      "category",
    ]);
  });
});
