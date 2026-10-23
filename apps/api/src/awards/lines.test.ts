import { describe, expect, it } from "vitest";
import { MAX_LINES, parseBulkLines } from "#src/awards/lines";

const names = (count: number) =>
  Array.from({ length: count }, (_, index) => `user_${index}`).join("\n");

describe("parseBulkLines", () => {
  it("splits usernames and Saudi mobiles on lines, commas, semicolons and tabs", () => {
    expect(parseBulkLines("sara_k\n0501234567, @omar;\t+966 55 123 4567\r\nlayla")).toEqual({
      usernames: ["sara_k", "omar", "layla"],
      phones: ["+966501234567", "+966551234567"],
    });
  });

  it("drops blanks, a bare @ and repeats, phones in any form included", () => {
    expect(parseBulkLines(" \n@\n,,sara\nsara\n0501234567\n٠٥٠١٢٣٤٥٦٧")).toEqual({
      usernames: ["sara"],
      phones: ["+966501234567"],
    });
  });

  it("answers an empty list with nothing", () => {
    expect(parseBulkLines("")).toEqual({ usernames: [], phones: [] });
  });

  it("allows exactly the limit and refuses one more", () => {
    expect(parseBulkLines(names(MAX_LINES))).not.toBe("too_many");
    expect(parseBulkLines(names(MAX_LINES + 1))).toBe("too_many");
    expect(parseBulkLines(`${names(MAX_LINES)}\nuser_0`)).not.toBe("too_many");
  });
});
