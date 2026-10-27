import { describe, expect, it } from "vitest";
import {
  compare,
  describeFinding,
  formatBaseline,
  parseOffenders,
  toBaseline,
} from "./function-limits.mjs";

const complexityLine = (file: string, line: number, subject: string, value: number) =>
  `${file}:${line}:8: ${subject} has a complexity of ${value}. Maximum allowed is 8. [Error/eslint(complexity)]`;
const linesLine = (file: string, line: number, subject: string, value: number) =>
  `${file}:${line}:1: The ${subject} has too many lines (${value}). Maximum allowed is 100. [Error/eslint(max-lines-per-function)]`;

describe("parseOffenders", () => {
  it("reads named, async and anonymous functions for both rules", () => {
    const output = [
      complexityLine("apps/api/src/a.ts", 10, "function `named`", 12),
      complexityLine("apps/api/src/a.ts", 30, "async function `loader`", 9),
      complexityLine("apps/api/src/a.ts", 50, "function", 20),
      linesLine("apps/app/src/B.tsx", 5, "function `Panel`", 170),
      linesLine("apps/app/src/B.tsx", 400, "async function", 101),
      "",
      "5 problems",
    ].join("\n");

    expect(parseOffenders(output)).toEqual([
      { file: "apps/api/src/a.ts", name: "named", rule: "complexity", value: 12, line: 10 },
      { file: "apps/api/src/a.ts", name: "loader", rule: "complexity", value: 9, line: 30 },
      { file: "apps/api/src/a.ts", name: "<anonymous>", rule: "complexity", value: 20, line: 50 },
      { file: "apps/app/src/B.tsx", name: "Panel", rule: "lines", value: 170, line: 5 },
      { file: "apps/app/src/B.tsx", name: "<anonymous>", rule: "lines", value: 101, line: 400 },
    ]);
  });

  it("normalises Windows separators and ignores unrelated lines", () => {
    const output = [
      complexityLine("apps\\api\\src\\a.ts", 1, "function `f`", 9),
      "apps/api/src/b.ts:1:1: unused variable [Warn/eslint(no-unused-vars)]",
    ].join("\r\n");

    expect(parseOffenders(output).map((offender) => offender.file)).toEqual(["apps/api/src/a.ts"]);
  });
});

const baselineOf = (...lines: string[]) => toBaseline(parseOffenders(lines.join("\n")));

const run = (baseline: unknown, ...lines: string[]) =>
  compare(baseline, parseOffenders(lines.join("\n")));

