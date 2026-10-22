import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { Caller } from "#src/auth/sign-in";
import {
  acceptHandover,
  cancelAtDesk,
  declineHandover,
  deskViewOf,
  handOver,
  lookUp,
  myDeskItems,
  offerState,
  operatorDesk,
  startCollect,
} from "#src/desk/desk";
import { createMyCodeKey, myCode } from "#src/quests/qr";

const PLAYER = "11111111-1111-4111-8111-111111111111";
const OPERATOR = "22222222-2222-4222-8222-222222222222";
const EVENT = "33333333-3333-4333-8333-333333333333";
const AT = new Date("2030-01-01T10:00:00Z");
const LATER = new Date("2030-01-01T10:05:00Z");
const KEY = createMyCodeKey("q".repeat(40));

type Answer = (sql: string, values: unknown[]) => Record<string, unknown>[] | Error;

/** A pool whose connection answers each call through `answer`; the transaction statements answer nothing. */
function fakePool(answer: Answer) {
  const statements: { sql: string; values: unknown[] }[] = [];
  const client = {
    query: vi.fn(async (sql: string, values: unknown[] = []) => {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("set_config")) {
        return { rows: [] };
      }
      statements.push({ sql, values });
      const rows = answer(sql, values);
      if (rows instanceof Error) {
        throw rows;
      }
      return { rows };
    }),
    release: vi.fn(),
  };
  return {
    deps: { pool: { connect: async () => client } as unknown as Pool, myKey: KEY },
    statements,
  };
}

const pgError = (code: string | undefined, detail?: string) =>
  Object.assign(new Error("refused"), { code, ...(detail === undefined ? {} : { detail }) });

function caller() {
  const logged: unknown[][] = [];
  const value: Caller = {
    address: "127.0.0.1",
    userAgent: null,
    log: (event, fields) => logged.push([event, fields]),
  };
  return { value, logged };
}

const REQUEST = { operatorId: OPERATOR, redemptionId: "d1" };

describe("refusals (migration 0029's SQLSTATEs)", () => {
  it.each([
    ["RN404", undefined, { kind: "not_found" }],
    ["OP403", undefined, { kind: "not_operator" }],
    ["OA403", undefined, { kind: "ability_off" }],
    ["RE409", "handed_over", { kind: "reservation_ended", status: "handed_over" }],
    ["RE409", undefined, { kind: "reservation_ended", status: "" }],
    ["RA403", "banned", { kind: "enrollment_inactive", reason: "banned" }],
    ["OY409", undefined, { kind: "self_handover" }],
    ["RM409", undefined, { kind: "handover_mode" }],
    ["RS403", "desk_closed", { kind: "desk_closed" }],
    ["RO410", undefined, { kind: "offer_gone" }],
    ["RC409", undefined, { kind: "not_ready" }],
    ["OM422", undefined, { kind: "old_code" }],
    ["QC404", undefined, { kind: "not_in_event" }],
  ] as const)("answers %s (%s) as its refusal", async (code, detail, expected) => {
    const { deps } = fakePool(() => pgError(code, detail));
    expect(await offerState(deps, REQUEST)).toEqual(expected);
  });

  it("throws anything else, with or without a code", async () => {
    const unknown = pgError("XX000");
    await expect(offerState(fakePool(() => unknown).deps, REQUEST)).rejects.toBe(unknown);
    const plain = new Error("down");
    await expect(offerState(fakePool(() => plain).deps, REQUEST)).rejects.toBe(plain);
  });
});

describe("deskViewOf", () => {
  it("reads every part of the desk", () => {
    expect(
      deskViewOf({
        desk_location_ar: "القاعة ب",
        desk_location_en: 7,
        desk_lat: "24.5",
        desk_lng: "46.25",
        desk_opens: [AT],
        desk_closes: [LATER],
        desk_state: "closed",
        handover_confirm: "desk_offer",
        timezone: "Asia/Dubai",
      }),
    ).toEqual({
      location: { ar: "القاعة ب", en: null },
      pin: { lat: 24.5, lng: 46.25 },
      hours: [{ opensAt: AT.toISOString(), closesAt: LATER.toISOString() }],
      state: "closed",
      confirm: "desk_offer",
      timeZone: "Asia/Dubai",
    });
  });

  it("answers no place, no pin and no hours when none is set", () => {
    expect(deskViewOf({ desk_location_ar: null, desk_location_en: null })).toMatchObject({
      location: null,
      pin: null,
      hours: null,
    });
    expect(deskViewOf({ desk_location_en: "Hall B" }).location).toEqual({ ar: null, en: "Hall B" });
  });

  it("is what the desk's header answers", async () => {
    const { deps, statements } = fakePool(() => [{ desk_state: "open", timezone: "UTC" }]);
    expect(await operatorDesk(deps, OPERATOR, EVENT)).toMatchObject({
      kind: "done",
      value: { state: "open", timeZone: "UTC" },
    });
    expect(statements).toEqual([{ sql: "SELECT * FROM operator_desk($1)", values: [EVENT] }]);
  });
});

