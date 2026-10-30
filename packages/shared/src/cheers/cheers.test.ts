import { describe, expect, it } from "vitest";
import { MESSAGES } from "#src/i18n/messages";
import { CHEER_MINUTES_KEYS, CHEER_MOMENT_MINUTES } from "#src/cheers/cheers";

describe("the cheers moment's length labels (T-509 review)", () => {
  it("name every length the owner can pick, in the Arabic form its count needs", () => {
    expect(CHEER_MOMENT_MINUTES.map((minutes) => MESSAGES[CHEER_MINUTES_KEYS[minutes]].ar)).toEqual(
      ["دقيقة واحدة", "دقيقتان", "5 دقائق", "10 دقائق", "15 دقيقة", "30 دقيقة"],
    );
  });

  it("write the English length with its own number", () => {
    for (const minutes of CHEER_MOMENT_MINUTES) {
      expect(MESSAGES[CHEER_MINUTES_KEYS[minutes]].en).toBe(`${minutes} min`);
    }
  });
});
