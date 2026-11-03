import { describe, expect, it } from "vitest";
import { erasedIdsFrom } from "#src/privacy/reapply";

const A = "11111111-2222-4333-8444-555555555555";
const B = "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE";

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

  it("answers nothing for an empty file", () => {
    expect(erasedIdsFrom("")).toEqual([]);
  });
});
