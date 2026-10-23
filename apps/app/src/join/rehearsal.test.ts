import { describe, expect, it } from "vitest";
import type { ApiRequest } from "#src/api/client.ts";
import type { AuthedResult } from "#src/api/session.ts";
import { isRehearsalStatus } from "#src/event/rehearsal.ts";
import { fetchRehearsal, joinRehearsal, readRehearsalEvent } from "#src/join/rehearsal-api.ts";

const headers = new Headers();
const CARD = { version: "0.1", title: { ar: "سيرى", en: "Will see" }, receives: [] };
const EVENT = {
  id: "e1",
  name: { ar: null, en: "Fest" },
  venue: { ar: null, en: null },
  statusNow: "draft",
};
const MESSAGE = { ar: "م", en: "M" };

const sessionAnswering = (answer: AuthedResult) => {
  const calls: Array<Omit<ApiRequest, "accessToken">> = [];
  return {
    calls,
    session: {
      request: async (request: Omit<ApiRequest, "accessToken">) => {
        calls.push(request);
        return answer;
      },
    },
  };
};
const fail = (
  status: number,
  code: string,
  details: Record<string, unknown> = {},
): AuthedResult => ({
  kind: "error",
  status,
  code,
  message: MESSAGE,
  details,
  headers,
});

describe("the rehearsal card", () => {
  it("reads the event and the card by the code", async () => {
    const ok = sessionAnswering({
      kind: "ok",
      status: 200,
      body: { event: EVENT, card: CARD },
      headers,
    });
    expect(await fetchRehearsal(ok.session, "ABCD-2345")).toEqual({
      kind: "card",
      event: EVENT,
      card: CARD,
    });
    expect(ok.calls[0]).toEqual({ method: "GET", path: "/v1/rehearsals/ABCD-2345" });
  });

  it("answers not found, throttled, network and signed out", async () => {
    expect(
      await fetchRehearsal(sessionAnswering(fail(404, "rehearsal_closed")).session, "X"),
    ).toEqual({
      kind: "not_found",
    });
    expect(
      await fetchRehearsal(sessionAnswering(fail(429, "too_many_attempts")).session, "X"),
    ).toEqual({
      kind: "throttled",
    });
    expect(await fetchRehearsal(sessionAnswering(fail(500, "internal")).session, "X")).toEqual({
      kind: "network",
    });
    expect(await fetchRehearsal(sessionAnswering({ kind: "signed_out" }).session, "X")).toEqual({
      kind: "signed_out",
    });
    const broken = sessionAnswering({
      kind: "ok",
      status: 200,
      body: { event: { id: 1 }, card: CARD },
      headers,
    });
    expect(await fetchRehearsal(broken.session, "X")).toEqual({ kind: "network" });
    const noCard = sessionAnswering({ kind: "ok", status: 200, body: { event: EVENT }, headers });
    expect(await fetchRehearsal(noCard.session, "X")).toEqual({ kind: "network" });
  });

  it("checks the event field by field", () => {
    expect(readRehearsalEvent(EVENT)).toEqual(EVENT);
    for (const broken of [
      null,
      { ...EVENT, id: 1 },
      { ...EVENT, name: "Fest" },
      { ...EVENT, venue: { ar: 1, en: null } },
      { ...EVENT, statusNow: null },
    ]) {
      expect(readRehearsalEvent(broken)).toBeUndefined();
    }
  });
});

describe("joining a rehearsal", () => {
  it("joins with the card's version and answers the event", async () => {
    const ok = sessionAnswering({
      kind: "ok",
      status: 200,
      body: { eventId: "e1", enrollmentId: "n1", alreadyMember: true },
      headers,
    });
    expect(await joinRehearsal(ok.session, "ABCD-2345", "0.1")).toEqual({
      kind: "joined",
      eventId: "e1",
      alreadyMember: true,
    });
    expect(ok.calls[0]).toEqual({
      method: "POST",
      path: "/v1/rehearsals/join",
      body: { code: "ABCD-2345", cardVersion: "0.1" },
    });
    const odd = sessionAnswering({ kind: "ok", status: 200, body: {}, headers });
    expect(await joinRehearsal(odd.session, "X", "0.1")).toEqual({ kind: "network" });
  });

  it("shows a new card, or the server's words for a refusal", async () => {
    const stale = sessionAnswering(fail(409, "card_version_stale", { card: CARD }));
    expect(await joinRehearsal(stale.session, "X", "0.0")).toEqual({ kind: "stale", card: CARD });
    const full = sessionAnswering(fail(409, "rehearsal_full"));
    expect(await joinRehearsal(full.session, "X", "0.1")).toEqual({
      kind: "refused",
      code: "rehearsal_full",
      problem: MESSAGE,
    });
    expect(await joinRehearsal(sessionAnswering({ kind: "network" }).session, "X", "0.1")).toEqual({
      kind: "network",
    });
  });
});

describe("isRehearsalStatus", () => {
  it("is a Draft or Scheduled event only", () => {
    expect(isRehearsalStatus("draft")).toBe(true);
    expect(isRehearsalStatus("scheduled")).toBe(true);
    expect(isRehearsalStatus("live")).toBe(false);
    expect(isRehearsalStatus(undefined)).toBe(false);
  });
});
