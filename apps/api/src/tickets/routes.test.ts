import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { HttpError } from "#src/http-error";
import { inboxCursorOf, inboxPositionOf, refuse } from "#src/tickets/routes";
import type { TicketRefusal } from "#src/tickets/tickets";

const answerOf = (refusal: TicketRefusal) => {
  const logged: Record<string, unknown>[] = [];
  const headers: Record<string, string> = {};
  const request = { log: { info: (fields: Record<string, unknown>) => logged.push(fields) } };
  const reply = {
    header: (name: string, value: string) => {
      headers[name] = value;
    },
  };
  try {
    refuse(request as unknown as FastifyRequest, reply as unknown as FastifyReply, refusal);
  } catch (error) {
    if (error instanceof HttpError) {
      expect(logged).toEqual([{ event: "ticket.refused", reason: refusal.kind }]);
      return [error.status, error.envelope.code, error.envelope.details, headers];
    }
    throw error;
  }
  throw new Error("refuse returned");
};

describe("refuse (API.md, Help desk)", () => {
  it.each([
    [{ kind: "not_found" }, [404, "not_found", {}, {}]],
    [{ kind: "not_member" }, [403, "not_member", {}, {}]],
    [{ kind: "feature_off" }, [403, "feature_off", {}, {}]],
    [{ kind: "sending_closed" }, [403, "sending_closed", {}, {}]],
    [{ kind: "unknown_quest" }, [404, "unknown_quest", {}, {}]],
    [{ kind: "invalid_kind" }, [400, "invalid_request", {}, {}]],
    [{ kind: "invalid_text", problem: "empty" }, [422, "invalid_text", { problem: "empty" }, {}]],
    [{ kind: "too_many_open" }, [409, "too_many_open", { limit: 3 }, {}]],
    [
      { kind: "too_many_tickets", retryAfterSeconds: 90 },
      [429, "too_many_tickets", {}, { "retry-after": "90" }],
    ],
    [{ kind: "key_reused" }, [422, "idempotency_key_reused", {}, {}]],
    [{ kind: "already_closed" }, [409, "already_closed", {}, {}]],
    [{ kind: "event_closed" }, [409, "event_closed", {}, {}]],
    [{ kind: "self_answer" }, [403, "self_answer", {}, {}]],
    [{ kind: "outside_quests" }, [403, "outside_quests", {}, {}]],
    [{ kind: "not_operator" }, [403, "not_operator", {}, {}]],
    [{ kind: "ability_off" }, [403, "ability_off", {}, {}]],
  ] as const)("answers %o", (refusal, expected) => {
    expect(answerOf(refusal as TicketRefusal)).toEqual(expected);
  });
});

const encoded = (text: string) => Buffer.from(text).toString("base64url");

describe("the inbox cursor", () => {
  it("round-trips a position with the database's full precision", () => {
    const position = { position: "1798365600123456", kind: "ticket", id: "42" } as const;
    expect(inboxPositionOf(inboxCursorOf(position))).toEqual(position);
    expect(inboxPositionOf(undefined)).toBeNull();
  });

  it.each([
    "not base64!",
    encoded("[1,2]"),
    encoded(JSON.stringify({ p: "1", k: "flag", i: "1" })),
    encoded(JSON.stringify({ p: "x", k: "ticket", i: "1" })),
    encoded(JSON.stringify({ p: "1", k: "ticket", i: "0" })),
    encoded(JSON.stringify({ p: "1", k: "ticket", i: "1", x: 1 })),
  ])("refuses a cursor it did not make: %s", (cursor) => {
    expect(() => inboxPositionOf(cursor)).toThrow(HttpError);
  });
});
