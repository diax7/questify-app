import { DEFAULT_TERMS } from "@questify/shared";
import { describe, expect, it } from "vitest";
import {
  codeGraceMs,
  deviceAnswerOf,
  devicePagePath,
  nextCodeDelayMs,
  pairUrl,
  pollDelayMs,
  screenCodeOf,
  shutKey,
} from "#src/lib/device.ts";

describe("the device's answers (T-309)", () => {
  it("reads a pending page, with or without its code", () => {
    expect(
      deviceAnswerOf({ state: "pending", kind: "station", code: "ABCD-EFGH", expiresAt: "t" }),
    ).toEqual({ state: "pending", kind: "station", code: "ABCD-EFGH", expiresAt: "t" });
    expect(deviceAnswerOf({ state: "pending", kind: "screen", expiresAt: "t" })).toMatchObject({
      code: null,
    });
    expect(deviceAnswerOf({ state: "pending", kind: "phone" })).toBeUndefined();
  });

  it("reads a paired device as waiting until it is activated, then its view", () => {
    expect(deviceAnswerOf({ state: "paired", activated: false })).toEqual({ state: "waiting" });
    expect(
      deviceAnswerOf({
        state: "paired",
        activated: true,
        kind: "station",
        label: "Hall B TV",
        shut: null,
        event: { name: { ar: "ملتقى", en: null } },
        quest: { title: { en: "Hall B" }, points: 10 },
      }),
    ).toEqual({
      state: "paired",
      view: {
        kind: "station",
        label: "Hall B TV",
        shut: null,
        event: { name: { ar: "ملتقى", en: null } },
        quest: { title: { ar: null, en: "Hall B" }, points: 10 },
        scenes: null,
        terms: DEFAULT_TERMS,
      },
    });
    expect(deviceAnswerOf({ state: "paired", activated: true, kind: "screen" })).toMatchObject({
      view: { kind: "screen", quest: null, label: "", shut: null, scenes: null },
    });
    expect(
      deviceAnswerOf({
        state: "paired",
        activated: true,
        kind: "screen",
        scenes: ["poll", "photos", "ranking"],
      }),
    ).toMatchObject({ view: { scenes: ["poll", "ranking"] } });
    const gems = {
      currency: {
        icon: "gem",
        ar: { one: "جوهرة", many: "جواهر" },
        en: { one: "gem", many: "gems" },
      },
    };
    expect(
      deviceAnswerOf({ state: "paired", activated: true, kind: "screen", terms: gems }),
    ).toMatchObject({ view: { terms: { currency: { icon: "gem", en: { many: "gems" } } } } });
    expect(deviceAnswerOf(null)).toBeUndefined();
    expect(deviceAnswerOf({ state: "gone" })).toBeUndefined();
  });

  it("reads a screen code, or why there is none", () => {
    expect(
      screenCodeOf({
        state: "open",
        code: "c",
        url: "https://x/s/c",
        changesInMs: 1200,
        quest: { title: { en: "Hall" }, points: 5 },
      }),
    ).toEqual({
      state: "open",
      url: "https://x/s/c",
      changesInMs: 1200,
      quest: { title: { ar: null, en: "Hall" }, points: 5 },
    });
    expect(screenCodeOf({ state: "paused", quest: null })).toEqual({
      state: "shut",
      shut: "paused",
      quest: null,
    });
    expect(screenCodeOf({ state: "open" })).toBeUndefined();
    expect(screenCodeOf("x")).toBeUndefined();
  });

  it("names every shut reason, and an unknown one as not available now", () => {
    expect(shutKey("paused")).toBe("device.shut.paused");
    expect(shutKey("method_off")).toBe("device.shut.methodOff");
    expect(shutKey("not_started")).toBe("device.shut.notStarted");
    expect(shutKey("ended")).toBe("device.shut.ended");
    expect(shutKey("event_ended")).toBe("device.shut.eventEnded");
    expect(shutKey("hidden")).toBe("device.shut.hidden");
    expect(shutKey("anything")).toBe("device.shut.hidden");
  });
});

describe("the device page's timing and addresses (T-309)", () => {
  it("puts the pairing code in the fragment, without its dash", () => {
    expect(pairUrl("https://app.questify.sa", "ar", "ABCD-EFGH")).toBe(
      "https://app.questify.sa/ar/pair#ABCDEFGH",
    );
    expect(devicePagePath("screen", "en")).toBe("/en/screen");
    expect(devicePagePath("station", "ar")).toBe("/ar/station");
    expect(devicePagePath("kiosk", "ar")).toBe("/ar/kiosk");
  });

  it("polls every 3 seconds, 5 once slowed down", () => {
    expect(pollDelayMs(false)).toBe(3000);
    expect(pollDelayMs(true)).toBe(5000);
  });

  it("asks for the next code when this one changes plus up to 1.5 s of jitter", () => {
    expect(nextCodeDelayMs(10_000, 0)).toBe(10_000);
    expect(nextCodeDelayMs(10_000, 0.999)).toBe(11_498);
    expect(nextCodeDelayMs(-5, 2)).toBe(1500);
    expect(nextCodeDelayMs(100, -1)).toBe(100);
  });

  it("keeps a code up only until 15 seconds after it changed", () => {
    expect(codeGraceMs(10_000)).toBe(25_000);
    expect(codeGraceMs(-1)).toBe(15_000);
  });
});
