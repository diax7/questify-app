import type { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import { erasedIdsFrom, reapplyErasures } from "#src/privacy/reapply";

const A = "11111111-2222-4333-8444-555555555555";
const B = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE";
const C = "CCCCCCCC-2222-4333-8444-555555555555";
const D = "dddddddd-2222-4333-8444-555555555555";
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("the ids to erase again after a restore", () => {
  it("reads player.deleted log lines and plain ids, once each", () => {
    const text = [
      JSON.stringify({ level: 30, event: "player.deleted", player: A, addr: "abc" }),
      `  ${B}  `,
      A,
      JSON.stringify({ event: "player.signed_in", player: "99999999-2222-4333-8444-555555555555" }),
      '{"event": "player.deleted", "player": "not-an-id"}',
      "{truncated",
      "",
      "plain words",
    ].join("\r\n");
    expect(erasedIdsFrom(text)).toEqual([A, B.toLowerCase()]);
  });

  it("splits plain newlines, lower-cases a logged id and skips ids inside other text", () => {
    const text = [
      JSON.stringify({ event: "player.deleted", player: C }),
      `id ${D}`,
      `${D} was erased`,
      `${A}x`,
      A,
    ].join("\n");
    expect(erasedIdsFrom(text)).toEqual([C.toLowerCase(), A]);
  });

  it("answers nothing for an empty file", () => {
    expect(erasedIdsFrom("")).toEqual([]);
  });
});

describe("re-applying erasures", () => {
  it("calls the door once per id with a fresh request id and counts each outcome", async () => {
    const outcomes = ["erased", "already_deleted", "erased", "gone", undefined];
    const query = vi.fn(async () => {
      const outcome = outcomes[query.mock.calls.length - 1];
      return { rows: outcome === undefined ? [] : [{ r: outcome }] };
    });
    const ids = [A, B, C, D, "eeeeeeee-2222-4333-8444-555555555555"];
    const counts = await reapplyErasures({ query } as unknown as Client, ids);
    expect(counts).toEqual({ erased: 2, alreadyDeleted: 1, unknown: 2 });
    expect(query.mock.calls.map((call) => (call as unknown[])[0])).toEqual(
      ids.map(() => "SELECT reapply_erasure($1, $2) AS r"),
    );
    const params = query.mock.calls.map((call) => (call as unknown[])[1] as string[]);
    expect(params.map(([id]) => id)).toEqual(ids);
    for (const [, requestId] of params) expect(requestId).toMatch(UUID_V4);
  });

  it("counts nothing for no ids", async () => {
    const query = vi.fn();
    expect(await reapplyErasures({ query } as unknown as Client, [])).toEqual({
      erased: 0,
      alreadyDeleted: 0,
      unknown: 0,
    });
    expect(query).not.toHaveBeenCalled();
  });
});
