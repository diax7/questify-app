import { describe, expect, it } from "vitest";
import { parseJoinLink } from "./link";
import { parseRehearsalCode } from "./rehearsal";

describe("parseRehearsalCode", () => {
  it("accepts the shape in any case, trimmed", () => {
    expect(parseRehearsalCode(" abcd-2345 ")).toBe("ABCD-2345");
  });

  it("refuses a join code, a missing hyphen, ambiguous characters and extra ones", () => {
    for (const text of [
      "NAJD1",
      "ABCD2345",
      "ABCD-234O",
      "ABCD-2341",
      "IBCD-2345",
      "XABCD-2345",
      "ABCD-23456",
      "",
    ]) {
      expect(parseRehearsalCode(text)).toBeNull();
    }
  });

  it("never reads as a join code, so the two never meet", () => {
    expect(parseJoinLink("ABCD-2345")).toBeNull();
  });
});
