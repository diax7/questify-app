import { describe, expect, it } from "vitest";
import { randomUuid } from "#src/api/uuid.ts";
import {
  categoryNotes,
  categorySummary,
  completionAnswer,
  findQuest,
  initiallyOpen,
  keyFor,
  questsAnswer,
  readQuests,
  scanFallback,
  type Category,
  type Quest,
} from "#src/event/quests-api.ts";

const quest = (id: string, fields: Partial<Quest> = {}): Quest => ({
  id,
  title: { ar: null, en: id },
  description: { ar: null, en: null },
  type: "enter_code",
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
  game: null,
  verification: [],
  communityLock: null,
  flash: null,
  boost: null,
  firstBonus: null,
  ...fields,
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
  communityLock: null,
  boost: null,
  quests,
});

const EVENT = { statusNow: "live", timezone: "Asia/Riyadh" };

const withQuest = (fields: Record<string, unknown>) => ({
  event: EVENT,
  categories: [{ id: "c", name: { ar: null, en: "c" }, quests: [{ ...quest("q"), ...fields }] }],
});

const fresh = () => "new-key";

const ok = (body: unknown) => ({ kind: "ok" as const, status: 200, body, headers: new Headers() });
const error = (
  status: number,
  code: string,
  details: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) => ({
  kind: "error" as const,
  status,
  code,
  message: { ar: "خطأ", en: "Error" },
  details,
  headers: new Headers(headers),
});

describe("readQuests and questsAnswer", () => {
  const body = { event: EVENT, categories: [category("c1", [quest("q1")])] };

  it("reads the event and well-formed categories", () => {
    expect(questsAnswer(ok(body))).toEqual({ kind: "quests", view: body });
    expect(readQuests({ event: EVENT, categories: [] })).toEqual({ event: EVENT, categories: [] });
  });

  it("keeps a quest in a state this app does not know", () => {
    const newer = { event: EVENT, categories: [category("c", [quest("q", { state: "locked" })])] };
    expect(readQuests(newer)?.categories[0]?.quests[0]?.state).toBe("locked");
  });

  it("keeps a quest of a type this app does not know", () => {
    const newer = {
      event: EVENT,
      categories: [category("c", [quest("q", { type: "vote_poll" })])],
    };
    expect(readQuests(newer)?.categories[0]?.quests[0]?.type).toBe("vote_poll");
  });

  it("treats any other shape as a failure to load", () => {
    expect(readQuests(withQuest({ earned: "10" }))).toBeUndefined();
    expect(readQuests(withQuest({ state: 3 }))).toBeUndefined();
    expect(readQuests(withQuest({ title: "x" }))).toBeUndefined();
    expect(readQuests({ categories: [] })).toBeUndefined();
    expect(readQuests({ event: { statusNow: "live" }, categories: [] })).toBeUndefined();
    expect(readQuests(null)).toBeUndefined();
    expect(questsAnswer(ok({}))).toEqual({ kind: "network" });
  });

  it("tells a pending member to wait, and forgets the event only on the server's definite answer", () => {
    expect(questsAnswer(error(403, "membership_pending"))).toEqual({ kind: "pending" });
    expect(questsAnswer(error(403, "not_enrolled"))).toEqual({ kind: "gone" });
    expect(questsAnswer(error(404, "not_found"))).toEqual({ kind: "gone" });
    expect(questsAnswer(error(500, "internal"))).toEqual({ kind: "network" });
    expect(questsAnswer({ kind: "network" })).toEqual({ kind: "network" });
    expect(questsAnswer({ kind: "signed_out" })).toEqual({ kind: "signed_out" });
  });
});

