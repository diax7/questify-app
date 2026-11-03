import { describe, expect, it } from "vitest";
import { idsOf, isRead } from "#src/organizers/support-view";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("idsOf (the view log's path ids, ADR-523)", () => {
  it("keeps UUID values only, lower-cased, without the organizer and the event", () => {
    expect(
      idsOf({ organizerId: A, eventId: B, enrollmentId: A.toUpperCase(), panel: "funnel" }),
    ).toEqual({ enrollmentId: A });
  });

  it("keeps at most four ids", () => {
    const params = { a: A, b: A, c: A, d: B, e: B };
    expect(Object.keys(idsOf(params))).toEqual(["a", "b", "c", "d"]);
  });

  it("answers an empty object for no params", () => {
    expect(idsOf(undefined)).toEqual({});
    expect(idsOf({})).toEqual({});
  });
});

describe("isRead", () => {
  it("is true for GET and HEAD only", () => {
    expect(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].map(isRead)).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
  });
});
