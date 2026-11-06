import { describe, expect, it } from "vitest";
import { demoOrganizerIn } from "#src/console/feature-usage";

const ORGANIZER = "6f1c2a4e-8b3d-4c5e-9f70-1a2b3c4d5e6f";

describe("demoOrganizerIn", () => {
  it("reads the organizer id and ignores the rest of the demo's answer, whatever its shape", () => {
    expect(
      demoOrganizerIn({ exists: true, organizerId: ORGANIZER, readiness: { renamed: [1, 2] } }),
    ).toBe(ORGANIZER);
  });

  it("answers null when there is no demo", () => {
    expect(demoOrganizerIn({ exists: false })).toBeNull();
  });

  it("refuses an answer that is not the demo's", () => {
    expect(() => demoOrganizerIn(null)).toThrow();
    expect(() => demoOrganizerIn({ exists: true, organizerId: "not-an-id" })).toThrow();
  });
});
