import { describe, expect, it } from "vitest";
import {
  camel,
  codeLabel,
  ledgerPath,
  readLedger,
  readEraseAnswer,
  readPending,
  readRecord,
  readResetAnswer,
  readSearch,
} from "#src/lib/console-players.ts";
import { translatorFor } from "#src/lib/language.ts";

const ID = "00000000-0000-4000-8000-000000000001";
const EVENT = "00000000-0000-4000-8000-000000000002";

describe("console player paths and readers", () => {
  it("builds the points-record path with only the filters given", () => {
    expect(ledgerPath(ID, { eventId: null, before: null })).toBe(`/v1/admin/players/${ID}/ledger`);
    expect(ledgerPath(ID, { eventId: EVENT, before: 120 })).toBe(
      `/v1/admin/players/${ID}/ledger?eventId=${EVENT}&before=120`,
    );
  });

  it("reads a search answer and refuses any other shape", () => {
    const row = {
      id: ID,
      username: "layla",
      avatar: "falcon",
      status: "active",
      createdAt: "2026-11-02T10:00:00Z",
      contacts: { phone: "+9665•••••71", email: null },
    };
    expect(readSearch({ players: [row] })).toEqual([row]);
    expect(readSearch({ players: [{ ...row, contacts: { phone: "+966512345671" } }] })).toBe(
      undefined,
    );
    expect(readSearch([row])).toBeUndefined();
  });

  it("reads an erased account as its id and dates only", () => {
    const erased = {
      player: { id: ID, status: "deleted", createdAt: "2026-01-01T00:00:00Z", deletedAt: null },
      legalRequests: [
        {
          at: "2026-11-03T10:00:00Z",
          action: "player.delete",
          source: "admin",
          reasonCode: "legal_request",
          reference: "LEGAL-1",
          by: "legal@questify.test",
        },
      ],
    };
    expect(readRecord(erased)).toEqual(erased);
    expect(readRecord({ player: { ...erased.player, status: "active" } })).toBeUndefined();
  });

  it("reads the pending handovers and the erase answer of a legal request (T-708)", () => {
    const item = {
      redemptionId: ID,
      eventId: EVENT,
      event: { ar: "مهرجان", en: "Fest" },
      item: { ar: null, en: "Mug" },
      rankPrize: false,
    };
    expect(readPending({ pending: [item] })).toEqual([item]);
    expect(readPending({ pending: [{ ...item, eventId: "x" }] })).toBeUndefined();
    expect(readEraseAnswer({ outcome: "erased", events: [EVENT] })).toEqual({
      outcome: "erased",
      events: [EVENT],
    });
    expect(readEraseAnswer({ outcome: "handover_pending", events: [] })).toBeUndefined();
  });

  it("reads a ledger page and a reset answer", () => {
    expect(readLedger({ entries: [], nextCursor: null })).toEqual({
      entries: [],
      nextCursor: null,
    });
    expect(readLedger({ entries: [] })).toBeUndefined();
    expect(readResetAnswer({ actionId: ID, endedSignIns: 2 })).toBe(2);
    expect(readResetAnswer({ endedSignIns: -1 })).toBeUndefined();
  });

  it("labels a known code in both languages and shows an unknown code as it is", () => {
    expect(camel("far_from_venue")).toBe("farFromVenue");
    expect(codeLabel(translatorFor("en"), "console.player.reason", "support_request")).toBe(
      "Support request",
    );
    expect(codeLabel(translatorFor("ar"), "console.player.reason", "support_request")).toBe(
      "طلب دعم",
    );
    expect(codeLabel(translatorFor("en"), "console.player.kind", "brand_new_kind")).toBe(
      "brand_new_kind",
    );
  });
});
