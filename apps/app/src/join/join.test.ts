import { describe, expect, it } from "vitest";
import type { ApiRequest, ApiResult, Client } from "#src/api/client.ts";
import type { AuthedResult } from "#src/api/session.ts";
import { routeForIncoming } from "#src/join/deep-link.ts";
import { fetchCard, joinEvent, readCard } from "#src/join/join-api.ts";

const headers = new Headers();
const CARD = {
  version: "0.1",
  title: { ar: "سيرى", en: "Will see" },
  receives: [{ ar: "الاسم", en: "Name" }],
};
const EVENT = {
  id: "e1",
  joinCode: "ABC234",
  name: { ar: null, en: "Fest" },
  venue: { ar: null, en: null },
  startsAt: "2030-01-01T00:00:00Z",
  endsAt: "2030-01-02T00:00:00Z",
  timezone: "Asia/Riyadh",
  statusNow: "live",
  access: "public",
};
const MESSAGE = { ar: "م", en: "M" };
const fail = (status: number, code: string, details: Record<string, unknown> = {}): ApiResult => ({
  kind: "error",
  status,
  code,
  message: MESSAGE,
  details,
  headers,
});

const clientAnswering = (answer: ApiResult) => {
  const calls: ApiRequest[] = [];
  const client: Client = {
    request: async (request) => {
      calls.push(request);
      return answer;
    },
  };
  return { client, calls };
};

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

describe("the join card", () => {
  it("reads a card, and refuses one of the wrong shape", async () => {
    const { client, calls } = clientAnswering({
      kind: "ok",
      status: 200,
      body: { event: EVENT, card: CARD },
      headers,
    });
    expect(await fetchCard(client, "abc 234")).toEqual({ kind: "card", event: EVENT, card: CARD });
    expect(calls[0]?.path).toBe("/v1/public/events/abc%20234");
    for (const body of [
      { event: EVENT },
      { event: { ...EVENT, statusNow: "draft" }, card: CARD },
      { event: { ...EVENT, access: "secret" }, card: CARD },
      { event: { ...EVENT, id: 1 }, card: CARD },
      { event: { ...EVENT, name: "Fest" }, card: CARD },
      { event: EVENT, card: { ...CARD, version: 1 } },
      { event: EVENT, card: { ...CARD, receives: [{ en: "x" }] } },
      null,
    ]) {
      expect(readCard(body), JSON.stringify(body)).toBeUndefined();
    }
    expect(
      await fetchCard(clientAnswering({ kind: "ok", status: 200, body: {}, headers }).client, "X"),
    ).toEqual({
      kind: "network",
    });
  });

  it("maps a missing code, a busy network and an outage", async () => {
    expect(await fetchCard(clientAnswering(fail(404, "not_found")).client, "X")).toEqual({
      kind: "not_found",
    });
    expect(await fetchCard(clientAnswering(fail(429, "too_many_attempts")).client, "X")).toEqual({
      kind: "throttled",
    });
    expect(await fetchCard(clientAnswering(fail(500, "internal_error")).client, "X")).toEqual({
      kind: "network",
    });
    expect(await fetchCard(clientAnswering({ kind: "network" }).client, "X")).toEqual({
      kind: "network",
    });
  });
});

describe("joining", () => {
  const JOIN = { code: "ABC234", via: "public_list", cardVersion: "0.1" } as const;

  it("joins with the card the person saw, and reads a pending or repeated join", async () => {
    const { session, calls } = sessionAnswering({
      kind: "ok",
      status: 200,
      body: { enrollmentId: "n", eventId: "e1", status: "pending", alreadyMember: true },
      headers,
    });
    expect(await joinEvent(session, JOIN)).toEqual({
      kind: "joined",
      eventId: "e1",
      status: "pending",
      alreadyMember: true,
    });
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/v1/join",
      body: { joinCode: "ABC234", via: "public_list", cardVersion: "0.1" },
    });
    expect(
      await joinEvent(
        sessionAnswering({
          kind: "ok",
          status: 200,
          body: { eventId: "e1", status: "active" },
          headers,
        }).session,
        JOIN,
      ),
    ).toEqual({ kind: "joined", eventId: "e1", status: "active", alreadyMember: false });
    expect(
      await joinEvent(
        sessionAnswering({ kind: "ok", status: 200, body: {}, headers }).session,
        JOIN,
      ),
    ).toEqual({
      kind: "network",
    });
  });

  it("shows a changed card instead of joining on it", async () => {
    const NEW = { ...CARD, version: "0.2" };
    expect(
      await joinEvent(
        sessionAnswering(fail(422, "card_version_stale", { card: NEW })).session,
        JOIN,
      ),
    ).toEqual({
      kind: "stale",
      card: NEW,
    });
    expect(
      await joinEvent(
        sessionAnswering(fail(422, "card_version_stale", { card: { version: "0.2" } })).session,
        JOIN,
      ),
    ).toEqual({ kind: "refused", code: "card_version_stale", problem: MESSAGE });
  });

  it("passes refusals, a lost session and the network on", async () => {
    for (const code of [
      "event_ended",
      "join_method_off",
      "join_not_allowed",
      "not_found",
      "too_many_attempts",
    ]) {
      expect(await joinEvent(sessionAnswering(fail(403, code)).session, JOIN)).toEqual({
        kind: "refused",
        code,
        problem: MESSAGE,
      });
    }
    expect(await joinEvent(sessionAnswering({ kind: "signed_out" }).session, JOIN)).toEqual({
      kind: "signed_out",
    });
    expect(await joinEvent(sessionAnswering({ kind: "network" }).session, JOIN)).toEqual({
      kind: "network",
    });
  });
});

describe("routeForIncoming", () => {
  it("opens the join card for the join link, as a full URL or a path", () => {
    for (const incoming of [
      "https://questify.sa/ar/e/abc234",
      "https://questify.sa/en/e/ABC234/",
      "https://questify.sa/en/e/ABC234?utm_source=poster",
      "/ar/e/abc234",
      "/en/e/ABC234/",
      "/en/e/ABC234?utm=1",
    ]) {
      expect(routeForIncoming(incoming), incoming).toBe("/join/ABC234?via=link");
    }
  });

  it("opens Home for anything else, never reading a bare segment as a code", () => {
    for (const incoming of [
      "/ABC234",
      "ABC234",
      "/settings",
      "/fr/e/ABC234",
      "/ar/q/ABC234",
      "https://evil.test/ar/e/ABC234",
      "questify://e/ABC234",
      "",
    ]) {
      expect(routeForIncoming(incoming), incoming).toBe("/");
    }
  });
});