describe("lookUp (FR-925)", () => {
  const code = myCode(KEY, PLAYER, 3);

  it("refuses a code that is not a My QR before the database, and logs why", async () => {
    const { deps, statements } = fakePool(() => []);
    const { value, logged } = caller();
    expect(
      await lookUp(deps, { operatorId: OPERATOR, eventId: EVENT, code: "nonsense" }, value),
    ).toEqual({
      kind: "done",
      value: { kind: "invalid_code" },
    });
    expect(statements).toEqual([]);
    expect(logged).toEqual([
      ["desk.lookup_refused", { reason: "invalid_code", problem: "not_questify" }],
    ]);
  });

  it("sends the code's player and version, and reads the player and their items", async () => {
    const { deps, statements } = fakePool(() => [
      {
        username: "sara_88",
        avatar: "fox",
        enrollment_status: "banned",
        redemption_id: "d1",
        kind: "experience",
        name_ar: "صالة",
        name_en: null,
        reserved_at: AT,
        reserved_until: LATER,
        ready: true,
        offered: "yes",
        offer_until: null,
      },
      {
        username: "sara_88",
        avatar: "fox",
        enrollment_status: "banned",
        redemption_id: "d2",
        kind: "item",
        name_ar: null,
        name_en: "Hoodie",
        reserved_at: null,
        reserved_until: "soon",
        ready: false,
        offered: true,
        offer_until: LATER,
      },
    ]);
    const result = await lookUp(
      deps,
      { operatorId: OPERATOR, eventId: EVENT, code },
      caller().value,
    );
    expect(statements).toEqual([
      { sql: "SELECT * FROM desk_lookup($1, $2, $3)", values: [EVENT, PLAYER, 3] },
    ]);
    expect(result).toEqual({
      kind: "done",
      value: {
        kind: "found",
        player: { username: "sara_88", avatar: "fox" },
        enrollment: "banned",
        items: [
          {
            id: "d1",
            kind: "experience",
            name: { ar: "صالة", en: null },
            reservedAt: AT.toISOString(),
            reservedUntil: LATER.toISOString(),
            ready: true,
            offered: false,
            offerUntil: null,
          },
          {
            id: "d2",
            kind: "item",
            name: { ar: null, en: "Hoodie" },
            reservedAt: null,
            reservedUntil: null,
            ready: false,
            offered: true,
            offerUntil: LATER.toISOString(),
          },
        ],
      },
    });
  });

  it("answers no items when the one row has none", async () => {
    const { deps } = fakePool(() => [
      { username: "a", avatar: "b", enrollment_status: "active", redemption_id: null },
    ]);
    expect(
      await lookUp(deps, { operatorId: OPERATOR, eventId: EVENT, code }, caller().value),
    ).toMatchObject({
      value: { kind: "found", enrollment: "active", items: [] },
    });
  });
});

describe("handOver and cancelAtDesk", () => {
  it("answers a handover or an offer and logs it by id", async () => {
    const handed = fakePool(() => [{ status: "handed_over", offer_until: null, replayed: true }]);
    const { value, logged } = caller();
    expect(await handOver(handed.deps, REQUEST, value)).toEqual({
      kind: "done",
      value: { status: "handed_over", offerUntil: null, replayed: true },
    });
    expect(handed.statements).toEqual([
      { sql: "SELECT * FROM desk_hand_over($1)", values: ["d1"] },
    ]);
    const offered = fakePool(() => [{ status: "offered", offer_until: LATER, replayed: "no" }]);
    expect(await handOver(offered.deps, REQUEST, value)).toEqual({
      kind: "done",
      value: { status: "offered", offerUntil: LATER.toISOString(), replayed: false },
    });
    expect(logged).toEqual([
      ["desk.hand_over", { redemptionId: "d1", status: "handed_over", replayed: "true" }],
      ["desk.hand_over", { redemptionId: "d1", status: "offered", replayed: "false" }],
    ]);
  });

  it("logs nothing for a refused handover or cancel", async () => {
    const { value, logged } = caller();
    expect(await handOver(fakePool(() => pgError("RC409")).deps, REQUEST, value)).toEqual({
      kind: "not_ready",
    });
    expect(await cancelAtDesk(fakePool(() => pgError("OY409")).deps, REQUEST, value)).toEqual({
      kind: "self_handover",
    });
    expect(logged).toEqual([]);
  });

  it("cancels and logs it by id", async () => {
    const { deps, statements } = fakePool(() => [
      { redemption_id: "d1", status: "cancelled", replayed: true },
    ]);
    const { value, logged } = caller();
    expect(await cancelAtDesk(deps, REQUEST, value)).toEqual({
      kind: "done",
      value: { id: "d1", status: "cancelled", replayed: true },
    });
    expect(statements).toEqual([
      { sql: "SELECT * FROM operator_cancel_redemption($1)", values: ["d1"] },
    ]);
    expect(logged).toEqual([["desk.cancel", { redemptionId: "d1", replayed: "true" }]]);
    const again = fakePool(() => [{ redemption_id: "d1", status: "cancelled", replayed: 1 }]);
    expect(await cancelAtDesk(again.deps, REQUEST, caller().value)).toMatchObject({
      value: { replayed: false },
    });
  });
});

