import { describe, expect, it } from "vitest";
import { ticketsOf } from "#src/event/help.ts";

const BASE = {
  id: "7",
  kind: "problem",
  quest: null,
  text: "No QR here",
  status: "open",
  outcome: null,
  reply: null,
  createdAt: "2030-01-01T09:00:00.000Z",
  unread: false,
};

const text = { ar: null, en: "Fest" };

/** One field's value, and whether a request carrying it reads (true) or the whole list fails (false). */
const FIELD_CASES: readonly (readonly [string, unknown, boolean])[] = [
  ["id", 7, false],
  ["id", undefined, false],
  ["kind", "question", true],
  ["kind", "report_player", true],
  ["kind", "nope", false],
  ["kind", undefined, false],
  ["quest", null, true],
  ["quest", undefined, true],
  ["quest", { id: "q", title: text }, true],
  ["quest", { id: "q", title: { ar: "ع", en: null } }, true],
  ["quest", { id: "q", title: { ar: "ع" } }, false],
  ["quest", { id: "q", title: { ar: 1, en: null } }, false],
  ["quest", { id: "q", title: { ar: null, en: 2 } }, false],
  ["quest", { id: "q", title: null }, false],
  ["quest", { id: 1, title: text }, false],
  ["quest", { id: "q", name: text }, false],
  ["quest", "q", false],
  ["event", null, true],
  ["event", undefined, true],
  ["event", { id: "e", name: text }, true],
  ["event", { id: "e", title: text }, false],
  ["event", { id: "e", name: "Fest" }, false],
  ["event", 5, false],
  ["text", "", true],
  ["text", 5, false],
  ["text", undefined, false],
  ["status", "open", true],
  ["status", "closed", true],
  ["status", "waiting", false],
  ["status", undefined, false],
  ["outcome", null, true],
  ["outcome", "answered", true],
  ["outcome", "solved", true],
  ["outcome", "done", false],
  ["outcome", undefined, false],
  ["reply", null, true],
  ["reply", "Thanks", true],
  ["reply", 5, false],
  ["reply", undefined, false],
  ["createdAt", "2030", true],
  ["createdAt", 5, false],
  ["createdAt", undefined, false],
  ["unread", true, true],
  ["unread", false, true],
  ["unread", "yes", false],
  ["unread", undefined, false],
  ["withQuestify", undefined, true],
  ["withQuestify", true, true],
  ["withQuestify", false, true],
  ["withQuestify", null, false],
  ["withQuestify", "yes", false],
  ["answeredBy", undefined, true],
  ["answeredBy", null, true],
  ["answeredBy", "event", true],
  ["answeredBy", "questify", true],
  ["answeredBy", "staff", false],
  ["reportedUsername", undefined, true],
  ["reportedUsername", null, true],
  ["reportedUsername", "khalid", true],
  ["reportedUsername", 5, false],
];

describe("what a request must look like to be read", () => {
  it.each(FIELD_CASES)("%s = %j reads: %s", (field, value, reads) => {
    const result = ticketsOf({ tickets: [{ ...BASE, [field]: value }] });
    expect(result !== undefined).toBe(reads);
  });

  it("fails the whole list when one request is malformed", () => {
    expect(ticketsOf({ tickets: [BASE, { ...BASE, kind: "nope" }] })).toBeUndefined();
    expect(ticketsOf({ tickets: [BASE, BASE] })).toHaveLength(2);
    expect(ticketsOf({ tickets: [] })).toEqual([]);
  });

  it("fails on a request that is not an object", () => {
    expect(ticketsOf({ tickets: [null] })).toBeUndefined();
    expect(ticketsOf({ tickets: ["7"] })).toBeUndefined();
    expect(ticketsOf({})).toBeUndefined();
    expect(ticketsOf("tickets")).toBeUndefined();
  });

  it("fills the optional fields with their defaults", () => {
    expect(ticketsOf({ tickets: [BASE] })).toEqual([
      {
        ...BASE,
        event: null,
        withQuestify: false,
        answeredBy: null,
        reportedUsername: null,
      },
    ]);
  });
});
