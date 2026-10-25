import { createHash } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tooManyAttempts } from "#src/auth/http-errors";
import { HttpError } from "#src/http-error";
import { registerConsoleTicketRoutes } from "#src/tickets/console-routes";
import { inboxCursorOf, registerTicketRoutes, registerTicketTeamRoutes } from "#src/tickets/routes";
import type { SettingsService } from "#src/settings/service";
import { fakePool } from "#test/support/fake-pool";

// Keep parsing, response shaping, feature gating and safe logging real. Stub the business entry points so the
// database's second validation cannot conceal a missing HTTP boundary check.
const calls = vi.hoisted(() => ({
  openTicket: vi.fn(),
  openPlatformTicket: vi.fn(),
  ownTickets: vi.fn(),
  markTicketsSeen: vi.fn(),
  operatorInbox: vi.fn(),
  operatorAnswer: vi.fn(),
  staffAnswer: vi.fn(),
  consoleTickets: vi.fn(),
  consoleTicket: vi.fn(),
  adminAnswer: vi.fn(),
  adminReturn: vi.fn(),
  holdBack: vi.fn(),
  countRecent: vi.fn(),
  record: vi.fn(),
  forget: vi.fn(),
  forEvent: vi.fn(),
}));
vi.mock("#src/tickets/tickets", async (actual) => ({
  ...(await actual<typeof import("#src/tickets/tickets")>()),
  openTicket: calls.openTicket,
  openPlatformTicket: calls.openPlatformTicket,
  ownTickets: calls.ownTickets,
  markTicketsSeen: calls.markTicketsSeen,
  operatorInbox: calls.operatorInbox,
  operatorAnswer: calls.operatorAnswer,
  staffAnswer: calls.staffAnswer,
}));
vi.mock("#src/tickets/console", async (actual) => ({
  ...(await actual<typeof import("#src/tickets/console")>()),
  consoleTickets: calls.consoleTickets,
  consoleTicket: calls.consoleTicket,
  adminAnswer: calls.adminAnswer,
  adminReturn: calls.adminReturn,
}));
vi.mock("#src/devices/limits", async (actual) => ({
  ...(await actual<typeof import("#src/devices/limits")>()),
  holdBack: calls.holdBack,
}));
vi.mock("#src/auth/throttle", async (actual) => ({
  ...(await actual<typeof import("#src/auth/throttle")>()),
  countRecent: calls.countRecent,
  record: calls.record,
  forget: calls.forget,
}));

const EVENT = "11111111-1111-4111-8111-111111111111";
const ADMIN = "66666666-6666-4666-8666-666666666666";
const PLAYER = "22222222-2222-4222-8222-222222222222";
const KEY = "33333333-3333-4333-8333-333333333333";
const DEVICE = { appVersion: "1.4.0", platform: "ios", osVersion: "18.1", model: "iPhone 15 Pro" };
const answered = { ticketId: "7", outcome: "answered", replayed: false };
const counts = { open: 3, closed: 2, openDirect: 1, openEscalated: 2 };
const done = <T>(value: T) => ({ kind: "done", value });
const EVENT_PATH = `/v1/events/${EVENT}/tickets`;
const INBOX_PATH = `/v1/operator/events/${EVENT}/inbox`;

let app: FastifyInstance;
let lines: string[];
const { pool } = fakePool(() => ({ rows: [] }));
const deps = {
  pool,
  settings: { forEvent: calls.forEvent } as unknown as SettingsService,
  keys: {
    userKey: () => Buffer.alloc(32),
    playerKey: () => Buffer.alloc(32),
    playerQuestKey: () => Buffer.alloc(32),
  },
};
const post = (url: string, payload: object) =>
  app.inject({
    method: "POST",
    url,
    payload,
    headers: { "idempotency-key": KEY },
  });
const logged = (event: string) =>
  lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line["event"] === event);

