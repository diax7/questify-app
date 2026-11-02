import type { ComposedConfig } from "@questify/shared";
import { describe, expect, it } from "vitest";
import { switchedOffMessages } from "#src/config/notices.ts";

const message = (ar: string, en: string) => ({ ar, en });
const feature = (enabled: boolean, text: ReturnType<typeof message> | null) => ({
  enabled,
  minAppVersion: null,
  message: text,
});
const config = (features: ComposedConfig["features"]): ComposedConfig =>
  ({ schemaVersion: 1, features, tuning: {} }) as unknown as ComposedConfig;

describe("the messages of switched-off features", () => {
  it("lists the message of each feature that is off, in the player's language", () => {
    const composed = config({
      shop: feature(false, message("المتجر متوقف.", "The shop is paused.")),
      maps: feature(false, message("الخرائط متوقفة.", "Maps are paused.")),
      ranking: feature(true, null),
    });
    expect(switchedOffMessages(composed, "en")).toEqual([
      "Maps are paused.",
      "The shop is paused.",
    ]);
    expect(switchedOffMessages(composed, "ar")).toEqual(["الخرائط متوقفة.", "المتجر متوقف."]);
  });

  it("says nothing for a feature that is off without a message, or on", () => {
    const composed = config({
      bigScreen: feature(false, null),
      shop: feature(true, message("x", "x")),
    });
    expect(switchedOffMessages(composed, "en")).toEqual([]);
  });

  it("lists a text shared by two features once, and skips a blank one", () => {
    const same = message("متوقف", "Paused");
    const composed = config({
      a: feature(false, same),
      b: feature(false, same),
      c: feature(false, message("  ", "  ")),
    });
    expect(switchedOffMessages(composed, "en")).toEqual(["Paused"]);
  });

  it("says nothing without a configuration", () => {
    expect(switchedOffMessages(undefined, "en")).toEqual([]);
    expect(switchedOffMessages(null, "ar")).toEqual([]);
  });
});
