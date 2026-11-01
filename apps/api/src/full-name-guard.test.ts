import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A player's full name is personal data that reaches other people only through the reads that need it (T-615, ADR-400,
 * rules.md hard rule 3): the ranking, the revealed results, the station's result screen and the prize desk, with the
 * setting that decides it. It never goes to a push, a log line, an error or analytics. This list is the whole set of API
 * files that name it: a new file that does fails here until someone decides in the diff that it earns its place.
 */
const MAY_NAME_A_FULL_NAME = [
  "auth/http-errors.ts",
  "desk/desk.ts",
  "join/names.ts",
  "join/setup-routes.ts",
  "join/setup.ts",
  "operators/scan.ts",
  "ranking/display.ts",
  "ranking/ranking.ts",
  "results/results.ts",
];

const FULL_NAME = /full_?name/i;

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sources(path);
    }
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("where the API names a full name", () => {
  const root = join(import.meta.dirname);
  const files = sources(root).map((path) => ({
    name: relative(root, path).replaceAll("\\", "/"),
    text: readFileSync(path, "utf8"),
  }));

  it("is limited to the reads and the setting that need it", () => {
    const naming = files.filter((file) => FULL_NAME.test(file.text)).map((file) => file.name);
    expect(naming.toSorted()).toEqual(MAY_NAME_A_FULL_NAME.toSorted());
  });

  it("never puts a full name in a log line, a push or an audit entry", () => {
    for (const file of files.filter((one) => FULL_NAME.test(one.text))) {
      const lines = file.text.split("\n");
      lines.forEach((line, index) => {
        const risky = /\b(log|logger|caller\.log|deps\.log|enqueue|recordAudit)\b.*full_?name/i;
        expect(risky.test(line), `${file.name}:${index + 1}`).toBe(false);
      });
    }
  });

  it("keeps the push, analytics, usage, Questify-wide, profile, recap and play code free of it", () => {
    const quiet = files.filter((file) =>
      /^(push|analytics|usage|organizer-alerts|marketing|questify|players|recap|plays|cheers|souvenirs|passport)\//.test(
        file.name,
      ),
    );
    expect(quiet.length).toBeGreaterThan(20);
    for (const file of quiet) {
      expect(FULL_NAME.test(file.text), file.name).toBe(false);
    }
  });
});
