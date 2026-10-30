import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A link to a page of the app is an `AppLink`, `ButtonLink`, `TextLink` or `NavItem`, never a plain `<a href>`, since a
 * plain anchor loads the document again (ADR-368, rules.md "Web navigation and pictures"). The plain anchors that remain
 * are listed here with their count, so a new one is a visible choice in the diff.
 */
const PLAIN_ANCHORS: Readonly<Record<string, number>> = {
  // A link to a device page (`/kiosk`, `/screen`, `/station`): those pages stay outside the shell.
  "components/DevicePairing.tsx": 1,
  "components/DevicesPanel.tsx": 1,
  // `AppLink` itself: the plain anchor it renders for a link that leaves the app.
  "ui/AppLink.tsx": 1,
  // The skip link jumps inside the document.
  "ui/ShellFrame.tsx": 1,
};

const SRC = join(__dirname, "..");

function anchorCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  const files = readdirSync(SRC, { withFileTypes: true, recursive: true }).filter(
    (entry) => entry.isFile() && entry.name.endsWith(".tsx") && !/\.test\./.test(entry.name),
  );
  for (const entry of files) {
    const path = join(entry.parentPath, entry.name);
    const found = readFileSync(path, "utf8").match(/<a[\s>]/g)?.length ?? 0;
    if (found > 0) {
      counts[relative(SRC, path).replaceAll("\\", "/")] = found;
    }
  }
  return counts;
}

describe("plain anchors (ADR-368)", () => {
  it("allows a plain <a> only where it is listed", () => {
    expect(
      anchorCounts(),
      "A link to a page of the app is an AppLink, ButtonLink, TextLink or NavItem. List a plain <a> here only for a device page, a link that leaves the app, or a jump inside the page.",
    ).toEqual(PLAIN_ANCHORS);
  });
});