describe("categorySummary", () => {
  it("adds points earned of those available, and quests finished (the FR-230 example)", () => {
    const quests = [
      quest("a", { points: 1000, done: 1, earned: 1000, state: "done" }),
      quest("b", { points: 500, repeatCap: 2, done: 2, earned: 1000, state: "done" }),
      quest("c", { points: 1000, repeatCap: 2, done: 1, earned: 0 }),
      ...Array.from({ length: 7 }, (_, n) => quest(`x${n}`, { points: 1000 })),
    ];
    expect(categorySummary({ quests })).toEqual({
      earned: 2000,
      available: 1000 + 1000 + 2000 + 7000,
      finished: 2,
      total: 10,
    });
  });

  it("shows earned points as they are, even above what the quest gives now", () => {
    expect(
      categorySummary({ quests: [quest("a", { points: 50, earned: 100, state: "done" })] }),
    ).toEqual({
      earned: 100,
      available: 50,
      finished: 1,
      total: 1,
    });
  });

  it("is all zeros for an empty category", () => {
    expect(categorySummary({ quests: [] })).toEqual({
      earned: 0,
      available: 0,
      finished: 0,
      total: 0,
    });
  });
});

describe("initiallyOpen and findQuest", () => {
  const one = category("one", [quest("q1")]);
  const two = category("two", [quest("q2")]);

  it("opens the category holding the quest Home named", () => {
    expect(initiallyOpen([one, two], "q2")).toEqual(["two"]);
  });

  it("opens a lone category, and none of several otherwise", () => {
    expect(initiallyOpen([one], undefined)).toEqual(["one"]);
    expect(initiallyOpen([one, two], "unknown")).toEqual([]);
    expect(initiallyOpen([], "q1")).toEqual([]);
  });

  it("finds a quest in the latest data, or nothing once it is gone", () => {
    expect(findQuest([one, two], "q2")?.id).toBe("q2");
    expect(findQuest([one], "q2")).toBeUndefined();
  });
});

const passportBody = (steps: unknown) => ({
  event: EVENT,
  categories: [{ id: "c", name: { ar: null, en: "c" }, quests: [{ ...quest("p"), steps }] }],
});

