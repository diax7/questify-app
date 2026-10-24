import { describe, expect, it } from "vitest";
import { configKeyOf } from "#src/config/remote.ts";
import { countdown, nextBoundary, spanText } from "#src/event/countdown.ts";
import { goalMessage } from "#src/event/goal.ts";
import { homeAnswer, rankingAnswer, readHome, readWin } from "#src/event/home-api.ts";
import {
  RECENT_KEY,
  chooseLaunchEvent,
  forget,
  markOpened,
  parseRecent,
  readMyEvents,
  type KeyValueStore,
  type MyEvent,
} from "#src/event/launch.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("spanText", () => {
  it.each([
    [1, "يوم", "1 day"],
    [2, "يومين", "2 days"],
    [3, "3 أيام", "3 days"],
    [10, "10 أيام", "10 days"],
    [11, "11 يومًا", "11 days"],
    [99, "99 يومًا", "99 days"],
    [100, "100 يوم", "100 days"],
    [103, "103 أيام", "103 days"],
    [111, "111 يومًا", "111 days"],
  ])("writes %i days in both languages", (n, ar, en) => {
    expect(spanText(n * DAY, "ar")).toBe(ar);
    expect(spanText(n * DAY, "en")).toBe(en);
  });

  it("takes the largest whole unit, rounded down", () => {
    expect(spanText(DAY - 1, "ar")).toBe("23 ساعة");
    expect(spanText(2 * HOUR + 59 * MINUTE, "ar")).toBe("ساعتين");
    expect(spanText(HOUR, "en")).toBe("1 hour");
    expect(spanText(5 * MINUTE + 59_000, "ar")).toBe("5 دقائق");
    expect(spanText(MINUTE, "ar")).toBe("دقيقة");
    expect(spanText(2 * MINUTE, "ar")).toBe("دقيقتين");
    expect(spanText(42 * MINUTE, "en")).toBe("42 minutes");
  });

  it("has no words for under a minute", () => {
    expect(spanText(59_999, "ar")).toBeNull();
    expect(spanText(0, "en")).toBeNull();
  });
});

const NOW = Date.parse("2026-11-01T12:00:00Z");
const at = (ms: number) => new Date(NOW + ms).toISOString();

describe("countdown", () => {
  it("counts to the start while scheduled and to the end while live", () => {
    const times = { startsAt: at(2 * DAY), endsAt: at(3 * DAY) };
    expect(countdown({ ...times, statusNow: "scheduled" }, NOW, "ar")).toEqual({
      kind: "starts",
      span: "يومين",
    });
    expect(countdown({ ...times, statusNow: "live" }, NOW, "en")).toEqual({
      kind: "ends",
      span: "3 days",
    });
  });

  it("says ended after the end, and nothing for a draft", () => {
    expect(countdown({ statusNow: "ended", startsAt: null, endsAt: null }, NOW, "ar")).toEqual({
      kind: "ended",
    });
    expect(countdown({ statusNow: "archived", startsAt: null, endsAt: null }, NOW, "ar")).toEqual({
      kind: "ended",
    });
    expect(countdown({ statusNow: "draft", startsAt: null, endsAt: null }, NOW, "ar")).toBeNull();
  });

  it("keeps the server's status when the phone's clock is past the boundary", () => {
    expect(
      countdown({ statusNow: "scheduled", startsAt: at(-MINUTE), endsAt: at(DAY) }, NOW, "en"),
    ).toEqual({ kind: "starts", span: null });
  });
});

describe("nextBoundary", () => {
  it("asks again a second after the start while scheduled and after the end while live", () => {
    const times = { startsAt: at(10 * MINUTE), endsAt: at(HOUR) };
    expect(nextBoundary({ ...times, statusNow: "scheduled" }, NOW)).toBe(10 * MINUTE + 1000);
    expect(nextBoundary({ ...times, statusNow: "live" }, NOW)).toBe(HOUR + 1000);
  });

  it("asks soon for a boundary already passed, at most a day ahead, and never after the end", () => {
    expect(nextBoundary({ statusNow: "live", startsAt: at(-DAY), endsAt: at(-1) }, NOW)).toBe(
      30_000,
    );
    expect(nextBoundary({ statusNow: "live", startsAt: null, endsAt: at(30 * DAY) }, NOW)).toBe(
      DAY,
    );
    expect(
      nextBoundary({ statusNow: "ended", startsAt: at(-DAY), endsAt: at(-1) }, NOW),
    ).toBeNull();
    expect(nextBoundary({ statusNow: "draft", startsAt: null, endsAt: null }, NOW)).toBeNull();
  });
});

const event = (id: string, fields: Partial<MyEvent> = {}): MyEvent => ({
  id,
  joinCode: id.toUpperCase(),
  name: { ar: null, en: id },
  statusNow: "live",
  status: "active",
  ...fields,
});

