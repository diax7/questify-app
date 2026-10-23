import { describe, expect, it } from "vitest";
import type { ApiRequest, ApiResult, Client } from "#src/api/client.ts";
import type { AuthedResult } from "#src/api/session.ts";
import { routeForIncoming } from "#src/join/deep-link.ts";
import {
  fetchCard,
  fetchInvitations,
  joinEvent,
  joinInvitation,
  readCard,
} from "#src/join/join-api.ts";

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
const NO_RULES = { fields: [], guestListOnly: false, emailDomains: [], welcomePoints: null };
const RULES = {
  fields: [
    { id: "f1", kind: "company", label: { ar: null, en: null }, required: true, options: null },
    {
      id: "f2",
      kind: "custom",
      label: { ar: "اللون", en: null },
      required: false,
      options: [
        { id: "red", ar: "أحمر", en: "Red" },
        { id: "blue", ar: null, en: "Blue" },
      ],
    },
  ],
  guestListOnly: true,
  emailDomains: ["acme.sa"],
  welcomePoints: 50,
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
    // An API from before T-212 sends no join rules: the card asks nothing and locks nothing.
    expect(await fetchCard(client, "abc 234")).toEqual({
      kind: "card",
      event: { ...EVENT, join: NO_RULES },
      card: CARD,
    });
    expect(calls[0]?.path).toBe("/v1/public/events/abc%20234");
    for (const body of [
      { event: EVENT },
      { event: { ...EVENT, statusNow: "draft" }, card: CARD },
      { event: { ...EVENT, access: "secret" }, card: CARD },
      { event: { ...EVENT, id: 1 }, card: CARD },
      { event: { ...EVENT, name: "Fest" }, card: CARD },
      { event: EVENT, card: { ...CARD, version: 1 } },
      { event: EVENT, card: { ...CARD, receives: [{ en: "x" }] } },
      {
        event: { ...EVENT, join: { ...RULES, fields: [{ id: "f", kind: "company" }] } },
        card: CARD,
      },
      {
        event: {
          ...EVENT,
          join: { ...RULES, fields: [{ ...RULES.fields[0], options: [{ ar: "x" }] }] },
        },
        card: CARD,
      },
      {
        event: { ...EVENT, join: { ...RULES, fields: [{ ...RULES.fields[0], options: "red" }] } },
        card: CARD,
      },
      { event: { ...EVENT, join: { ...RULES, guestListOnly: "yes" } }, card: CARD },
      { event: { ...EVENT, join: { ...RULES, emailDomains: [1] } }, card: CARD },
      { event: { ...EVENT, join: { ...RULES, welcomePoints: "5" } }, card: CARD },
      { event: { ...EVENT, join: null }, card: CARD },
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

  it("reads the event's join rules, keeping a field of a kind this build does not know", () => {
    expect(readCard({ event: { ...EVENT, join: RULES }, card: CARD })?.event.join).toEqual(RULES);
    // An API from before T-220 sends no options, and an option may leave a language out: both read as null.
    const older = {
      ...RULES,
      fields: [
        { id: "f1", kind: "badge_color", label: { ar: null, en: null }, required: true },
        {
          ...RULES.fields[1],
          options: [
            { id: "red", en: "Red" },
            { id: "blue", ar: "أزرق" },
          ],
        },
      ],
    };
    expect(readCard({ event: { ...EVENT, join: older }, card: CARD })?.event.join.fields).toEqual([
      {
        id: "f1",
        kind: "badge_color",
        label: { ar: null, en: null },
        required: true,
        options: null,
      },
      {
        ...RULES.fields[1],
        options: [
          { id: "red", ar: null, en: "Red" },
          { id: "blue", ar: "أزرق", en: null },
        ],
      },
    ]);
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
  const JOIN_BODY = { joinCode: "ABC234", via: "public_list", cardVersion: "0.1" };

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
      welcome: 0,
      waitlisted: false,
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
          body: { eventId: "e1", status: "active", welcome: 40 },
          headers,
        }).session,
        JOIN,
      ),
    ).toEqual({
      kind: "joined",
      eventId: "e1",
      status: "active",
      alreadyMember: false,
      welcome: 40,
      waitlisted: false,
    });
    for (const welcome of [-5, 0, "40", null]) {
      const read = await joinEvent(
        sessionAnswering({ kind: "ok", status: 200, body: { eventId: "e1", welcome }, headers })
          .session,
        JOIN,
      );
      expect(read, String(welcome)).toMatchObject({ kind: "joined", welcome: 0 });
    }
    expect(
      await joinEvent(
        sessionAnswering({ kind: "ok", status: 200, body: {}, headers }).session,
        JOIN,
      ),
    ).toEqual({
      kind: "network",
    });
  });

  it("joins the waiting list when asked, and reads the flag only on a pending join", async () => {
    const { session, calls } = sessionAnswering({
      kind: "ok",
      status: 200,
      body: { eventId: "e1", status: "pending", waitlisted: true },
      headers,
    });
    expect(await joinEvent(session, JOIN, true)).toMatchObject({
      kind: "joined",
      status: "pending",
      waitlisted: true,
    });
    expect(calls[0]?.body).toEqual({ ...JOIN_BODY, waitlist: true });
    expect(
      await joinEvent(
        sessionAnswering({
          kind: "ok",
          status: 200,
          body: { eventId: "e1", status: "active", waitlisted: true },
          headers,
        }).session,
        JOIN,
      ),
    ).toMatchObject({ status: "active", waitlisted: false });
    const invited = sessionAnswering(fail(409, "event_full", { waitlist: true }));
    expect(
      await joinInvitation(invited.session, { eventId: "e9", cardVersion: "0.1" }, true),
    ).toEqual({ kind: "refused", code: "event_full", problem: MESSAGE });
    expect(invited.calls[0]?.body).toEqual({
      eventId: "e9",
      via: "invite",
      cardVersion: "0.1",
      waitlist: true,
    });
  });

  it("sends the answers only when there are some, and points at the field the API names", async () => {
    const { session, calls } = sessionAnswering(fail(422, "invalid_join_answers", { field: "f1" }));
    expect(await joinEvent(session, { ...JOIN, answers: { f1: "Acme" } })).toEqual({
      kind: "invalid_answers",
      field: "f1",
      problem: MESSAGE,
    });
    expect(calls[0]?.body).toEqual({ ...JOIN_BODY, answers: { f1: "Acme" } });
    await joinEvent(session, { ...JOIN, answers: {} });
    expect(calls[1]?.body).toEqual(JOIN_BODY);
    expect(
      await joinEvent(sessionAnswering(fail(422, "invalid_join_answers")).session, JOIN),
    ).toEqual({ kind: "invalid_answers", field: null, problem: MESSAGE });
  });

  it("joins an invitation by its event, without a code", async () => {
    const { session, calls } = sessionAnswering({
      kind: "ok",
      status: 200,
      body: { eventId: "e9", status: "active", welcome: 10 },
      headers,
    });
    expect(
      await joinInvitation(session, { eventId: "e9", cardVersion: "0.2", answers: { f1: "A" } }),
    ).toMatchObject({ kind: "joined", eventId: "e9", welcome: 10 });
    expect(calls[0]).toEqual({
      method: "POST",
      path: "/v1/join",
      body: { eventId: "e9", via: "invite", cardVersion: "0.2", answers: { f1: "A" } },
    });
  });

  it("reads the invitations, and fails the list on one of another shape", async () => {
    const { joinCode: _code, ...invited } = EVENT;
    const ok = (body: unknown) => sessionAnswering({ kind: "ok", status: 200, body, headers });
    expect(
      await fetchInvitations(
        ok({ invitations: [{ event: { ...invited, join: RULES }, card: CARD }] }).session,
      ),
    ).toEqual({
      kind: "list",
      invitations: [{ event: { ...invited, join: RULES }, card: CARD }],
    });
    for (const body of [
      { invitations: [{ event: invited }] },
      { invitations: [{ event: { ...invited, id: 3 }, card: CARD }] },
      { invitations: ["x"] },
      { invitations: "none" },
      null,
    ]) {
      expect(await fetchInvitations(ok(body).session), JSON.stringify(body)).toEqual({
        kind: "network",
      });
    }
    expect(await fetchInvitations(sessionAnswering({ kind: "signed_out" }).session)).toEqual({
      kind: "signed_out",
    });
    expect(await fetchInvitations(sessionAnswering(fail(500, "internal_error")).session)).toEqual({
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
      "event_full",
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

  it("opens an operator invite's confirm screen from the app link or the invite address", () => {
    const token = "A".repeat(49) + "Q";
    for (const incoming of [
      `questify://operator-invite/${token}`,
      `/operator-invite/${token}`,
      `operator-invite/${token}`,
      `https://questify.nafes.com/ar/op#${token}`,
    ]) {
      expect(routeForIncoming(incoming), incoming).toBe(`/operator-invite/${token}`);
    }
    expect(routeForIncoming("/operator-invite/short")).toBe("/");
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
