import { describe, expect, it } from "vitest";
import { randomUuid } from "#src/api/uuid.ts";
import {
  categorySummary,
  completionAnswer,
  findQuest,
  initiallyOpen,
  keyFor,
  questsAnswer,
  readQuests,
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
  verification: [],
  ...fields,
});

const category = (id: string, quests: Quest[]): Category => ({
  id,
  name: { ar: null, en: id },
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

describe("completionAnswer", () => {
  it("reads a completion", () => {
    expect(completionAnswer(ok({ points: 10, score: 40, replayed: false, rank: 3 }))).toEqual({
      kind: "completed",
      points: 10,
      score: 40,
      replayed: false,
    });
  });

  it("maps each refusal, and never to the event being gone", () => {
    expect(completionAnswer(error(422, "invalid_code"))).toEqual({
      kind: "wrong_code",
      problem: { ar: "خطأ", en: "Error" },
    });
    for (const reason of ["event_not_live", "hidden", "not_started", "ended"]) {
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