describe("chooseLaunchEvent", () => {
  it("opens the live event opened most recently on this phone", () => {
    const events = [event("a"), event("b"), event("c")];
    expect(chooseLaunchEvent(events, { a: 10, b: 30, c: 20 })).toBe("b");
  });

  it("puts events never opened here after those, in the list's order", () => {
    expect(chooseLaunchEvent([event("new"), event("old")], { old: 5 })).toBe("old");
    expect(chooseLaunchEvent([event("first"), event("second")], {})).toBe("first");
  });

  it("skips pending memberships and events that are not live", () => {
    const events = [
      event("pending", { status: "pending" }),
      event("declined", { status: "declined" }),
      event("soon", { statusNow: "scheduled" }),
      event("over", { statusNow: "ended" }),
      event("live"),
    ];
    expect(chooseLaunchEvent(events, { pending: 9, declined: 9, soon: 9, over: 9 })).toBe("live");
  });

  it("opens Questify home with nothing live, or for a remembered event no longer listed", () => {
    expect(chooseLaunchEvent([event("soon", { statusNow: "scheduled" })], {})).toBeNull();
    expect(chooseLaunchEvent([], { gone: 99 })).toBeNull();
  });
});

const memoryStore = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial));
  const store: KeyValueStore = {
    getItem: async (key) => data.get(key) ?? null,
    setItem: async (key, value) => {
      data.set(key, value);
    },
    removeItem: async (key) => {
      data.delete(key);
    },
  };
  return { store, data };
};

describe("the recency map", () => {
  it("reads only finite numbers, and nothing from a broken entry", () => {
    expect(parseRecent('{"a": 1, "b": "x", "c": null}')).toEqual({ a: 1 });
    expect(parseRecent("not json")).toEqual({});
    expect(parseRecent("[1, 2]")).toEqual({});
    expect(parseRecent(null)).toEqual({});
  });

  it("marks an event opened and forgets one", async () => {
    const { store, data } = memoryStore({
      [RECENT_KEY]: '{"a": 1}',
      [configKeyOf("a")]: "{}",
      [configKeyOf("b")]: "{}",
    });
    await markOpened(store, "b", 50);
    expect(JSON.parse(data.get(RECENT_KEY) ?? "")).toEqual({ a: 1, b: 50 });
    await forget(store, "a");
    expect(JSON.parse(data.get(RECENT_KEY) ?? "")).toEqual({ b: 50 });
    expect(data.has(configKeyOf("a"))).toBe(false);
    expect(data.has(configKeyOf("b"))).toBe(true);
  });

  it("never fails the screen when the storage does", async () => {
    const broken: KeyValueStore = {
      getItem: () => Promise.reject(new Error("disk")),
      setItem: () => Promise.reject(new Error("disk")),
      removeItem: () => Promise.reject(new Error("disk")),
    };
    await expect(markOpened(broken, "a", 1)).resolves.toBeUndefined();
    await expect(forget(broken, "a")).resolves.toBeUndefined();
  });
});

describe("readMyEvents", () => {
  it("keeps well-formed events and drops the rest", () => {
    const good = {
      id: "e1",
      joinCode: "AB12",
      name: { ar: null, en: "Fest" },
      statusNow: "live",
      status: "active",
    };
    expect(readMyEvents({ events: [good, { ...good, status: "left" }, { id: 3 }] })).toEqual([
      good,
    ]);
    const declined = { ...good, id: "e2", status: "declined" };
    expect(readMyEvents({ events: [declined] })).toEqual([declined]);
    expect(readMyEvents({ events: "nope" })).toBeUndefined();
    expect(readMyEvents(null)).toBeUndefined();
  });
});