describe("category rules (T-304)", () => {
  it("reads a passport's progress, and none when it is missing or not well formed", () => {
    expect(
      readQuests(passportBody({ done: 4, needed: 5 }))?.categories[0]?.quests[0]?.steps,
    ).toEqual({
      done: 4,
      needed: 5,
    });
    for (const steps of [null, undefined, { done: "4", needed: 5 }, 3]) {
      expect(
        readQuests(passportBody(steps))?.categories[0]?.quests[0]?.steps,
        String(steps),
      ).toBeNull();
    }
  });

  it("reads a category's rules, and none from an older API", () => {
    const body = {
      event: EVENT,
      categories: [
        {
          id: "c",
          name: { ar: null, en: "c" },
          orderMode: "in_order",
          opensAt: "2030-01-01T10:00:00.000Z",
          unlockAfter: { id: "b", name: { ar: "الأولى", en: null } },
          bonus: { points: 50, earned: 0, settled: true },
          quests: [{ ...quest("q"), state: "locked", lock: "order_locked" }],
        },
        {
          id: "d",
          name: { ar: null, en: "d" },
          quests: [{ ...quest("r"), lock: "something_new" }],
        },
      ],
    };
    const view = readQuests(body);
    expect(view?.categories[0]).toMatchObject({
      orderMode: "in_order",
      opensAt: "2030-01-01T10:00:00.000Z",
      unlockAfter: { id: "b", name: { ar: "الأولى", en: null } },
      bonus: { points: 50, earned: 0, settled: true },
      quests: [{ lock: "order_locked" }],
    });
    expect(view?.categories[1]).toMatchObject({
      orderMode: "any",
      opensAt: null,
      unlockAfter: null,
      bonus: { points: 0, earned: 0, settled: false },
      quests: [{ lock: null }],
    });
    const odd = readQuests({
      event: EVENT,
      categories: [
        {
          id: "e",
          name: { ar: null, en: "e" },
          orderMode: "random",
          opensAt: 5,
          unlockAfter: { id: 1 },
          bonus: { points: "5", earned: null },
          quests: [],
        },
      ],
    });
    expect(odd?.categories[0]).toMatchObject({
      orderMode: "any",
      opensAt: null,
      unlockAfter: null,
      bonus: { points: 0, earned: 0, settled: false },
    });
  });

  it("notes a category's opening and unlock while they shut its quests, its order and its bonus", () => {
    const rules = {
      orderMode: "in_order" as const,
      opensAt: "2030-01-01T10:00:00.000Z",
      unlockAfter: { id: "b", name: { ar: null, en: "One" } },
      bonus: { points: 50, earned: 0, settled: false, item: null },
    };
    const shut = {
      ...category("c", [
        quest("a", { state: "locked", lock: "category_not_started" }),
        quest("b", { state: "locked", lock: "category_locked" }),
      ]),
      ...rules,
    };
    expect(categoryNotes(shut)).toEqual([
      { kind: "opens", at: "2030-01-01T10:00:00.000Z" },
      { kind: "unlockAfter", name: { ar: null, en: "One" } },
      { kind: "inOrder" },
      { kind: "bonus", points: 50 },
    ]);
    const open = {
      ...category("c", [quest("a")]),
      ...rules,
      bonus: { points: 50, earned: 50, settled: true, item: null },
    };
    expect(categoryNotes(open)).toEqual([{ kind: "inOrder" }, { kind: "bonusEarned", points: 50 }]);
    expect(categoryNotes(category("c", [quest("a")]))).toEqual([]);
  });

  it("reads a category's refresh and notes when it resets (T-304c)", () => {
    const body = {
      event: EVENT,
      categories: [
        {
          id: "c",
          name: { ar: null, en: "c" },
          refresh: "daily",
          resetsAt: "2030-01-02T01:00:00.000Z",
          quests: [quest("q")],
        },
        { id: "d", name: { ar: null, en: "d" }, refresh: "hourly", resetsAt: 5, quests: [] },
      ],
    };
    const view = readQuests(body);
    expect(view?.categories[0]).toMatchObject({
      refresh: "daily",
      resetsAt: "2030-01-02T01:00:00.000Z",
    });
    expect(view?.categories[1]).toMatchObject({ refresh: "none", resetsAt: null });
    const weekly = {
      ...category("c", [quest("a")]),
      refresh: "weekly" as const,
      resetsAt: "2030-01-08T01:00:00.000Z",
    };
    expect(categoryNotes(weekly)).toEqual([
      { kind: "resets", refresh: "weekly", at: "2030-01-08T01:00:00.000Z" },
    ]);
    expect(categoryNotes({ ...weekly, resetsAt: null })).toEqual([]);
  });

  it("promises no bonus that was removed and will never be paid again", () => {
    const removed = {
      ...category("c", [quest("a")]),
      bonus: { points: 50, earned: 0, settled: true, item: { ar: null, en: "Cap" } },
    };
    expect(categoryNotes(removed)).toEqual([]);
  });

  it("promises a category's item while its bonus is not settled (T-304d)", () => {
    const shirt = { ar: "قميص", en: "T-shirt" };
    const giving = {
      ...category("c", [quest("a")]),
      bonus: { points: 0, earned: 0, settled: false, item: shirt },
    };
    expect(categoryNotes(giving)).toEqual([{ kind: "bonusItem", name: shirt }]);
  });
});

