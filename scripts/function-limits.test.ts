import { describe, expect, it } from "vitest";
import {
  compare,
  describeFinding,
  formatBaseline,
  parseOffenders,
  runRatchet,
  verifyScan,
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
    expect(fixedOne.improvements.map((item) => [item.kind, item.was])).toEqual([["gone", 140]]);
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

describe("compare with a new function that is the largest", () => {
  it("reports it as new, not as a grown one", () => {
    const baseline = baselineOf(
      linesLine("a.ts", 10, "function", 120),
      linesLine("a.ts", 200, "function", 105),
    );

    const result = run(
      baseline,
      linesLine("a.ts", 10, "function", 120),
      linesLine("a.ts", 200, "function", 105),
      linesLine("a.ts", 500, "function", 300),
    );

    expect(result.failures.map((failure) => [failure.kind, failure.value])).toEqual([["new", 300]]);
  });
});

const ok = (stdout: string, status = 1, stderr = "") => ({ status, stdout, stderr });
const oneOffender = complexityLine("a.ts", 1, "function `f`", 9);

describe("verifyScan", () => {
  it("reads a consistent failing run and a clean run", () => {
    expect(verifyScan(ok(`${oneOffender}\n\n1 problem\n`))).toHaveLength(1);
    expect(verifyScan(ok("", 0))).toEqual([]);
    expect(verifyScan(ok("0 problems\n", 0))).toEqual([]);
  });

  it("refuses a crash, a signal and a spawn error", () => {
    expect(() => verifyScan({ status: 2, stdout: "", stderr: "boom" })).toThrow(/did not finish/);
    expect(() => verifyScan({ status: null, stdout: "", stderr: "" })).toThrow(/did not finish/);
    expect(() => verifyScan({ error: new Error("ENOENT"), stdout: "", stderr: "" })).toThrow(
      /ENOENT/,
    );
  });

  it("refuses a broken config: status 1 with nothing read", () => {
    const config = "Failed to parse oxlint configuration file.\n\n  x Rule 'x' not found";
    expect(() => verifyScan(ok(config))).toThrow(/cannot be trusted/);
    expect(() => verifyScan(ok(""))).toThrow(/exit status 1 with 0 offenders/);
  });

  it("refuses output it does not recognise, even next to good lines", () => {
    const text = `${oneOffender}\napps/x.ts:3:1: something else [Error/eslint(no-undef)]\n1 problem\n`;
    expect(() => verifyScan(ok(text))).toThrow(/unrecognised output: apps\/x.ts:3:1/);
  });

  it("refuses a summary that disagrees with the lines read", () => {
    expect(() => verifyScan(ok(`${oneOffender}\n2 problems\n`))).toThrow(/summary of 2/);
    expect(() => verifyScan(ok(oneOffender))).toThrow(/summary of none/);
  });

  it("refuses status 0 with problems, and an error stream with nothing read", () => {
    expect(() => verifyScan(ok(`${oneOffender}\n1 problem\n`, 0))).toThrow(/status 0/);
    expect(() => verifyScan(ok("", 0, "warning: odd"))).toThrow(/error stream/);
  });
});

const scanOf = (...lines: string[]) => ok(`${lines.join("\n")}\n${lines.length} problems\n`);

describe("runRatchet", () => {
  const baseline = baselineOf(complexityLine("a.ts", 1, "function `f`", 12));

  it("passes and only suggests --update when offenders shrank", () => {
    const result = runRatchet({
      baseline,
      scan: scanOf(complexityLine("a.ts", 1, "function `f`", 9)),
      update: false,
    });

    expect(result.code).toBe(0);
    expect(result.newBaseline).toBeUndefined();
    expect(result.out.join("\n")).toContain("Run with --update");
  });

  it("fails with the finding and a hint on a new offender", () => {
    const result = runRatchet({
      baseline,
      scan: scanOf(
        complexityLine("a.ts", 1, "function `f`", 12),
        linesLine("b.ts", 4, "function", 101),
      ),
      update: false,
    });

    expect(result.code).toBe(1);
    expect(result.err[0]).toBe("new offender: <anonymous> (b.ts:4) has 101 lines");
    expect(result.err.at(-1)).toContain("1 function limit violation(s)");
  });

  it("--update lowers the baseline", () => {
    const result = runRatchet({
      baseline,
      scan: scanOf(complexityLine("a.ts", 1, "function `f`", 9)),
      update: true,
    });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.newBaseline ?? "")).toEqual({ "a.ts": { f: { complexity: [9] } } });
  });

  it("--update refuses to grow the baseline", () => {
    const result = runRatchet({
      baseline,
      scan: scanOf(complexityLine("a.ts", 1, "function `f`", 13)),
      update: true,
    });

    expect(result.code).toBe(1);
    expect(result.newBaseline).toBeUndefined();
  });

  it("--update never writes after a broken run, and a broken run never passes", () => {
    for (const scan of [
      ok(""),
      ok("", 2, "crash"),
      ok("Failed to parse oxlint configuration file."),
    ]) {
      for (const update of [true, false]) {
        const result = runRatchet({ baseline, scan, update });

        expect(result.code).toBe(1);
        expect(result.newBaseline).toBeUndefined();
        expect(result.err[0]).toContain("cannot be trusted");
      }
    }
  });
});
