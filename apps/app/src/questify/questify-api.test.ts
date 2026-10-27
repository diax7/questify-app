import { describe, expect, it, vi } from "vitest";
import type { Session } from "#src/api/session.ts";
import {
  fetchAchievements,
  fetchEventPage,
  fetchQuestifyQuests,
  postSync,
} from "#src/questify/questify-api.ts";
import { completionAnswer } from "#src/event/quests-api.ts";
import { noteCompletion, onCompletion } from "#src/questify/completion-signal.ts";

const session = (answer: unknown) =>
  ({ request: vi.fn().mockResolvedValue(answer) }) as unknown as Session;
const ok = (body: unknown) => ({ kind: "ok", status: 200, body, headers: new Headers() });
const refused = (status: number, headers: Record<string, string> = {}) => ({
  kind: "error",
  status,
  code: "rate_limited",
  message: null,
  details: {},
  headers: new Headers(headers),
});

const achievement = {
  id: "events-attended",
  name: { ar: "رحّالة", en: "Wanderer" },
  visualKey: "ach-first-steps",
  tier: null,
  progress: 0,
  next: { tier: "bronze", target: 1 },
};
const event = {
  eventId: "6f1c7a0e-0000-4000-8000-000000000001",
  name: { ar: "مهرجان", en: "Fest" },
  date: "2026-10-26",
  startsAt: null,
  endsAt: null,
  timezone: "Asia/Riyadh",
  city: null,
  eventStatus: "ended",
  memberStatus: "active",
  score: 10,
  played: true,
  rank: 2,
  rankState: "final",
  isPublic: true,
};

describe("reads", () => {
  it("returns what fits the schema", async () => {
    expect(await fetchAchievements(session(ok({ achievements: [achievement] })))).toEqual([
      achievement,
    ]);
  });

  it("returns null, never an empty list, for a failed or odd answer", async () => {
    expect(await fetchAchievements(session({ kind: "network" }))).toBeNull();
    expect(await fetchAchievements(session(refused(500)))).toBeNull();
    expect(await fetchAchievements(session(ok({ achievements: [{ id: 1 }] })))).toBeNull();
    expect(await fetchQuestifyQuests(session(ok({ alwaysOn: [] })))).toBeNull();
  });

  it("asks for the passport with played=true and for the history without it", async () => {
    const passport = session(ok({ events: [event], nextCursor: null }));
    expect((await fetchEventPage(passport, { played: true, cursor: null }))?.events).toHaveLength(
      1,
    );
    expect(vi.mocked(passport.request).mock.calls[0]?.[0]).toMatchObject({
      method: "GET",
      path: "/v1/me/event-history?played=true",
    });
    const history = session(ok({ events: [], nextCursor: null }));
    await fetchEventPage(history, { played: false, cursor: "a b/c" });
    expect(vi.mocked(history.request).mock.calls[0]?.[0]).toMatchObject({
      path: "/v1/me/event-history?cursor=a%20b%2Fc",
    });
  });
});

describe("postSync", () => {
  const written = {
    achievements: [{ id: "events-attended", tier: "bronze" }],
    quests: [],
    levelUp: null,
    gems: { earned: 10, balance: 10 },
    dailyStreak: null,
  };

  it("returns what the sync wrote", async () => {
    const s = session(ok(written));
    expect(await postSync(s)).toEqual({ kind: "ok", sync: written });
    expect(vi.mocked(s.request).mock.calls[0]?.[0]).toMatchObject({
      method: "POST",
      path: "/v1/me/questify/sync",
    });
  });

  it("reports a 429 as limited, with the wait the server named", async () => {
    expect(await postSync(session(refused(429, { "retry-after": "20" })))).toEqual({
      kind: "limited",
      retryAfterSeconds: 20,
    });
    expect(await postSync(session(refused(429)))).toEqual({
      kind: "limited",
      retryAfterSeconds: null,
    });
    expect(await postSync(session(refused(429, { "retry-after": "soon" })))).toEqual({
      kind: "limited",
      retryAfterSeconds: null,
    });
  });

  it("reports any other failure, or an answer of the wrong shape, as failed", async () => {
    expect(await postSync(session(refused(500)))).toEqual({ kind: "failed" });
    expect(await postSync(session({ kind: "network" }))).toEqual({ kind: "failed" });
    expect(await postSync(session(ok({ achievements: "none" })))).toEqual({ kind: "failed" });
  });
});

const completed = (replayed: boolean) =>
  completionAnswer({ ...ok({ points: 5, score: 5, replayed }) } as never);

describe("the completion signal", () => {
  it("tells every listener once for a first completion and stops after the listener leaves", () => {
    const heard = vi.fn();
    const leave = onCompletion(heard);
    completed(false);
    expect(heard).toHaveBeenCalledTimes(1);
    leave();
    noteCompletion();
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("stays silent for a replayed answer and for a refusal", () => {
    const heard = vi.fn();
    const leave = onCompletion(heard);
    completed(true);
    completionAnswer(refused(409) as never);
    completionAnswer({ kind: "network" } as never);
    expect(heard).not.toHaveBeenCalled();
    leave();
  });
});
