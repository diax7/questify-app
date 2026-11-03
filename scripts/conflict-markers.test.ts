import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");

/** Tracked lines that are a merge's conflict markers (a merge once committed them into the docs). */
function conflictMarkers(): string[] {
  try {
    return execFileSync(
      "git",
      [
        "grep",
        "-n",
        "-E",
        "^(<<<<<<< |>>>>>>> |=======$)",
        "--",
        ".",
        ":!*.png",
        ":!pnpm-lock.yaml",
      ],
      { cwd: ROOT, encoding: "utf8" },
    )
      .split("\n")
      .filter((line) => line !== "");
  } catch (error) {
    if ((error as { status?: number }).status === 1) {
      return [];
    }
    throw error;
  }
}

describe("conflict markers", () => {
  it("leaves none in any tracked file", () => {
    expect(conflictMarkers()).toEqual([]);
  });
});