const HOME = {
  event: {
    id: "e1",
    name: { ar: "مهرجان", en: "Fest" },
    venue: { ar: null, en: "Hall 3" },
    startsAt: "2026-11-01T10:00:00.000Z",
    endsAt: "2026-11-02T10:00:00.000Z",
    timezone: "Asia/Riyadh",
    statusNow: "live",
    rehearsal: false,
    locationPrompt: false,
  },
  standing: {
    status: "active",
    score: 25,
    balance: 20,
    pendingPoints: 150,
    questsDone: 1,
    questsTotal: 3,
  },
  upNext: { questId: "q1", title: { ar: null, en: "Big one" }, points: 40, type: "enter_code" },
  goal: {
    rewardId: "r1",
    name: { ar: "قهوة", en: "Coffee" },
    price: 50,
    left: 30,
    pinned: false,
    soldOut: false,
    communityLock: null,
  },
  win: null,
  rankingOn: true,
  helpUnread: 0,
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

describe("homeAnswer", () => {
  it("reads an active member's Home, a pending or waitlisted member's, and a declined one's", () => {
    expect(homeAnswer(ok(HOME))).toEqual({ kind: "home", home: HOME });
    const pending = { ...HOME, standing: { status: "pending", waitlisted: false }, upNext: null };
    expect(homeAnswer(ok(pending))).toEqual({ kind: "home", home: pending });
    const listed = { ...HOME, standing: { status: "pending", waitlisted: true }, upNext: null };
    expect(homeAnswer(ok(listed))).toEqual({ kind: "home", home: listed });
    // An older API sends no flag: an ordinary request.
    expect(readHome({ ...HOME, standing: { status: "pending" } })?.standing).toEqual({
      status: "pending",
      waitlisted: false,
    });
    const declined = { ...HOME, standing: { status: "declined" }, upNext: null };
    expect(homeAnswer(ok(declined))).toEqual({ kind: "home", home: declined });
  });

  it("reads pending points as 0 from a server before T-301, or when malformed", () => {
    const older = { ...HOME, standing: { ...HOME.standing, pendingPoints: undefined } };
    expect(readHome(older)?.standing).toMatchObject({ pendingPoints: 0 });
    const odd = { ...HOME, standing: { ...HOME.standing, pendingPoints: -5 } };
    expect(readHome(odd)?.standing).toMatchObject({ pendingPoints: 0 });
  });

  it("reads a rehearsal account's Home, and an older API's Home as an ordinary member's", () => {
    const rehearsal = { ...HOME, event: { ...HOME.event, statusNow: "draft", rehearsal: true } };
    expect(homeAnswer(ok(rehearsal))).toEqual({ kind: "home", home: rehearsal });
    const { rehearsal: _flag, ...older } = HOME.event;
    expect(readHome({ ...HOME, event: older })?.event.rehearsal).toBe(false);
    expect(readHome({ ...HOME, event: { ...HOME.event, rehearsal: "yes" } })).toBeUndefined();
  });

  it("reads the location prompt flag, and an older API's Home as none (T-303b)", () => {
    expect(
      readHome({ ...HOME, event: { ...HOME.event, locationPrompt: true } })?.event.locationPrompt,
    ).toBe(true);
    const { locationPrompt: _prompt, ...older } = HOME.event;
    expect(readHome({ ...HOME, event: older })?.event.locationPrompt).toBe(false);
  });

  it("reads the win, and shows none for an older API or one it cannot read (T-214)", () => {
    const win = {
      rank: 1,
      prize: { kind: "item", name: { ar: "كأس", en: "Cup" } },
      redemptionId: "d9",
      claimUntil: "2030-01-03T10:00:00Z",
    };
    expect(readHome({ ...HOME, win })?.win).toEqual(win);
    const { win: _win, ...older } = HOME;
    expect(readHome(older)?.win).toBeNull();
    expect(readWin({ ...win, rank: "1" })).toBeNull();
    expect(readWin({ ...win, redemptionId: 9 })).toBeNull();
    expect(readWin({ ...win, claimUntil: 5 })).toBeNull();
    expect(readWin({ ...win, prize: null })).toBeNull();
    expect(readWin({ ...win, prize: { kind: 1, name: win.prize.name } })).toBeNull();
    expect(readWin({ ...win, prize: { kind: "item", name: "Cup" } })).toBeNull();
    expect(readWin({ ...win, claimUntil: null })).toEqual({ ...win, claimUntil: null });
  });

  it("reads the goal, and shows none for an older API or a goal it cannot read (T-213)", () => {
    const { goal: _goal, ...older } = HOME;
    expect(readHome(older)?.goal).toBeNull();
    expect(readHome({ ...HOME, goal: null })?.goal).toBeNull();
    expect(readHome({ ...HOME, goal: { ...HOME.goal, left: "30" } })?.goal).toBeNull();
    expect(readHome({ ...HOME, goal: { ...HOME.goal, pinned: 1 } })?.goal).toBeNull();
    expect(readHome({ ...HOME, goal: { ...HOME.goal, soldOut: undefined } })?.goal).toBeNull();
    expect(readHome({ ...HOME, goal: { ...HOME.goal, name: "Coffee" } })?.goal).toBeNull();
    expect(readHome({ ...HOME, goal: { ...HOME.goal, rewardId: 7 } })?.goal).toBeNull();
    expect(readHome({ ...HOME, goal: { ...HOME.goal, price: null } })?.goal).toBeNull();
  });

  it("names the goal's line: sold out, enough, or what is left, and nothing left to count once ended", () => {
    expect(goalMessage(HOME.goal, false)).toBe("goal.left");
    expect(goalMessage(HOME.goal, true)).toBeNull();
    expect(goalMessage({ ...HOME.goal, left: 0 }, false)).toBe("goal.ready");
    expect(goalMessage({ ...HOME.goal, left: 0 }, true)).toBe("goal.ready");
    expect(goalMessage({ ...HOME.goal, left: -5 }, false)).toBe("goal.ready");
    expect(goalMessage({ ...HOME.goal, left: 0, soldOut: true }, false)).toBe("goal.soldOut");
    expect(goalMessage({ ...HOME.goal, soldOut: true }, true)).toBe("goal.soldOut");
  });

  it("reads the help desk's unseen answers, and 0 for an older API or anything else (T-310)", () => {
    expect(readHome({ ...HOME, help: { unread: 2 } })?.helpUnread).toBe(2);
    expect(readHome(HOME)?.helpUnread).toBe(0);
    expect(readHome({ ...HOME, help: { unread: "2" } })?.helpUnread).toBe(0);
    expect(readHome({ ...HOME, help: { unread: -1 } })?.helpUnread).toBe(0);
    expect(readHome({ ...HOME, help: { unread: 1.5 } })?.helpUnread).toBe(0);
    expect(readHome({ ...HOME, help: null })?.helpUnread).toBe(0);
  });

  it("forgets the event only on the server's definite answer", () => {
    expect(homeAnswer(error(403, "not_enrolled"))).toEqual({ kind: "gone" });
    expect(homeAnswer(error(404, "not_found"))).toEqual({ kind: "gone" });
    expect(homeAnswer(error(500, "internal"))).toEqual({ kind: "network" });
    expect(homeAnswer(error(429, "too_many_attempts"))).toEqual({ kind: "network" });
    expect(homeAnswer({ kind: "network" })).toEqual({ kind: "network" });
    expect(homeAnswer({ kind: "signed_out" })).toEqual({ kind: "signed_out" });
  });

  it("treats an answer of another shape as a failure to load", () => {
    expect(homeAnswer(ok({ ...HOME, rankingOn: "yes" }))).toEqual({ kind: "network" });
    expect(homeAnswer(ok({ ...HOME, standing: { status: "active", score: "25" } }))).toEqual({
      kind: "network",
    });
    expect(homeAnswer(ok({ ...HOME, upNext: { questId: "q1" } }))).toEqual({ kind: "network" });
    expect(readHome({ ...HOME, event: { ...HOME.event, startsAt: 5 } })).toBeUndefined();
    expect(readHome("nope")).toBeUndefined();
  });
});

describe("rankingAnswer", () => {
  const ranking = {
    rows: [{ rank: 1, username: "sara", avatar: "fox", score: 90, isMe: false }],
    me: { rank: 4, username: "me", avatar: "owl", score: 20 },
    total: 12,
  };

  it("reads an avatar this app does not know, and refuses one that is not a string", () => {
    const newer = { ...ranking, rows: [{ ...ranking.rows[0], avatar: "dragon" }] };
    expect(rankingAnswer(ok(newer))).toMatchObject({ kind: "ranking" });
    expect(rankingAnswer(ok({ ...ranking, rows: [{ ...ranking.rows[0], avatar: 3 }] }))).toEqual({
      kind: "network",
    });
    const { avatar: _avatar, ...noAvatar } = ranking.me;
    expect(rankingAnswer(ok({ ...ranking, me: noAvatar }))).toEqual({ kind: "network" });
  });

  it("reads the ranking, with or without the player's own place", () => {
    expect(rankingAnswer(ok(ranking))).toMatchObject({ kind: "ranking", ranking: { total: 12 } });
    expect(rankingAnswer(ok({ ...ranking, me: null }))).toMatchObject({ kind: "ranking" });
  });

  it("reads whether today's ranking is offered (an older server's answer has none)", () => {
    expect(rankingAnswer(ok({ ...ranking, today: true }))).toMatchObject({
      ranking: { today: true },
    });
    expect(rankingAnswer(ok(ranking))).toMatchObject({ ranking: { today: false } });
    expect(rankingAnswer(ok({ ...ranking, today: "yes" }))).toMatchObject({
      ranking: { today: false },
    });
    expect(rankingAnswer(error(404, "today_ranking_off"))).toEqual({ kind: "today_off" });
  });

  it("hides the card when the ranking is off, and says so for any other failure", () => {
    expect(rankingAnswer(error(404, "ranking_off"))).toEqual({ kind: "off" });
    expect(rankingAnswer(error(404, "not_found"))).toEqual({ kind: "gone" });
    expect(rankingAnswer(error(403, "not_enrolled"))).toEqual({ kind: "gone" });
    expect(rankingAnswer(error(500, "internal"))).toEqual({ kind: "network" });
    expect(rankingAnswer(ok({ ...ranking, rows: [{ rank: "1" }] }))).toEqual({ kind: "network" });
    expect(rankingAnswer(ok({ ...ranking, me: { rank: 1 } }))).toEqual({ kind: "network" });
  });
});
