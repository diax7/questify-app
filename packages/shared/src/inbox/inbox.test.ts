import { describe, expect, it } from "vitest";
import { inboxSchema } from "./inbox";

const valid = {
  tickets: { question: 1, problem: 2, prize: 3, report_player: 4 },
  withQuestify: 5,
  joinRequests: { pending: 6, private: true },
  submissions: 7,
  flags: 8,
};

describe("the inbox answer", () => {
  it("accepts counts for every kind", () => {
    expect(inboxSchema.parse(valid)).toEqual(valid);
  });

  it("refuses anything but counts: a missing kind, a negative or fractional count, an extra field", () => {
    const { question: _question, ...three } = valid.tickets;
    expect(inboxSchema.safeParse({ ...valid, tickets: three }).success).toBe(false);
    expect(inboxSchema.safeParse({ ...valid, flags: -1 }).success).toBe(false);
    expect(inboxSchema.safeParse({ ...valid, submissions: 1.5 }).success).toBe(false);
    expect(inboxSchema.safeParse({ ...valid, player: "someone" }).success).toBe(false);
    expect(
      inboxSchema.safeParse({ ...valid, tickets: { ...valid.tickets, app_problem: 1 } }).success,
    ).toBe(false);
  });
});
