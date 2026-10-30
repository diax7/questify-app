import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { AVATARS, CURRENCY_ICONS } from "@questify/shared";
import { describe, expect, it } from "vitest";

const WEB = join(import.meta.dirname, "..", "..");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Every picture the pages ask for from `public/`, as the address the page uses. */
const PICTURES: readonly string[] = [
  ...AVATARS.map((name) => `/avatars/${name}.png`),
  ...CURRENCY_ICONS.map((name) => `/currency/${name}.png`),
  "/souvenirs/chest.png",
  "/brand/questify-wordmark.png",
  "/brand/icon-192.png",
  "/brand/apple-touch-icon.png",
];

/** The folders of `public/` that hold pictures; a page may name a picture only from one of them. */
const PICTURE_FOLDERS = new Set(["avatars", "currency", "souvenirs", "brand"]);

function sourceFiles(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) {
      return sourceFiles(path);
    }
    return entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx") ? [path] : [];
  });
}

describe("the pictures the pages show", () => {
  it.each(PICTURES)("%s is shipped as a PNG that has content", (address) => {
    const file = readFileSync(join(WEB, "public", address));
    expect(file.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(file.length).toBeGreaterThan(1000);
  });

  it("ships the tab icon at the address browsers ask for first", () => {
    expect(statSync(join(WEB, "public", "favicon.ico")).size).toBeGreaterThan(1000);
  });

  it("names a picture only from a folder this list covers", () => {
    const named = sourceFiles(join(WEB, "src")).flatMap((path) =>
      [...readFileSync(path, "utf8").matchAll(/src=\{?[`"']\/([a-z]+)\//g)].map((match) => ({
        path,
        folder: match[1] ?? "",
      })),
    );
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter(({ folder }) => !PICTURE_FOLDERS.has(folder))).toEqual([]);
  });
});
