import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const APP = join(import.meta.dirname, "..", "..");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

/**
 * FR-612: no event screen shows the Questify-wide ranking. Every file of an event's screens, its tabs, its operator
 * side and the event's modules is read, and none may import Explore's modules or call the Questify ranking's route.
 */
describe("the Questify-wide ranking stays out of events", () => {
  const eventFiles = ["app/event", "app/operator", "src/event", "src/operator"].flatMap((folder) =>
    sourceFiles(join(APP, folder)).filter((file) => !/\.test\.tsx?$/.test(file)),
  );

  it("reads the event folders it means to guard", () => {
    expect(eventFiles.length).toBeGreaterThan(40);
  });

  it("imports nothing from Explore and never asks for /v1/questify/ranking", () => {
    const offenders = eventFiles.filter((file) => {
      const text = readFileSync(file, "utf8");
      return /#src\/explore\//.test(text) || /v1\/questify\/ranking/.test(text);
    });
    expect(offenders).toEqual([]);
  });
});
