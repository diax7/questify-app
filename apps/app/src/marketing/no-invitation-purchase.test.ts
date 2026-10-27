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
 * FR-740 (T-409, ADR-329): Questify invitations are requested and billed on the web only; no screen of the mobile app
 * may request, show or buy one. Every app source file is read, and none may name the invitation campaign routes.
 */
describe("Questify invitations stay out of the mobile app", () => {
  const files = ["app", "src"].flatMap((folder) =>
    sourceFiles(join(APP, folder)).filter((file) => !/\.test\.tsx?$/.test(file)),
  );

  it("reads the app's folders it means to guard", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("never names the invitation campaign routes", () => {
    const offenders = files.filter((file) =>
      /invitation-campaigns|invitation_campaign|invitationCampaign/i.test(
        readFileSync(file, "utf8"),
      ),
    );
    expect(offenders).toEqual([]);
  });
});