beforeEach(async () => {
  vi.resetAllMocks();
  calls.forEvent.mockResolvedValue({
    kind: "ok",
    config: { features: { helpDesk: { enabled: true } } },
  });
  calls.openTicket.mockResolvedValue(
    done({ ticketId: "7", status: "open", createdAt: new Date(0), marked: false, replayed: false }),
  );
  calls.openPlatformTicket.mockImplementation(calls.openTicket);
  calls.ownTickets.mockResolvedValue([]);
  calls.operatorInbox.mockResolvedValue(
    done({ items: [], next: null, abilities: { helpDesk: true, review: false } }),
  );
  calls.operatorAnswer.mockResolvedValue(done(answered));
  calls.staffAnswer.mockResolvedValue(done(answered));
  calls.adminAnswer.mockResolvedValue(done(answered));
  calls.adminReturn.mockResolvedValue(done({ ticketId: "7", queue: "event", replayed: false }));
  calls.consoleTickets.mockResolvedValue(done({ tickets: [], counts }));
  calls.consoleTicket.mockResolvedValue(done({ id: "7" }));
  calls.countRecent.mockResolvedValue({ count: 0, retryAfterSeconds: 0 });
  calls.record.mockResolvedValue("2030-01-01T00:00:00Z");
  lines = [];
  app = Fastify({
    logger: { level: "debug", stream: { write: (line: string) => void lines.push(line) } },
  });
  app.addHook("onRequest", async (request) => {
    request.player = { id: PLAYER };
    request.staff = {
      account: { id: ADMIN, email: "support@test.sa", status: "active", platformRole: "admin" },
      sessionId: "session",
    };
    request.organizer = { id: "organizer", role: "owner", eventScope: null };
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) return reply.code(error.status).send(error.envelope);
    return reply.code(500).send({ code: "internal_error" });
  });
  registerTicketRoutes(app, deps);
  registerTicketTeamRoutes(app, deps);
  await app.register(async (scope) => registerConsoleTicketRoutes(scope, deps), {
    prefix: "/v1/admin",
  });
  await app.ready();
});
afterEach(async () => {
  await app.close();
});

describe("console ticket HTTP boundaries", () => {
  it("supplies defaults and forwards all filters with a full-page cursor", async () => {
    expect((await app.inject("/v1/admin/tickets")).json()).toEqual({
      tickets: [],
      counts,
      nextCursor: null,
    });
    expect(calls.consoleTickets).toHaveBeenLastCalledWith(deps, ADMIN, {
      status: "open",
      kind: null,
      source: null,
      cursor: null,
      limit: 50,
      requestId: expect.any(String),
    });
    calls.consoleTickets.mockResolvedValue(done({ tickets: [{ id: "7" }, { id: "9" }], counts }));
    const page = await app.inject(
      "/v1/admin/tickets?status=closed&kind=prize&source=escalated&cursor=4&limit=2",
    );
    expect(page.statusCode).toBe(200);
    expect(page.json()).toEqual({ tickets: [{ id: "7" }, { id: "9" }], counts, nextCursor: "9" });
    expect(calls.consoleTickets).toHaveBeenLastCalledWith(deps, ADMIN, {
      status: "closed",
      kind: "prize",
      source: "escalated",
      cursor: "4",
      limit: 2,
      requestId: expect.any(String),
    });
    calls.consoleTickets.mockResolvedValue(done({ tickets: [{ id: "10" }], counts }));
    expect((await app.inject("/v1/admin/tickets?source=direct&limit=2")).json()).toMatchObject({
      nextCursor: null,
    });
    expect(calls.consoleTickets).toHaveBeenLastCalledWith(
      deps,
      ADMIN,
      expect.objectContaining({ source: "direct" }),
    );
  });

  it.each([
    "status=",
    "source=",
    "cursor=x7",
    "cursor=7x",
    "limit=0",
    "limit=101",
    "limit=1.5",
    "extra=1",
  ])("rejects invalid list query %s before reading", async (query) => {
    expect((await app.inject(`/v1/admin/tickets?${query}`)).statusCode).toBe(400);
    expect(calls.consoleTickets).not.toHaveBeenCalled();
  });

  it.each(["x7", "7x", "0", "1234567890123456789"])(
    "rejects invalid ticket id %s before reading",
    async (id) => {
      expect((await app.inject(`/v1/admin/tickets/${id}`)).statusCode).toBe(400);
      expect(calls.consoleTicket).not.toHaveBeenCalled();
    },
  );

  it("accepts a 100-item page and bounded long replies and return notes", async () => {
    expect((await app.inject("/v1/admin/tickets?limit=100")).statusCode).toBe(200);
    expect(calls.consoleTickets).toHaveBeenLastCalledWith(
      deps,
      ADMIN,
      expect.objectContaining({ limit: 100 }),
    );
    const text = "x".repeat(1000);
    expect((await post("/v1/admin/tickets/7/answer", { reply: text })).statusCode).toBe(200);
    expect(calls.adminAnswer).toHaveBeenLastCalledWith(
      deps,
      ADMIN,
      expect.objectContaining({ reply: text }),
    );
    expect((await post("/v1/admin/tickets/7/return", { note: text })).statusCode).toBe(200);
    expect(calls.adminReturn).toHaveBeenLastCalledWith(
      deps,
      ADMIN,
      expect.objectContaining({ note: text }),
    );
    expect((await post("/v1/admin/tickets/7/answer", { reply: "x".repeat(4001) })).statusCode).toBe(
      400,
    );
    expect((await post("/v1/admin/tickets/7/return", { note: "x".repeat(4001) })).statusCode).toBe(
      400,
    );
  });

  it("logs throttling with a 16-character admin hash, and does not mislabel unexpected errors", async () => {
    calls.holdBack.mockRejectedValueOnce(tooManyAttempts({ retryAfterSeconds: 30 }));
    expect((await app.inject("/v1/admin/tickets")).statusCode).toBe(429);
    expect(logged("console.tickets_throttled")).toMatchObject([
      {
        adminIdHash: createHash("sha256").update(ADMIN).digest("hex").slice(0, 16),
      },
    ]);
    expect(calls.consoleTickets).not.toHaveBeenCalled();
    lines.length = 0;
    calls.holdBack.mockRejectedValueOnce(new Error("backend unavailable"));
    expect((await app.inject("/v1/admin/tickets")).statusCode).toBe(500);
    expect(logged("console.tickets_throttled")).toEqual([]);
  });
});

