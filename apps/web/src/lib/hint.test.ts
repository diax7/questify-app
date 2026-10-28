import { describe, expect, it } from "vitest";
import { hintPreviewOf } from "#src/lib/hint.ts";

describe("the hint's count (T-501g)", () => {
  it("reads the members and whether the last hint is pending", () => {
    expect(hintPreviewOf({ members: 12, pending: false })).toEqual({ members: 12, pending: false });
    expect(hintPreviewOf({ members: 0, pending: true })).toEqual({ members: 0, pending: true });
  });

  it("refuses anything else", () => {
    for (const body of [
      null,
      undefined,
      "12",
      {},
      { members: 1 },
      { members: -1, pending: false },
      { members: 1.5, pending: false },
      { members: "3", pending: false },
      { members: 3, pending: "no" },
    ]) {
      expect(hintPreviewOf(body), JSON.stringify(body)).toBeUndefined();
    }
  });
});
