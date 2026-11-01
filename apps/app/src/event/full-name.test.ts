import { describe, expect, it } from "vitest";
import { fullNameOf, isolatedName } from "#src/event/full-name.ts";

describe("fullNameOf", () => {
  it("keeps a name and drops blank or non-text answers", () => {
    expect(fullNameOf("Sara Ahmed")).toBe("Sara Ahmed");
    expect(fullNameOf("   ")).toBeNull();
    expect(fullNameOf(7)).toBeNull();
    expect(fullNameOf(undefined)).toBeNull();
  });
});

describe("isolatedName", () => {
  it("wraps a name in a first-strong isolate so it cannot reorder the row around it", () => {
    expect(isolatedName("Sara")).toBe("\u2068Sara\u2069");
    expect(isolatedName("سارة")).toBe("\u2068سارة\u2069");
  });
});
