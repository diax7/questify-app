import { describe, expect, it } from "vitest";
import { normalizeEntryCode } from "#src/quests/registry";

describe("normalizeEntryCode", () => {
  it.each([
    ["NAJD2030", "NAJD2030"],
    [" najd2030 ", "NAJD2030"],
    ["najd\u0662\u0660\u0663\u0660", "NAJD2030"],
    ["NAJD\u06F2\u06F0\u06F3\u06F0", "NAJD2030"],
    ["\u0660\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669", "0123456789"],
    ["\u06F0\u06F1\u06F2\u06F3\u06F4\u06F5\u06F6\u06F7\u06F8\u06F9", "0123456789"],
  ])("reads %j as %j", (typed, stored) => {
    expect(normalizeEntryCode(typed)).toBe(stored);
  });

  it("keeps a letter that is not a digit as it is, upper-cased", () => {
    expect(normalizeEntryCode("abc-\u0628")).toBe("ABC-\u0628");
  });
});
