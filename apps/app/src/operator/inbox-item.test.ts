import { describe, expect, it } from "vitest";
import { inboxOf } from "#src/operator/inbox.ts";

const ITEM = {
  kind: "ticket",
  id: "4",
  createdAt: "2030-01-01T09:00:00.000Z",
  questTitle: null,
  username: "sara",
  avatar: "falcon",
  preview: "The QR is missing",
  marked: false,
  ticketKind: "problem",
};
const withItem = (fields: Record<string, unknown>) => ({
  items: [{ ...ITEM, ...fields }],
  nextCursor: null,
  abilities: { review: true, helpDesk: false },
});

describe("an Inbox row, field by field", () => {
  it("accepts both kinds, every ticket kind or none, and null or text where allowed", () => {
    expect(inboxOf(withItem({ kind: "submission", ticketKind: null }))).toBeDefined();
    for (const ticketKind of ["question", "problem", "prize", null]) {
      expect(inboxOf(withItem({ ticketKind })), String(ticketKind)).toBeDefined();
    }
    expect(inboxOf(withItem({ questTitle: { ar: null, en: "Q" } }))).toBeDefined();
    expect(inboxOf(withItem({ questTitle: { ar: "س", en: null } }))).toBeDefined();
    expect(inboxOf(withItem({ username: null, preview: null }))).toBeDefined();
  });

  it("refuses the list when any field of a row is missing or of another type", () => {
    for (const field of Object.keys(ITEM)) {
      if (["questTitle", "username", "preview", "ticketKind"].includes(field)) {
        continue;
      }
      expect(inboxOf(withItem({ [field]: undefined })), field).toBeUndefined();
    }
    expect(inboxOf(withItem({ id: 4 }))).toBeUndefined();
    expect(inboxOf(withItem({ createdAt: null }))).toBeUndefined();
    expect(inboxOf(withItem({ avatar: 1 }))).toBeUndefined();
    expect(inboxOf(withItem({ marked: "no" }))).toBeUndefined();
    expect(inboxOf(withItem({ questTitle: { ar: null } }))).toBeUndefined();
    expect(inboxOf(withItem({ questTitle: { ar: 1, en: null } }))).toBeUndefined();
    expect(inboxOf(withItem({ username: 7 }))).toBeUndefined();
    expect(inboxOf(withItem({ preview: false }))).toBeUndefined();
    expect(inboxOf(withItem({ ticketKind: undefined }))).toBeUndefined();
    expect(inboxOf(withItem({ ticketKind: "praise" }))).toBeUndefined();
    expect(inboxOf({ ...withItem({}), items: [null] })).toBeUndefined();
    expect(inboxOf({ ...withItem({}), items: [ITEM, "x"] })).toBeUndefined();
  });
});
