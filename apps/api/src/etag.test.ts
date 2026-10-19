import { describe, expect, it } from "vitest";
import { etagMatches, etagOf } from "#src/etag";

describe("etagOf", () => {
  it("is a quoted 32-character hex tag", () => {
    expect(etagOf({ a: 1 })).toMatch(/^"[0-9a-f]{32}"$/);
  });

  it("is the same for the same document and different for another", () => {
    expect(etagOf({ a: 1, b: [2] })).toBe(etagOf({ a: 1, b: [2] }));
    expect(etagOf({ a: 1 })).not.toBe(etagOf({ a: 2 }));
  });
});

describe("etagMatches", () => {
  const tag = '"abc"';

  it("matches the tag itself, a weak copy of it, one in a list, and the wildcard", () => {
    for (const header of [tag, `W/${tag}`, `"x", ${tag}`, `${tag} , "y"`, "*"]) {
      expect(etagMatches(header, tag), header).toBe(true);
    }
  });

  it("only strips a weak marker at the start of a tag", () => {
    expect(etagMatches('"xW/y"', '"xy"')).toBe(false);
  });

  it("does not match another tag, a prefix of it, or a missing header", () => {
    for (const header of ['"abd"', '"ab"', '"abcd"', "", undefined]) {
      expect(etagMatches(header, tag), String(header)).toBe(false);
    }
  });
});
