import { describe, expect, it } from "vitest";
import {
  calmScreen,
  clockText,
  fetchLive,
  fetchPoll,
  livePollSecondsOf,
  liveStateOf,
  nextPoll,
  nextResults,
  pollViewOf,
  rememberShown,
  sharesOf,
  shownOf,
  toggleChoice,
} from "#src/event/polls.ts";

const text = (en: string) => ({ ar: null, en });
const options = [
  { id: "a", text: text("Robots") },
  { id: "b", text: text("Space") },
];
const poll = {
  title: text("Next talk?"),
  points: 10,
  options,
  choices: "several",
  results: "after_vote",
  closesAt: "2030-01-01T10:05:00.000Z",
  closed: false,
  mine: [],
  counts: null,
  resultsWhen: "after_vote",
  serverNow: "2030-01-01T10:00:00.000Z",
};
const tab = (name: string) => ["event", "[eventId]", "(tabs)", name];
const config = (value: unknown) => ({ tuning: { livePollSeconds: value } }) as never;
const headers = (entries: Record<string, string>) => new Headers(entries);
const sessionAnswering = (answer: unknown) => {
  const asked: unknown[] = [];
  return {
    asked,
    session: {
      request: async (request: unknown) => {
        asked.push(request);
        return answer as never;
      },
    },
  };
};

describe("the poll read (T-306)", () => {
  it("reads a poll with or without counts, and refuses anything malformed", () => {
    expect(pollViewOf(poll)).toMatchObject({ choices: "several", mine: [], counts: null });
    const counts = { options: [{ id: "a", votes: 2 }], voters: 3 };
    expect(pollViewOf({ ...poll, counts })?.counts).toEqual(counts);
    for (const broken of [
      { ...poll, choices: "all" },
      { ...poll, results: "later" },
      { ...poll, mine: "a" },
      { ...poll, counts: { options: [{ id: "a" }], voters: 1 } },
      { ...poll, points: "10" },
      { ...poll, title: "x" },
      { ...poll, closesAt: null },
      null,
    ]) {
      expect(pollViewOf(broken), JSON.stringify(broken)).toBeUndefined();
    }
  });

  it("tells a plain vote (404) from a poll and from a failure", async () => {
    const missing = sessionAnswering({
      kind: "error",
      status: 404,
      code: "not_found",
      message: null,
      details: {},
      headers: headers({}),
    });
    expect(await fetchPoll(missing.session, "q 1")).toBe("not_live");
    expect(missing.asked).toEqual([{ method: "GET", path: "/v1/quests/q%201/poll" }]);
    const found = sessionAnswering({ kind: "ok", status: 200, body: poll, headers: headers({}) });
    expect(await fetchPoll(found.session, "q")).toMatchObject({ choices: "several" });
    expect(await fetchPoll(sessionAnswering({ kind: "network" }).session, "q")).toBeUndefined();
  });

  it("toggles several choices and replaces one", () => {
    expect(toggleChoice(["a"], "b", "one")).toEqual(["b"]);
    expect(toggleChoice(["a"], "b", "several")).toEqual(["a", "b"]);
    expect(toggleChoice(["a", "b"], "a", "several")).toEqual(["b"]);
  });

  it("shares each option out of the voters, past 100% in all with several choices", () => {
    expect(
      sharesOf({
        options: [
          { id: "a", votes: 2 },
          { id: "b", votes: 2 },
          { id: "c", votes: 1 },
        ],
        voters: 3,
      }),
    ).toEqual([
      { id: "a", percent: 67 },
      { id: "b", percent: 67 },
      { id: "c", percent: 33 },
    ]);
    expect(sharesOf({ options: [{ id: "a", votes: 0 }], voters: 0 })).toEqual([
      { id: "a", percent: 0 },
    ]);
  });

  it("counts down as m:ss, and h:mm:ss from an hour", () => {
    expect(clockText(0)).toBe("0:00");
    expect(clockText(59.9)).toBe("0:59");
    expect(clockText(299)).toBe("4:59");
    expect(clockText(3600)).toBe("1:00:00");
    expect(clockText(3725)).toBe("1:02:05");
    expect(clockText(-5)).toBe("0:00");
  });
});

