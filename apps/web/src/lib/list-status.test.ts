import { describe, expect, it } from "vitest";
import { listStatus } from "#src/lib/list-status.ts";

describe("listStatus", () => {
  it("is loading while nothing arrived and nothing failed", () => {
    expect(listStatus(null, null)).toBe("loading");
  });

  it("is ready, not loading, once a failure is shown", () => {
    expect(listStatus(null, "Network down")).toBe("ready");
  });

  it("is empty for an empty page, even beside a notice", () => {
    expect(listStatus([], null)).toBe("empty");
    expect(listStatus([], "Late failure")).toBe("empty");
  });

  it("is ready for a page with rows", () => {
    expect(listStatus([{ id: "a" }], null)).toBe("ready");
    expect(listStatus(["a", "b"], "x")).toBe("ready");
  });
});