describe("completionAnswer", () => {
  it("reads a completion", () => {
    expect(completionAnswer(ok({ points: 10, score: 40, replayed: false, rank: 3 }))).toEqual({
      kind: "completed",
      points: 10,
      score: 40,
      replayed: false,
      levelUp: null,
      bonus: null,
      item: null,
      boost: null,
      firstBonus: null,
    });
    expect(completionAnswer(ok({ points: 20, score: 40, boost: { multiplier: 2 } }))).toMatchObject(
      { points: 20, boost: { multiplier: 2 } },
    );
    const shirt = { name: { ar: "قميص", en: null }, outcome: "out_of_stock", until: null };
    expect(
      completionAnswer(
        ok({
          points: 10,
          score: 60,
          item: shirt,
          bonus: { points: 0, category: { ar: null, en: "S" }, item: { ...shirt, outcome: "x" } },
        }),
      ),
    ).toMatchObject({ item: shirt, bonus: { points: 0, item: null } });
    const until = { at: "2030-01-01T18:00:00.000Z", timeZone: "Asia/Riyadh" };
    expect(
      completionAnswer(ok({ points: 1, score: 1, item: { ...shirt, outcome: "pending", until } })),
    ).toMatchObject({ item: { outcome: "pending", until } });
    expect(
      completionAnswer(
        ok({ points: 1, score: 1, item: { ...shirt, outcome: "pending", until: { at: 5 } } }),
      ),
    ).toMatchObject({ item: { until: null } });
    expect(
      completionAnswer(
        ok({
          points: 10,
          score: 60,
          bonus: { categoryId: "c", points: 50, category: { ar: "المرحلة", en: null } },
        }),
      ),
    ).toMatchObject({ bonus: { points: 50, category: { ar: "المرحلة", en: null } } });
    expect(completionAnswer(ok({ points: 10, score: 60, bonus: { points: "50" } }))).toMatchObject({
      bonus: null,
    });
    const title = { ar: "مقتفي الأثر", en: "Pathfinder" };
    expect(
      completionAnswer(ok({ points: 10, score: 40, replayed: true, levelUp: { level: 6, title } })),
    ).toMatchObject({ kind: "completed", replayed: true, levelUp: { level: 6, title } });
  });

  it("maps each refusal, and never to the event being gone", () => {
    expect(completionAnswer(error(422, "invalid_code"))).toEqual({
      kind: "wrong_code",
      problem: { ar: "خطأ", en: "Error" },
    });
    for (const reason of [
      "event_not_live",
      "hidden",
      "not_started",
      "ended",
      "not_for_you",
      "category_not_started",
      "category_locked",
      "order_locked",
    ]) {
      expect(completionAnswer(error(403, "quest_not_open", { reason }))).toEqual({
        kind: "not_open",
        reason,
      });
    }
    expect(completionAnswer(error(403, "quest_not_open", { reason: "new" }))).toEqual({
      kind: "not_open",
      reason: undefined,
    });
    expect(completionAnswer(error(409, "already_completed", { cap: 1 }))).toEqual({
      kind: "limit",
    });
    expect(completionAnswer(error(403, "enrollment_inactive", { reason: "banned" }))).toEqual({
      kind: "reload",
    });
    expect(completionAnswer(error(404, "not_found"))).toEqual({ kind: "reload" });
    expect(completionAnswer(error(404, "something_else"))).toEqual({ kind: "reload" });
    expect(completionAnswer(error(422, "idempotency_key_reused"))).toEqual({ kind: "failed" });
    expect(completionAnswer(error(500, "internal"))).toEqual({ kind: "failed" });
  });

  it("reads the wait from retry-after", () => {
    expect(completionAnswer(error(429, "too_many_attempts", {}, { "retry-after": "120" }))).toEqual(
      {
        kind: "wait",
        seconds: 120,
      },
    );
    expect(completionAnswer(error(429, "too_many_attempts"))).toEqual({
      kind: "wait",
      seconds: null,
    });
    expect(completionAnswer(error(429, "too_many_attempts", {}, { "retry-after": "0" }))).toEqual({
      kind: "wait",
      seconds: null,
    });
  });

  it("tells a lost answer from an unreadable one", () => {
    expect(completionAnswer({ kind: "network" })).toEqual({ kind: "network" });
    expect(completionAnswer({ kind: "signed_out" })).toEqual({ kind: "signed_out" });
    expect(completionAnswer(ok({ points: "10" }))).toEqual({ kind: "failed" });
  });
});

describe("keyFor", () => {
  it("reuses the key only to retry the same code after a network failure", () => {
    expect(keyFor({ key: "k1", code: "AB12", retryable: true }, "AB12", fresh)).toBe("k1");
  });

  it("takes a new key after any answer from the server, for another code, or the first time", () => {
    expect(keyFor({ key: "k1", code: "AB12", retryable: false }, "AB12", fresh)).toBe("new-key");
    expect(keyFor({ key: "k1", code: "AB12", retryable: true }, "AB13", fresh)).toBe("new-key");
    expect(keyFor(undefined, "AB12", fresh)).toBe("new-key");
  });
});