describe("the poll and the player's calls", () => {
  it("reads the desk's poll", async () => {
    const { deps, statements } = fakePool(() => [
      { status: "reserved", offered: true, offer_until: LATER },
    ]);
    expect(await offerState(deps, REQUEST)).toEqual({
      kind: "done",
      value: { status: "reserved", offered: true, offerUntil: LATER.toISOString() },
    });
    expect(statements).toEqual([{ sql: "SELECT * FROM desk_redemption($1)", values: ["d1"] }]);
    const quiet = fakePool(() => [{ status: "reserved", offered: "true", offer_until: null }]);
    expect(await offerState(quiet.deps, REQUEST)).toMatchObject({
      value: { offered: false, offerUntil: null },
    });
  });

  it("collects, accepts and declines the player's own reservation", async () => {
    const mine = { playerId: PLAYER, redemptionId: "d1" };
    const collect = fakePool(() => [{ until: LATER }]);
    expect(await startCollect(collect.deps, mine)).toEqual({
      kind: "done",
      value: { collectUntil: LATER.toISOString() },
    });
    expect(collect.statements).toEqual([
      { sql: "SELECT start_collect($1) AS until", values: ["d1"] },
    ]);
    const accept = fakePool(() => [{ replayed: true }]);
    expect(await acceptHandover(accept.deps, mine)).toEqual({
      kind: "done",
      value: { status: "handed_over", replayed: true },
    });
    expect(accept.statements).toEqual([
      { sql: "SELECT replayed FROM accept_handover($1)", values: ["d1"] },
    ]);
    expect(await acceptHandover(fakePool(() => []).deps, mine)).toMatchObject({
      value: { replayed: false },
    });
    const decline = fakePool(() => [{ declined: true }]);
    expect(await declineHandover(decline.deps, mine)).toEqual({
      kind: "done",
      value: { declined: true },
    });
    expect(decline.statements).toEqual([
      { sql: "SELECT decline_handover($1) AS declined", values: ["d1"] },
    ]);
    expect(await declineHandover(fakePool(() => []).deps, mine)).toMatchObject({
      value: { declined: false },
    });
    expect(await startCollect(fakePool(() => []).deps, mine)).toMatchObject({
      value: { collectUntil: null },
    });
  });

  it("reads My QR's items and whether to keep asking", async () => {
    const { deps, statements } = fakePool((sql) =>
      sql.includes("my_desk_watch")
        ? [{ watch: true }]
        : [
            {
              redemption_id: "d1",
              event_id: EVENT,
              event_name_ar: "مهرجان",
              event_name_en: null,
              kind: "item",
              name_ar: null,
              name_en: "Hoodie",
              state: "offered",
              until: LATER,
            },
          ],
    );
    expect(await myDeskItems(deps, PLAYER)).toEqual({
      items: [
        {
          id: "d1",
          eventId: EVENT,
          event: { ar: "مهرجان", en: null },
          kind: "item",
          name: { ar: null, en: "Hoodie" },
          state: "offered",
          until: LATER.toISOString(),
        },
      ],
      watch: true,
    });
    expect(statements.map((s) => s.sql)).toEqual([
      "SELECT * FROM my_desk_items()",
      "SELECT my_desk_watch() AS watch",
    ]);
    const none = fakePool((sql) => (sql.includes("my_desk_watch") ? [{ watch: "yes" }] : []));
    expect(await myDeskItems(none.deps, PLAYER)).toEqual({ items: [], watch: false });
  });

  it("throws when My QR's reads are refused, which they never should be", async () => {
    await expect(myDeskItems(fakePool(() => pgError("RN404")).deps, PLAYER)).rejects.toThrow(
      "my_desk_items refused: not_found",
    );
  });
});
