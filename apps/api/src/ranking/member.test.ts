import { describe, expect, it } from "vitest";
import { memberOf, parseMember } from "#src/ranking/member";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

/** Redis's order among equal scores in a highest-first read: members by their bytes, largest first. */
const highestFirst = (members: string[]) => members.toSorted().toReversed();

describe("ranking members", () => {
  it("puts whoever reached the points first ahead among equal points", () => {
    const earlier = memberOf(41n, B);
    const later = memberOf(42n, A);
    expect(highestFirst([later, earlier])).toEqual([earlier, later]);
  });

  it("orders versions as numbers, not as text, across digit counts", () => {
    const versions = [9n, 10n, 99n, 100n, 1_000_000_007n];
    const members = versions.map((version) => memberOf(version, A));
    expect(highestFirst(members.toReversed())).toEqual(members);
  });

  it("reads back what it wrote, at both ends of the range", () => {
    for (const version of [0n, 1n, 9_223_372_036_854_775_807n]) {
      expect(parseMember(memberOf(version, A))).toEqual({ version, enrollmentId: A });
    }
    expect(memberOf(0n, A)).toBe(`9223372036854775807:${A}`);
    expect(memberOf(9_223_372_036_854_775_807n, A)).toBe(`0000000000000000000:${A}`);
  });

  it("refuses a version that is not a ledger id", () => {
    expect(() => memberOf(-1n, A)).toThrow(RangeError);
    expect(() => memberOf(9_223_372_036_854_775_808n, A)).toThrow(RangeError);
  });

  it("parses nothing that is not a member", () => {
    for (const text of ["", A, `123:${A}`, `9223372036854775807:${A}x`, `x${memberOf(1n, A)}`]) {
      expect(parseMember(text)).toBeUndefined();
    }
  });
});
