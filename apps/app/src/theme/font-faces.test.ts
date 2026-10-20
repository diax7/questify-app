import { describe, expect, it } from "vitest";
import { THEMES } from "@questify/shared";
import { fontFor } from "#src/theme/font-faces.ts";

describe("fontFor", () => {
  it("names the exact face when the family ships that weight", () => {
    expect(fontFor("Rubik", 600)).toBe("Rubik_600SemiBold");
    expect(fontFor("Baloo Bhaijaan 2", 800)).toBe("BalooBhaijaan2_800ExtraBold");
  });

  it("falls back to the closest weight the family ships", () => {
    expect(fontFor("Rubik", 800)).toBe("Rubik_700Bold");
    expect(fontFor("Baloo Bhaijaan 2", 400)).toBe("BalooBhaijaan2_500Medium");
  });

  it("refuses a family with no font files, naming it", () => {
    expect(() => fontFor("Comic Sans", 400)).toThrow(
      'No font files are registered for "Comic Sans": add them to FONT_FACES.',
    );
  });

  it("has a font file for every text style of every theme", () => {
    for (const theme of Object.values(THEMES)) {
      for (const style of Object.values(theme.text)) {
        expect(() => fontFor(theme.fonts[style.font], style.weight)).not.toThrow();
      }
    }
  });
});
