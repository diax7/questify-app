import { describe, expect, it } from "vitest";
import { ticketOf } from "#src/operator/inbox.ts";

// The check as it was before the split, copied unchanged.
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const nullableText = (value: unknown) => value === null || typeof value === "string";
const isTitle = (value: unknown) =>
  value === null || (isRecord(value) && nullableText(value["ar"]) && nullableText(value["en"]));
function oldTicketOf(body: unknown): unknown {
  const ticket = isRecord(body) ? body["ticket"] : undefined;
  if (
    !isRecord(ticket) ||
    typeof ticket["id"] !== "string" ||
    (ticket["kind"] !== "question" && ticket["kind"] !== "problem" && ticket["kind"] !== "prize") ||
    !(
      ticket["quest"] === null ||
      (isRecord(ticket["quest"]) && isTitle(ticket["quest"]["title"]))
    ) ||
    !nullableText(ticket["username"]) ||
    typeof ticket["avatar"] !== "string" ||
    typeof ticket["text"] !== "string" ||
    typeof ticket["marked"] !== "boolean" ||
    (ticket["status"] !== "open" && ticket["status"] !== "closed") ||
    !nullableText(ticket["reply"]) ||
    typeof ticket["createdAt"] !== "string"
  ) {
    return undefined;
  }
  return ticket;
}

/** Each field's candidate values: valid ones and the near misses that matter. */
const DOMAINS: Readonly<Record<string, readonly unknown[]>> = {
  id: ["t1", 5],
  kind: ["question", "problem", "prize", "praise", null],
  quest: [
    null,
    { id: "q", title: { ar: "أ", en: "A" } },
    { id: "q", title: { ar: null, en: null } },
    { id: "q", title: null },
    { id: "q", title: { ar: 1, en: "A" } },
    { id: "q" },
    "q",
    undefined,
  ],
  username: [null, "sara", 5, undefined],
  avatar: ["fox", 1],
  text: ["help", null],
  marked: [true, false, "yes"],
  status: ["open", "closed", "waiting"],
  reply: [null, "done", 2, undefined],
  createdAt: ["2026-11-01T10:00:00Z", 1],
};

function* tickets(
  fields: readonly string[],
  chosen: Record<string, unknown> = {},
): Generator<object> {
  const [field, ...rest] = fields;
  if (field === undefined) {
    yield { outcome: "answered", ...chosen };
    return;
  }
  for (const value of DOMAINS[field] ?? []) {
    yield* tickets(rest, { ...chosen, [field]: value });
  }
}

describe("ticketOf", () => {
  it("answers as the inline check did, for every combination of field values", () => {
    let count = 0;
    let valid = 0;
    for (const ticket of tickets(Object.keys(DOMAINS))) {
      const body = { ticket };
      const now = ticketOf(body);
      expect(now).toBe(oldTicketOf(body));
      count += 1;
      valid += now === undefined ? 0 : 1;
    }
    expect(count).toBe(2 * 5 * 8 * 4 * 2 * 2 * 3 * 3 * 4 * 2);
    expect(valid).toBeGreaterThan(0);
  });

  it("does not check the outcome, and reads a missing field as a refusal", () => {
    const base = {
      id: "t1",
      kind: "prize",
      quest: null,
      username: null,
      avatar: "fox",
      text: "x",
      marked: false,
      status: "open",
      reply: null,
      createdAt: "d",
    };
    for (const outcome of [undefined, null, "answered", 7]) {
      const body = { ticket: { ...base, outcome } };
      expect(ticketOf(body)).toBe(oldTicketOf(body));
      expect(ticketOf(body)).toBeDefined();
    }
    for (const field of Object.keys(base)) {
      const { [field]: _dropped, ...rest } = base as Record<string, unknown>;
      expect(ticketOf({ ticket: rest })).toBe(oldTicketOf({ ticket: rest }));
    }
  });

  it("refuses a body that is not a record with a ticket", () => {
    for (const body of [
      undefined,
      null,
      "t",
      3,
      [],
      {},
      { ticket: null },
      { ticket: "t" },
      { ticket: [] },
    ]) {
      expect(ticketOf(body)).toBe(oldTicketOf(body));
      expect(ticketOf(body)).toBeUndefined();
    }
  });
});