describe("player and team ticket HTTP boundaries", () => {
  it.each([
    { kind: "question", reportedUsername: "someone", text: "Hi" },
    { kind: "report_player", questId: EVENT, reportedUsername: "someone", text: "Hi" },
  ])("rejects a mismatched report field before sending: %o", async (payload) => {
    expect((await post(EVENT_PATH, payload)).statusCode).toBe(400);
    expect(calls.openTicket).not.toHaveBeenCalled();
  });

  it("refuses sending with the composed help desk off before any lookup or write", async () => {
    calls.forEvent.mockResolvedValueOnce({
      kind: "ok",
      config: { features: { helpDesk: { enabled: false } } },
    });
    const reportedUsername = "private_user_9f2c";
    const text = "Private report body 9f2c";
    const response = await post(EVENT_PATH, {
      kind: "report_player",
      reportedUsername,
      text,
    });
    expect([response.statusCode, response.json().code]).toEqual([403, "feature_off"]);
    expect(calls.forEvent).toHaveBeenCalledWith(EVENT, PLAYER);
    expect(calls.countRecent).not.toHaveBeenCalled();
    expect(calls.openTicket).not.toHaveBeenCalled();
    expect(logged("ticket.refused")).toMatchObject([{ reason: "feature_off" }]);
    for (const secret of [reportedUsername, text, PLAYER]) {
      expect(JSON.stringify(logged("ticket.refused"))).not.toContain(secret);
    }
  });

  it.each([
    { kind: "ok", config: { features: {} } },
    { kind: "ok", config: { features: { helpDesk: { enabled: true } } } },
    { kind: "event_not_found" },
  ])(
    "lets the database decide sending when the feature is not explicitly off: %o",
    async (config) => {
      calls.forEvent.mockResolvedValueOnce(config);
      expect((await post(EVENT_PATH, { kind: "question", text: "Hi" })).statusCode).toBe(201);
      expect(calls.openTicket).toHaveBeenCalled();
      expect(calls.countRecent).not.toHaveBeenCalled();
    },
  );

  it("returns the lookup wait in both the header and envelope and logs only its reason", async () => {
    calls.countRecent.mockResolvedValueOnce({ count: 10, retryAfterSeconds: 123 });
    const reportedUsername = "private_user_4a81";
    const text = "Private report body 4a81";
    const response = await post(EVENT_PATH, {
      kind: "report_player",
      reportedUsername,
      text,
    });
    expect([response.statusCode, response.headers["retry-after"]]).toEqual([429, "123"]);
    expect(response.json()).toMatchObject({
      code: "too_many_lookups",
      details: { retryAfterSeconds: 123 },
    });
    expect(logged("ticket.refused")).toMatchObject([{ reason: "too_many_lookups" }]);
    for (const secret of [reportedUsername, text, PLAYER]) {
      expect(JSON.stringify(logged("ticket.refused"))).not.toContain(secret);
    }
    expect(calls.openTicket).not.toHaveBeenCalled();
  });

  it("counts only open tickets and marks multiple event answers seen", async () => {
    calls.ownTickets.mockResolvedValueOnce([
      { id: "7", status: "open" },
      { id: "8", status: "closed" },
    ]);
    expect((await app.inject(`${EVENT_PATH}/mine`)).json()).toMatchObject({
      open: 1,
      limit: { open: 3 },
    });
    expect((await post(`${EVENT_PATH}/seen`, { ids: ["7", "8"] })).statusCode).toBe(204);
    expect(calls.markTicketsSeen).toHaveBeenCalledWith(deps, PLAYER, {
      eventId: EVENT,
      ids: ["7", "8"],
    });
  });

  it.each(["x7", "7x", "0"])(
    "rejects malformed seen id %s before changing unread state",
    async (id) => {
      expect((await post(`${EVENT_PATH}/seen`, { ids: [id] })).statusCode).toBe(400);
      expect(calls.markTicketsSeen).not.toHaveBeenCalled();
    },
  );

  it("keeps device facts only for app problems and accepts long device names and replies", async () => {
    const device = { ...DEVICE, model: "x".repeat(64) };
    expect(
      (await post("/v1/me/tickets", { kind: "app_problem", text: "Crash", device })).statusCode,
    ).toBe(201);
    expect(calls.openPlatformTicket).toHaveBeenLastCalledWith(
      deps,
      expect.objectContaining({ device }),
    );
    expect(
      (await post("/v1/me/tickets", { kind: "suggestion", text: "Idea", device })).statusCode,
    ).toBe(201);
    expect(calls.openPlatformTicket).toHaveBeenLastCalledWith(
      deps,
      expect.objectContaining({ device: null }),
    );
    expect(
      (
        await post("/v1/me/tickets", {
          kind: "app_problem",
          text: "Crash",
          device: { ...DEVICE, platform: "" },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await post(`/v1/operator/events/${EVENT}/tickets/7/answer`, { reply: "x".repeat(1000) }))
        .statusCode,
    ).toBe(200);
  });

  it("keeps inbox pagination opaque and rejects unknown or malformed query fields", async () => {
    const position = { position: "1798365600123456", kind: "submission", id: "7" } as const;
    calls.operatorInbox.mockResolvedValueOnce(
      done({ items: [{ id: "7" }], next: position, abilities: { review: true, helpDesk: true } }),
    );
    const first = await app.inject(`${INBOX_PATH}?limit=2`);
    expect(first.json()).toMatchObject({ nextCursor: inboxCursorOf(position) });
    expect(
      (await app.inject(`${INBOX_PATH}?limit=100&cursor=${first.json().nextCursor}`)).statusCode,
    ).toBe(200);
    expect(calls.operatorInbox).toHaveBeenLastCalledWith(deps, PLAYER, {
      eventId: EVENT,
      after: position,
      limit: 100,
    });
    for (const query of [
      "limit=0",
      "limit=101",
      "extra=1",
      "cursor=x",
      `cursor=${"x".repeat(201)}`,
    ]) {
      expect((await app.inject(`${INBOX_PATH}?${query}`)).statusCode).toBe(400);
    }
  });

  it.each(["x1", "1x"])(
    "rejects cursor timestamps with a nonnumeric affix: %s",
    async (position) => {
      const cursor = inboxCursorOf({ position, kind: "ticket", id: "7" });
      expect((await app.inject(`${INBOX_PATH}?cursor=${cursor}`)).statusCode).toBe(400);
      expect(calls.operatorInbox).not.toHaveBeenCalled();
    },
  );

  it("records the correct answerer role and send queue without personal text", async () => {
    await post(EVENT_PATH, { kind: "problem", text: "Secret", questId: EVENT });
    await post(EVENT_PATH, { kind: "question", text: "Secret" });
    await post("/v1/me/tickets", { kind: "suggestion", text: "Secret" });
    expect(logged("ticket.opened")).toMatchObject([
      { queue: "event", hasQuest: true },
      { queue: "event", hasQuest: false },
      { queue: "questify", hasQuest: false },
    ]);
    await post(`/v1/operator/events/${EVENT}/tickets/7/answer`, {});
    await post(`/events/${EVENT}/tickets/7/answer`, {});
    await post("/v1/admin/tickets/7/answer", {});
    expect(logged("ticket.answered")).toMatchObject([
      { via: "operator", outcome: "answered", replayed: false },
      { via: "staff", outcome: "answered", replayed: false },
      { via: "admin", outcome: "answered", replayed: false },
    ]);
    expect(
      JSON.stringify([...logged("ticket.opened"), ...logged("ticket.answered")]),
    ).not.toContain("Secret");
  });
});
