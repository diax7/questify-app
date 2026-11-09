import { describe, expect, it } from "vitest";
import { sectionLook } from "#src/ui/section-look.ts";

describe("sectionLook", () => {
  it("follows the heading level when no look is given", () => {
    expect(sectionLook(2)).toBe("section");
    expect(sectionLook(3)).toBe("sub");
  });

  it("keeps the look it is given at either level", () => {
    expect(sectionLook(2, "sub")).toBe("sub");
    expect(sectionLook(3, "section")).toBe("section");
    expect(sectionLook(2, "section")).toBe("section");
    expect(sectionLook(3, "sub")).toBe("sub");
  });
});
