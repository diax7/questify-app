import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { adventureTheme } from "@questify/shared";
import { themeVariables } from "#src/lib/theme.ts";

const SRC = join(import.meta.dirname, "..");

const styleSheets = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".css"))
    .map((entry) => join(entry.parentPath, entry.name));

describe("themeVariables", () => {
  it("names every colour, space and radius of the theme as a CSS variable", () => {
    const variables = themeVariables(adventureTheme) as Record<string, string>;
    expect(variables["--color-text"]).toBe(adventureTheme.colors.text);
    expect(variables["--color-danger-surface"]).toBe(adventureTheme.colors.dangerSurface);
    expect(variables["--space-md"]).toBe("12px");
    expect(variables["--radius-pill"]).toBe("999px");
    expect(Object.keys(variables)).toHaveLength(
      Object.keys(adventureTheme.colors).length +
        Object.keys(adventureTheme.spacing).length +
        Object.keys(adventureTheme.radius).length,
    );
  });
});

describe("style sheets", () => {
  it("use theme variables, never a raw colour (NFR-024)", () => {
    for (const file of styleSheets(SRC)) {
      const css = readFileSync(file, "utf8");
      expect(css.match(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/gi), file).toBeNull();
    }
  });

  it("only use colour variables the theme defines", () => {
    const defined = new Set(Object.keys(themeVariables(adventureTheme)));
    for (const file of styleSheets(SRC)) {
      for (const [, name] of readFileSync(file, "utf8").matchAll(
        /var\((--(?:color|space|radius)-[a-z-]+)\)/g,
      )) {
        expect(defined.has(name ?? ""), `${file}: ${name}`).toBe(true);
      }
    }
  });
});
