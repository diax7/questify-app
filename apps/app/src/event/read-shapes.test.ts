import { describe, expect, it } from "vitest";
import { rankingAnswer } from "#src/event/home-api.ts";
import { pollViewOf } from "#src/event/polls.ts";
import { readQuests } from "#src/event/quests-api.ts";

// Pins what the three readers keep and refuse, field by field, so a rewrite of their checks changes nothing.

const text = (en: string) => ({ ar: null, en });
const ok = (body: unknown) => ({ kind: "ok" as const, status: 200, body, headers: new Headers() });

describe("pollViewOf, field by field", () => {
  const poll = {
    title: text("Next talk?"),
    points: 10,
    options: [{ id: "a", text: text("Robots") }],
    choices: "one",
    results: "at_close",
    closesAt: "2030-01-01T10:05:00.000Z",
    closed: true,
    mine: ["a"],
    counts: { options: [{ id: "a", votes: 2 }], voters: 2 },
    serverNow: "2030-01-01T10:00:00.000Z",
    extra: "dropped",
  };

  it("keeps exactly the poll's fields", () => {
    const { extra: _extra, ...kept } = poll;
    expect(pollViewOf(poll)).toEqual(kept);
  });

  it("refuses a poll missing any field or holding a wrong one", () => {
    const wrong: Record<string, unknown> = {
      title: { ar: 1, en: null },
      points: "10",
      options: [{ id: "a" }],
      choices: "many",
      results: "sometimes",
      closesAt: 5,
      closed: "no",
      mine: [1],
      counts: undefined,
      serverNow: null,
    };
    for (const [field, value] of Object.entries(wrong)) {
      expect(pollViewOf({ ...poll, [field]: value }), field).toBeUndefined();
      const { [field]: _gone, ...without } = poll as Record<string, unknown>;
      expect(pollViewOf(without), `no ${field}`).toBeUndefined();
    }
    expect(pollViewOf([])).toBeUndefined();
    expect(pollViewOf("poll")).toBeUndefined();
  });

  it("accepts null counts and refuses counts without a voter total", () => {
    expect(pollViewOf({ ...poll, counts: null })?.counts).toBeNull();
    expect(pollViewOf({ ...poll, counts: { options: [] } })).toBeUndefined();
    expect(pollViewOf({ ...poll, counts: { options: [], voters: "1" } })).toBeUndefined();
  });
});

describe("a category's rules through readQuests", () => {
  const event = { statusNow: "live", timezone: "Asia/Riyadh" };
  const rulesOf = (category: Record<string, unknown>) =>
    readQuests({ event, categories: [{ id: "c", name: text("c"), quests: [], ...category }] })
      ?.categories[0];
  const NONE = {
    orderMode: "any",
    opensAt: null,
    unlockAfter: null,
    bonus: { points: 0, earned: 0, settled: false, item: null },
    refresh: "none",
    resetsAt: null,
    communityLock: null,
    boost: null,
  };

  it("reads every rule when the server sends them all", () => {
    const lock = {
      goalId: "g",
      title: text("Goal"),
      measure: "players",
      threshold: 20,
      state: "waiting",
      startsAt: "2030-01-01T10:00:00.000Z",
    };
    const category = rulesOf({
      orderMode: "in_order",
      opensAt: "2030-01-01T10:00:00.000Z",
      unlockAfter: { id: "b", name: text("One") },
      bonus: { points: 50, earned: 20, settled: true, item: text("Cap") },
      refresh: "weekly",
      resetsAt: "2030-01-08T00:00:00.000Z",
      communityLock: lock,
      boost: { multiplier: 2, endsAt: "2030-01-01T11:00:00.000Z" },
    });
    expect(category).toMatchObject({
      orderMode: "in_order",
      opensAt: "2030-01-01T10:00:00.000Z",
      unlockAfter: { id: "b", name: text("One") },
      bonus: { points: 50, earned: 20, settled: true, item: text("Cap") },
      refresh: "weekly",
      resetsAt: "2030-01-08T00:00:00.000Z",
      communityLock: lock,
      boost: { multiplier: 2, endsAt: "2030-01-01T11:00:00.000Z" },
    });
  });

  it("falls back to no rules for a missing or malformed one", () => {
    expect(rulesOf({})).toMatchObject(NONE);
    expect(
      rulesOf({
        orderMode: "shuffled",
        opensAt: 7,
        unlockAfter: { id: "b", name: "One" },
        bonus: "50",
        refresh: "monthly",
        resetsAt: false,
        communityLock: { goalId: "g" },
        boost: { multiplier: "2" },
      }),
    ).toMatchObject(NONE);
  });

  it("reads the daily refresh and each bonus field on its own", () => {
    expect(rulesOf({ refresh: "daily" })?.refresh).toBe("daily");
    expect(rulesOf({ bonus: { points: 5 } })?.bonus).toEqual({
      points: 5,
      earned: 0,
      settled: false,
      item: null,
    });
    expect(rulesOf({ bonus: { earned: 3, settled: "true", item: "Cap" } })?.bonus).toEqual({
      points: 0,
      earned: 3,
      settled: false,
      item: null,
    });
    expect(rulesOf({ unlockAfter: { id: 4, name: text("One") } })?.unlockAfter).toBeNull();
  });
});

