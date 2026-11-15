import { describe, expect, it } from "vitest";
import { linkToShow } from "#src/lib/kept-link.ts";

describe("linkToShow", () => {
  it("keeps the first link while it works, even when a newer one is signed", () => {
    expect(linkToShow("a", null, "a")).toBe("a");
    expect(linkToShow("a", null, "b")).toBe("a");
  });

  it("moves to the newest link after the kept one failed, and gives up when that one failed too", () => {
    expect(linkToShow("a", "a", "a")).toBeNull();
    expect(linkToShow("a", "a", "b")).toBe("b");
    expect(linkToShow("b", "b", "b")).toBeNull();
    expect(linkToShow("b", "b", "c")).toBe("c");
  });
});
