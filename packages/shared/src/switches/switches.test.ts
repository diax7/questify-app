import { describe, expect, it } from "vitest";
import type { Registries } from "#src/config/registry";
import {
  buildSwitchesView,
  featureSwitchBodySchema,
  switchesViewSchema,
  tuningBodySchema,
} from "./switches";

const registries: Registries = {
  features: {
    shop: { gated: false },
    streak: { gated: false, level: "platform" },
    invites: { gated: false, level: "platform", offByDefault: true },
    screen: { gated: true },
  },
  tuning: {
    days: { default: 14, min: 1, max: 60, serverOnly: true },
    poll: { default: 10, min: 5, max: 60 },
  },
};
const message = { ar: "متوقفة", en: "Paused" };

describe("buildSwitchesView", () => {
  it("shows every feature and number with its default when nothing is stored", () => {
    const view = buildSwitchesView(registries, {});
    expect(switchesViewSchema.parse(view)).toEqual(view);
    expect(view.features.map((row) => [row.key, row.enabled, row.changed])).toEqual([
      ["invites", false, false],
      ["screen", true, false],
      ["shop", true, false],
      ["streak", true, false],
    ]);
    expect(view.features.find((row) => row.key === "streak")).toMatchObject({
      platformOnly: true,
      addOn: false,
    });
    expect(view.features.find((row) => row.key === "screen")?.addOn).toBe(true);
    expect(view.tuning).toEqual([
      { key: "days", value: 14, default: 14, min: 1, max: 60, changed: false, serverOnly: true },
      { key: "poll", value: 10, default: 10, min: 5, max: 60, changed: false, serverOnly: false },
    ]);
  });

  it("marks what differs from the default and shows the message only while off", () => {
    const view = buildSwitchesView(registries, {
      features: {
        shop: { enabled: false, message },
        invites: { enabled: true },
        streak: { enabled: true, message },
      },
      tuning: { poll: 20, days: 14 },
    });
    const row = (key: string) => view.features.find((r) => r.key === key);
    expect(row("shop")).toMatchObject({ enabled: false, changed: true, message });
    expect(row("invites")).toMatchObject({ enabled: true, changed: true, message: null });
    expect(row("streak")).toMatchObject({ enabled: true, changed: false, message: null });
    expect(view.tuning.map((r) => [r.key, r.value, r.changed])).toEqual([
      ["days", 14, false],
      ["poll", 20, true],
    ]);
  });

  it.each([4, 61, 7.5])(
    "shows the default for the stored number %s that nobody can use",
    (stored) => {
      const view = buildSwitchesView(registries, { tuning: { poll: stored } });
      expect(view.tuning.find((r) => r.key === "poll")).toMatchObject({
        value: 10,
        changed: false,
      });
    },
  );
});

describe("the bodies", () => {
  it("takes a switched-off feature with or without a message, and a switched-on one without", () => {
    expect(featureSwitchBodySchema.safeParse({ enabled: false, message }).success).toBe(true);
    expect(featureSwitchBodySchema.safeParse({ enabled: false, message: null }).success).toBe(true);
    expect(featureSwitchBodySchema.safeParse({ enabled: true, message: null }).success).toBe(true);
  });

  it.each([
    ["a message on a switched-on feature", { enabled: true, message }],
    ["one language only", { enabled: false, message: { ar: "متوقفة", en: " " } }],
    ["a missing message field", { enabled: false }],
    ["a long message", { enabled: false, message: { ar: "ا".repeat(301), en: "x" } }],
    ["an unknown field", { enabled: false, message: null, minAppVersion: "1.0" }],
    ["a control character", { enabled: false, message: { ar: "متوقفة", en: "Pa\u0000used" } }],
    ["a line break inside", { enabled: false, message: { ar: "متوقفة", en: "Pa\nused" } }],
    ["a direction override", { enabled: false, message: { ar: "‮متوقفة", en: "Paused" } }],
    ["a direction isolate", { enabled: false, message: { ar: "متوقفة", en: "Pa⁦used" } }],
  ])("refuses %s", (_name, body) => {
    expect(featureSwitchBodySchema.safeParse(body).success).toBe(false);
  });

  it("takes whole numbers only", () => {
    expect(tuningBodySchema.safeParse({ value: 12 }).success).toBe(true);
    expect(tuningBodySchema.safeParse({ value: 1.5 }).success).toBe(false);
    expect(tuningBodySchema.safeParse({ value: "12" }).success).toBe(false);
  });
});
