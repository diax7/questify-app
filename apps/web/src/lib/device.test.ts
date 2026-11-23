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
  screenStepOf,
  shutKey,
  type HeldCode,
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
    expect(
      deviceAnswerOf({
        state: "paired",
        activated: true,
        kind: "screen",
        scenes: ["poll", "finale"],
      }),
    ).toMatchObject({ view: { scenes: ["poll", "finale"] } });
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

describe("the station's step for one screen-code answer (FR-314)", () => {
  const OPEN = { state: "open", url: "https://q.test/c/1", changesInMs: 10_000, quest: null };
  const held: HeldCode = {
    kind: "code",
    code: { state: "open", url: "https://q.test/c/0", changesInMs: 10_000, quest: null },
    at: 1000,
  };

  it("hands back to pairing when the device is no longer paired", () => {
    expect(screenStepOf({ ok: false, body: { code: "device_unpaired" } }, held, 2000, 0)).toEqual({
      restart: true,
    });
  });

  it("says the feature is off and asks again in 30 seconds, keeping what it holds", () => {
    expect(screenStepOf({ ok: false, body: { code: "feature_off" } }, held, 2000, 0)).toEqual({
      restart: false,
      shown: { kind: "off" },
      held,
      delayMs: 30_000,
    });
  });

  it("keeps the held code until its grace ends, then shows reconnecting", () => {
    const failed = { ok: false, body: undefined };
    expect(screenStepOf(failed, held, 25_999, 0)).toEqual({
      restart: false,
      shown: held,
      held,
      delayMs: 3000,
    });
    expect(screenStepOf(failed, held, 26_000, 0)).toEqual({
      restart: false,
      shown: { kind: "reconnecting" },
      held,
      delayMs: 3000,
    });
    expect(screenStepOf(failed, undefined, 2000, 0)).toMatchObject({
      shown: { kind: "reconnecting" },
      held: undefined,
    });
    expect(screenStepOf({ ok: true, body: { nonsense: 1 } }, undefined, 2000, 0)).toMatchObject({
      shown: { kind: "reconnecting" },
    });
  });

  it("shows a shut reason and drops the held code", () => {
    expect(
      screenStepOf({ ok: true, body: { state: "paused", quest: null } }, held, 2000, 0.5),
    ).toEqual({
      restart: false,
      shown: { kind: "shut", shut: "paused" },
      held: undefined,
      delayMs: 3000,
    });
  });

  it("holds a fresh code and asks again when it changes plus jitter", () => {
    const step = screenStepOf({ ok: true, body: OPEN }, undefined, 5000, 0.5);
    const fresh = { kind: "code", code: OPEN, at: 5000 };
    expect(step).toEqual({ restart: false, shown: fresh, held: fresh, delayMs: 10_750 });
  });
});
