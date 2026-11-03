import {
  DEFAULT_COMPOSED_QUESTIFY_HOME,
  QUESTIFY_HOME_KEYS,
  type ComposedConfig,
} from "@questify/shared";
import { describe, expect, it } from "vitest";
import { bannerOutcome, homeLayoutOf, showsDaily } from "#src/home/home-layout.ts";

const configWith = (blocks: ComposedConfig["questifyHome"]["blocks"]): ComposedConfig =>
  ({ questifyHome: { blocks, banner: [] } }) as unknown as ComposedConfig;

describe("Questify home's layout on the phone (T-713)", () => {
  it("draws the order Home always had until a configuration has been read", () => {
    expect(homeLayoutOf(undefined)).toEqual(DEFAULT_COMPOSED_QUESTIFY_HOME);
    expect(homeLayoutOf(undefined).blocks).toEqual(QUESTIFY_HOME_KEYS);
  });

  it("draws the blocks the configuration lists, in its order", () => {
    const blocks = ["events", "dailyWord", "banner"] as const;
    expect(homeLayoutOf(configWith(blocks)).blocks).toEqual(blocks);
  });

  it("reads the daily games only while one of the two is on the screen", () => {
    expect(showsDaily(QUESTIFY_HOME_KEYS)).toBe(true);
    expect(showsDaily(["events", "dailyWord"])).toBe(true);
    expect(showsDaily(["dailyChallenge"])).toBe(true);
    expect(showsDaily(["events", "streak"])).toBe(false);
    expect(showsDaily([])).toBe(false);
  });
});

describe("a tap on a Questify home slide", () => {
  it("opens a web link, host first, and nothing else", () => {
    expect(bannerOutcome({ type: "link", url: "https://questify.example/a?b=1" })).toEqual({
      kind: "link",
      url: "https://questify.example/a?b=1",
      host: "questify.example",
    });
    for (const action of [
      { type: "none" },
      { type: "agenda" },
      { type: "maps" },
      { type: "shop" },
      { type: "quest", questId: "5b0c1e4e-6a53-4f5c-9d51-3a8f4a2f9a10" },
    ] as const) {
      expect(bannerOutcome(action), action.type).toBeNull();
    }
  });
});