describe("randomUuid", () => {
  it("makes distinct version-4 UUIDs", () => {
    const made = Array.from({ length: 50 }, randomUuid);
    for (const id of made) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    expect(new Set(made).size).toBe(50);
  });
});

/** A quests answer with one scan quest, its fields overridden. */
const body = (fields: Record<string, unknown>) => ({
  event: { statusNow: "live", timezone: "Asia/Riyadh" },
  categories: [
    {
      id: "c1",
      name: { ar: null, en: "General" },
      quests: [
        {
          ...quest("q1", { type: "scan_qr" }),
          ...fields,
        },
      ],
    },
  ],
});

describe("readQuests and the verification methods", () => {
  it("keeps the server's methods, and gives a scan quest its printed code when an older server sends none", () => {
    const sent = readQuests(body({ verification: ["my_qr"] }));
    expect(sent?.categories[0]?.quests[0]?.verification).toEqual(["my_qr"]);
    const older = readQuests(body({ verification: undefined }));
    expect(older?.categories[0]?.quests[0]?.verification).toEqual(["quest_qr"]);
    expect(readQuests(body({ verification: "my_qr" }))).toBeUndefined();
  });
});

/** A game quest's state as read from the list. */
const readGame = (game: unknown) =>
  readQuests(body({ type: "game", game }))?.categories[0]?.quests[0]?.game;

describe("game quests (T-305)", () => {
  it("reads a game quest's attempts left and its pass, and none for anything not well formed", () => {
    expect(readGame({ attemptsLeft: 2, passed: false })).toEqual({
      attemptsLeft: 2,
      passed: false,
    });
    expect(readGame({ attemptsLeft: null, passed: true })).toEqual({
      attemptsLeft: null,
      passed: true,
    });
    for (const game of [
      undefined,
      null,
      { attemptsLeft: "2", passed: false },
      { attemptsLeft: 1 },
    ]) {
      expect(readGame(game)).toBeNull();
    }
  });
});

describe("location quests (T-303b)", () => {
  it("reads a location quest's spot, and none for anything not well formed", () => {
    const spot = { lat: 24.7136, lng: 46.6753, radiusM: 50 };
    expect(
      readQuests(body({ type: "location", place: spot }))?.categories[0]?.quests[0]?.place,
    ).toEqual(spot);
    for (const place of [
      undefined,
      null,
      { lat: "24", lng: 46, radiusM: 50 },
      { lat: 1, lng: 2 },
    ]) {
      expect(readQuests(body({ place }))?.categories[0]?.quests[0]?.place).toBeNull();
    }
  });

  it("reads a refused check-in with its reason and the player's own distance", () => {
    expect(
      completionAnswer(error(422, "location_refused", { reason: "not_here", distanceM: 140 })),
    ).toEqual({ kind: "location_refused", reason: "not_here", distanceM: 140 });
    expect(completionAnswer(error(422, "location_refused", { reason: "stale" }))).toEqual({
      kind: "location_refused",
      reason: "stale",
      distanceM: null,
    });
    expect(completionAnswer(error(422, "location_refused", { reason: "newer" }))).toEqual({
      kind: "location_refused",
      reason: undefined,
      distanceM: null,
    });
    expect(completionAnswer(error(403, "feature_off"))).toEqual({ kind: "location_off" });
  });

  it("offers the printed QR for a type this version does not know, only while it is open and has one", () => {
    const future = quest("q1", { type: "teleport", verification: ["quest_qr"] });
    expect(scanFallback(future)).toBe(true);
    expect(scanFallback({ ...future, state: "done" })).toBe(false);
    expect(scanFallback({ ...future, verification: ["my_qr"] })).toBe(false);
    expect(scanFallback(quest("q2", { type: "scan_qr", verification: ["quest_qr"] }))).toBe(false);
    expect(scanFallback(quest("q3", { type: "location", verification: ["quest_qr"] }))).toBe(false);
  });
});