describe("what is live (T-306, ADR-221)", () => {
  const state = {
    polls: [
      { questId: "p1", closesAt: "2030-01-01T10:05:00.000Z" },
      { questId: "p2", closesAt: "2030-01-01T10:06:00.000Z" },
    ],
    closed: [{ questId: "c1" }, { questId: "c2" }],
    community: null,
    flash: [],
    boosts: [],
    firstBonus: [],
    cheers: null,
  };

  it("reads the state and drops malformed entries", () => {
    expect(
      liveStateOf({ ...state, polls: [...state.polls, { questId: 1 }], community: null }),
    ).toEqual(state);
    expect(liveStateOf({ polls: null, closed: [] })).toBeUndefined();
    expect(liveStateOf("x")).toBeUndefined();
  });

  it("sends the last ETag, keeps the state on a 304, and reads the server's clock", async () => {
    const unchanged = sessionAnswering({
      kind: "error",
      status: 304,
      code: "http_304",
      message: null,
      details: {},
      headers: headers({ "server-now": "2030-01-01T10:00:00.000Z" }),
    });
    expect(await fetchLive(unchanged.session, "e1", 'W/"t"')).toEqual({
      kind: "unchanged",
      serverNow: "2030-01-01T10:00:00.000Z",
    });
    expect(unchanged.asked).toEqual([
      { method: "GET", path: "/v1/events/e1/live", headers: { "if-none-match": 'W/"t"' } },
    ]);
    const fresh = sessionAnswering({
      kind: "ok",
      status: 200,
      body: state,
      headers: headers({ etag: 'W/"u"', "server-now": "2030-01-01T10:00:01.000Z" }),
    });
    expect(await fetchLive(fresh.session, "e1", null)).toEqual({
      kind: "state",
      state,
      etag: 'W/"u"',
      serverNow: "2030-01-01T10:00:01.000Z",
    });
    expect(fresh.asked).toEqual([{ method: "GET", path: "/v1/events/e1/live" }]);
    expect(await fetchLive(sessionAnswering({ kind: "network" }).session, "e1", null)).toEqual({
      kind: "failed",
    });
  });

  it("shows the next poll not put off, then the next results not yet shown", () => {
    expect(nextPoll(state, new Set())?.questId).toBe("p1");
    expect(nextPoll(state, new Set(["p1"]))?.questId).toBe("p2");
    expect(nextPoll(state, new Set(["p1", "p2"]))).toBeUndefined();
    expect(nextResults(state, ["c1"])).toBe("c2");
    expect(nextResults(state, ["c1", "c2"])).toBeUndefined();
  });

  it("remembers at most the latest 50 results cards, and reads a damaged list as none", () => {
    const many = Array.from({ length: 50 }, (_, i) => `q${i}`);
    const kept = rememberShown(many, "new");
    expect(kept).toHaveLength(50);
    expect(kept[49]).toBe("new");
    expect(kept).not.toContain("q0");
    expect(rememberShown(["a", "b"], "a")).toEqual(["b", "a"]);
    expect(shownOf(JSON.stringify(["a"]))).toEqual(["a"]);
    expect(shownOf(null)).toEqual([]);
    expect(shownOf("{not json")).toEqual([]);
    expect(shownOf("[1]")).toEqual([]);
  });

  it("waits for a calm screen: a tab other than Scan, no sheet open", () => {
    expect(calmScreen(tab("quests"), 0)).toBe(true);
    expect(calmScreen(tab("index"), 0)).toBe(true);
    expect(calmScreen(tab("quests"), 1)).toBe(false);
    expect(calmScreen(tab("scan"), 0)).toBe(false);
    expect(calmScreen(["event", "[eventId]", "game"], 0)).toBe(false);
    expect(calmScreen(["event", "[eventId]", "scan-quest"], 0)).toBe(false);
  });

  it("polls every 10 seconds by default, inside the tuning's range", () => {
    expect(livePollSecondsOf(undefined)).toBe(10);
    expect(livePollSecondsOf(config(20))).toBe(20);
    expect(livePollSecondsOf(config(1))).toBe(5);
    expect(livePollSecondsOf(config(600))).toBe(60);
    expect(livePollSecondsOf(config("x"))).toBe(10);
  });
});
