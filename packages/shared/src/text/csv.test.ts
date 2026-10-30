import { describe, expect, it } from "vitest";
import { csvCell, csvFile } from "./csv";

describe("csvCell", () => {
  it("leaves a plain value and a number as they are", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell(42)).toBe("42");
    expect(csvCell(-3)).toBe("-3");
  });

  it("quotes a value with a comma, a semicolon, a quote or a line break, doubling the quotes", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell("a;b")).toBe('"a;b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("one\ntwo")).toBe('"one\ntwo"');
  });

  it("makes a text that starts like a formula inert", () => {
    for (const formula of ["=1+1", "+1", "-1", "@SUM(A1)", "\tcmd", "\rcmd"]) {
      expect(csvCell(formula).replace(/^"/u, "").startsWith("'"), formula).toBe(true);
    }
  });
});

describe("csvFile", () => {
  it("starts with a byte-order mark and ends each row with a carriage return and a line feed", () => {
    const file = csvFile([
      ["a", 1],
      ["b,c", 2],
    ]);
    expect(file).toBe('﻿a,1\r\n"b,c",2\r\n');
  });
});
