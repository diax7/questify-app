import { describe, expect, it } from "vitest";
import { souvenirStatusKey } from "#src/lib/souvenir-copy.ts";

describe("souvenirStatusKey", () => {
  it("is complete when nothing is due or scanning", () => {
    expect(souvenirStatusKey({ due: 0, scanning: 0 })).toBe("souvenir.complete");
  });

  it("is pending when something is due, scanning, or both", () => {
    expect(souvenirStatusKey({ due: 2, scanning: 0 })).toBe("souvenir.pending");
    expect(souvenirStatusKey({ due: 0, scanning: 1 })).toBe("souvenir.pending");
    expect(souvenirStatusKey({ due: 3, scanning: 4 })).toBe("souvenir.pending");
  });
});