describe("readRanking through rankingAnswer", () => {
  const row = { rank: 1, username: "sara", avatar: "fox", score: 90, isMe: false };
  const me = { rank: 4, username: "me", avatar: "owl", score: 20 };
  const body = { rows: [row], me, total: 12 };
  const refused = { kind: "network" };

  it("refuses a body that is not a ranking", () => {
    expect(rankingAnswer(ok(null))).toEqual(refused);
    expect(rankingAnswer(ok("x"))).toEqual(refused);
    expect(rankingAnswer(ok({ ...body, rows: "none" }))).toEqual(refused);
    expect(rankingAnswer(ok({ ...body, total: "12" }))).toEqual(refused);
    const { total: _total, ...noTotal } = body;
    expect(rankingAnswer(ok(noTotal))).toEqual(refused);
    const { me: _me, ...noMe } = body;
    expect(rankingAnswer(ok(noMe))).toEqual(refused);
  });

  it("refuses a player's own place with a missing or wrong field", () => {
    for (const bad of [
      { ...me, rank: "4" },
      { ...me, username: 1 },
      { ...me, avatar: null },
      { ...me, score: "20" },
      "me",
    ]) {
      expect(rankingAnswer(ok({ ...body, me: bad })), JSON.stringify(bad)).toEqual(refused);
    }
    expect(rankingAnswer(ok({ ...body, me: { ...me, score: undefined } }))).toMatchObject({
      kind: "ranking",
    });
  });

  it("refuses a row with a missing or wrong field, and keeps a hidden row without names", () => {
    for (const bad of [
      { ...row, rank: "1" },
      { ...row, username: 1 },
      { ...row, isMe: "no" },
      { ...row, score: "90" },
      null,
    ]) {
      expect(rankingAnswer(ok({ ...body, rows: [bad] })), JSON.stringify(bad)).toEqual(refused);
    }
    const hidden = { rank: 2, hidden: true, isMe: false };
    expect(rankingAnswer(ok({ ...body, rows: [hidden] }))).toMatchObject({
      kind: "ranking",
      ranking: { rows: [{ rank: 2, hidden: true, username: "", avatar: "", score: null }] },
    });
  });

  it("shapes the whole ranking", () => {
    expect(rankingAnswer(ok({ ...body, today: true, names: "full_name", scores: false }))).toEqual({
      kind: "ranking",
      ranking: {
        rows: [
          {
            rank: 1,
            username: "sara",
            avatar: "fox",
            isMe: false,
            score: null,
            fullName: null,
            hidden: false,
          },
        ],
        me: { rank: 4, username: "me", avatar: "owl", score: null, fullName: null },
        total: 12,
        today: true,
        scores: false,
        names: "full_name",
      },
    });
    expect(rankingAnswer(ok({ ...body, me: null, names: "nonsense" }))).toMatchObject({
      ranking: { me: null, names: "username", today: false, scores: true },
    });
  });
});
