import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..");
/** What pays or opens anything: rewards and the desk, the ledger's writers, quests and plays, XP and gems. */
const PAYING = [
  "rewards",
  "desk",
  "completions",
  "quests",
  "plays",
  "awards",
  "questify",
  "streaks",
  "daily",
  "results",
];
const NAMES = /push_device|push-device|pushDevice|push_topic|notification_?center|permission/i;

const files = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name));

describe("FR-1106: push is never rewarded and blocks nothing", () => {
  it("no rewards, ledger, quest, XP or gem code reads the push device or the permission", () => {
    const offenders = PAYING.flatMap((folder) => files(join(SRC, folder)))
      .filter((file) => NAMES.test(readFileSync(file, "utf8")))
      .map((file) => file.slice(SRC.length + 1));
    expect(offenders).toEqual([]);
  });
});
