import { describe, expect, it } from "vitest";
import { MAX_PAGE_SIZE, decodeCursor, encodeCursor, parseLimit } from "./pagination";

describe("cursor", () => {
  it("round-trips any JSON position", () => {
    const position = { id: 41, at: "2026-10-19T09:00:00Z" };
    expect(decodeCursor(encodeCursor(position))).toEqual(position);
  });

  it("is opaque and URL safe", () => {
    const cursor = encodeCursor({ id: "a/b+c" });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each(["", "not base64 !!", "MTIz", "W10", "bnVsbA"])(
    "rejects the broken cursor %j",
    (broken) => {
      expect(() => decodeCursor(broken)).toThrow(RangeError);
    },
  );
});

describe("parseLimit", () => {
  it("uses the default when absent", () => {
    expect(parseLimit(undefined)).toBe(25);
  });

  it("accepts a whole number inside the range", () => {
    expect(parseLimit("50")).toBe(50);
    expect(parseLimit(String(MAX_PAGE_SIZE))).toBe(MAX_PAGE_SIZE);
  });

  it.each(["0", "-1", "1.5", "abc", String(MAX_PAGE_SIZE + 1), ""])("rejects %j", (bad) => {
    expect(() => parseLimit(bad)).toThrow(RangeError);
  });
});