describe("compare", () => {
  it("passes when nothing changed, wherever the function moved in its file", () => {
    const baseline = baselineOf(complexityLine("a.ts", 10, "function `f`", 12));

    const result = run(baseline, complexityLine("a.ts", 300, "function `f`", 12));

    expect(result).toEqual({ failures: [], improvements: [] });
  });

  it("fails on a new offender in a new file", () => {
    const result = run({}, linesLine("a.ts", 3, "function `fresh`", 130));

    expect(result.failures).toHaveLength(1);
    expect(describeFinding(result.failures[0])).toBe("new offender: fresh (a.ts:3) has 130 lines");
  });

  it("fails on a new offender in a known file and on a second rule for a known function", () => {
    const baseline = baselineOf(complexityLine("a.ts", 10, "function `f`", 12));

    const result = run(
      baseline,
      complexityLine("a.ts", 10, "function `f`", 12),
      complexityLine("a.ts", 80, "function `g`", 9),
      linesLine("a.ts", 10, "function `f`", 101),
    );

    expect(result.failures.map((failure) => failure.name).toSorted()).toEqual(["f", "g"]);
  });

  it("fails when a baselined function grows, by one unit as well", () => {
    const baseline = baselineOf(complexityLine("a.ts", 10, "function `f`", 12));

    const result = run(baseline, complexityLine("a.ts", 10, "function `f`", 13));

    expect(result.failures).toHaveLength(1);
    expect(describeFinding(result.failures[0])).toBe(
      "grew: f (a.ts:10) went from 12 to 13 complexity",
    );
  });

  it("treats a renamed offender as a new one and reports the old name as gone", () => {
    const baseline = baselineOf(complexityLine("a.ts", 10, "function `before`", 12));

    const result = run(baseline, complexityLine("a.ts", 10, "function `after`", 12));

    expect(result.failures.map((failure) => failure.name)).toEqual(["after"]);
    expect(result.improvements.map((item) => [item.kind, item.name])).toEqual([["gone", "before"]]);
  });

  it("matches functions sharing a name in one file largest to largest", () => {
    const baseline = baselineOf(
      complexityLine("a.ts", 10, "function `handler`", 15),
      complexityLine("a.ts", 60, "function `handler`", 9),
    );

    const unchanged = run(
      baseline,
      complexityLine("a.ts", 5, "function `handler`", 9),
      complexityLine("a.ts", 90, "function `handler`", 15),
    );
    const third = run(
      baseline,
      complexityLine("a.ts", 5, "function `handler`", 9),
      complexityLine("a.ts", 50, "function `handler`", 15),
      complexityLine("a.ts", 90, "function `handler`", 9),
    );
    const grown = run(
      baseline,
      complexityLine("a.ts", 5, "function `handler`", 11),
      complexityLine("a.ts", 90, "function `handler`", 15),
    );

    expect(unchanged.failures).toEqual([]);
    expect(third.failures.map((failure) => failure.kind)).toEqual(["new"]);
    expect(grown.failures.map((failure) => [failure.kind, failure.was, failure.value])).toEqual([
      ["grew", 9, 11],
    ]);
  });

  it("matches anonymous functions in one file the same way", () => {
    const baseline = baselineOf(
      linesLine("a.ts", 10, "function", 140),
      linesLine("a.ts", 200, "function", 110),
    );

    const fixedOne = run(baseline, linesLine("a.ts", 20, "function", 110));
    const addedOne = run(
      baseline,
      linesLine("a.ts", 20, "function", 140),
      linesLine("a.ts", 210, "function", 110),
      linesLine("a.ts", 400, "function", 101),
    );

    expect(fixedOne.failures).toEqual([]);
    expect(fixedOne.improvements.map((item) => [item.kind, item.was])).toEqual([
      ["shrunk", 140],
      ["gone", 110],
    ]);
    expect(addedOne.failures.map((failure) => [failure.name, failure.kind])).toEqual([
      ["<anonymous>", "new"],
    ]);
  });

  it("reports shrunk and gone offenders without failing", () => {
    const baseline = baselineOf(
      complexityLine("a.ts", 10, "function `f`", 12),
      linesLine("b.ts", 1, "function `g`", 150),
    );

    const result = run(baseline, complexityLine("a.ts", 10, "function `f`", 9));

    expect(result.failures).toEqual([]);
    expect(result.improvements.map((item) => [item.kind, item.name, item.was])).toEqual([
      ["shrunk", "f", 12],
      ["gone", "g", 150],
    ]);
    expect(describeFinding(result.improvements[1])).toBe(
      "gone: g (b.ts) no longer exceeds lines (was 150)",
    );
  });
});

describe("toBaseline and formatBaseline", () => {
  it("sorts files, names and values and keeps value lists on one line", () => {
    const offenders = parseOffenders(
      [
        complexityLine("b.ts", 1, "function `z`", 9),
        complexityLine("a.ts", 1, "function `f`", 9),
        complexityLine("a.ts", 50, "function `f`", 14),
        linesLine("a.ts", 1, "function `f`", 120),
      ].join("\n"),
    );

    const text = formatBaseline(toBaseline(offenders));

    expect(Object.keys(JSON.parse(text))).toEqual(["a.ts", "b.ts"]);
    expect(JSON.parse(text)["a.ts"].f).toEqual({ complexity: [14, 9], lines: [120] });
    expect(text).toContain('"complexity": [14, 9]');
    expect(text.endsWith("}\n")).toBe(true);
  });
});
