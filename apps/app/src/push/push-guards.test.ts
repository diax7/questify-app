import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MESSAGES } from "@questify/shared";
import { describe, expect, it } from "vitest";

const PUSH_KEYS = Object.keys(MESSAGES).filter((key) =>
  /^(push\.(explain|channel)|notifications|pushSettings|pushTopics?)\./.test(key),
);

describe("the push texts", () => {
  it("exist (the filter found them)", () => {
    expect(PUSH_KEYS.length).toBeGreaterThan(30);
  });

  /** FR-1106 and Apple 5.1.1: allowing notifications is never rewarded, so no text may offer anything for it. */
  it("never offer a reward, points, gems or XP for allowing notifications", () => {
    for (const key of PUSH_KEYS.filter((k) => k.startsWith("push.explain."))) {
      const text = MESSAGES[key as keyof typeof MESSAGES];
      expect(text.en, key).not.toMatch(/reward|point|gem|\bxp\b|bonus/i);
      expect(text.ar, key).not.toMatch(/مكافأة|نقطة|نقاط|جوهر|جواهر/);
    }
  });

  it("avoid the Arabic calques the copy rules forbid, and use no emoji", () => {
    for (const key of PUSH_KEYS) {
      const text = MESSAGES[key as keyof typeof MESSAGES];
      expect(text.ar, key).not.toMatch(/(^|\s)تم(ت)?\s|قم بـ|بنجاح|—/u);
      expect(`${text.ar}${text.en}`, key).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });
});

const ROOT = join(import.meta.dirname, "..", "..").replaceAll("\\", "/");

const sources = ["app", "src"].flatMap((folder) =>
  readdirSync(join(ROOT, folder), { withFileTypes: true, recursive: true })
    .filter(
      (entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.includes(".test."),
    )
    .map((entry) =>
      join(entry.parentPath, entry.name)
        .replaceAll("\\", "/")
        .slice(ROOT.length + 1),
    ),
);

/** The app files (relative to the app folder) that import a module of the push folder. */
const importers = (target: string): string[] =>
  sources.filter((file) =>
    new RegExp(`from "#src/push/${target}\\.tsx?"`).test(readFileSync(join(ROOT, file), "utf8")),
  );

const outsidePush = (target: string): string[] =>
  importers(target).filter((file) => !file.startsWith("src/push/"));

/**
 * FR-1106: no code path reads the notification permission or the device to pay or open anything. The modules that read
 * either are imported only by the push folder and the sign-out hook; the explainer by the two join screens.
 */
describe("who may read the permission or the device", () => {
  it("is the push folder and the sign-out hook for the flow, the native layer and the hooks", () => {
    expect(importers("push-flow").length).toBeGreaterThan(3);
    for (const target of ["push-flow", "push-native", "use-permission", "use-push"]) {
      expect(
        outsidePush(target).filter((file) => file !== "src/auth/player.tsx"),
        target,
      ).toEqual([]);
    }
  });

  it("shows the explainer only on the two join screens", () => {
    expect(outsidePush("PushExplainer").sort()).toEqual([
      "app/invite/[eventId].tsx",
      "app/join/[code].tsx",
    ]);
  });
});

/**
 * A failed profile read publishes `me: undefined`, and screens gated on `me` (a daily game, the gem shop) then unmount.
 * The push code refreshes the bell with a one-row center read and never asks the player provider to reload.
 */
describe("what the push code may refresh", () => {
  const pushSources = sources.filter(
    (file) => file.startsWith("src/push/") && !file.includes(".test."),
  );

  it("never reloads the profile", () => {
    expect(pushSources.length).toBeGreaterThan(10);
    const offenders = pushSources.filter((file) =>
      /\breload\b|path:\s*["'`]\/v1\/me["'`]/.test(readFileSync(join(ROOT, file), "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});

describe("the line about messages that always arrive", () => {
  it("names decisions, answers and prizes in both languages", () => {
    expect(MESSAGES["pushTopics.always"].en).toMatch(/decisions, answers and prizes/i);
    expect(MESSAGES["pushTopics.always"].ar).toMatch(/القرارات والردود والجوائز/);
  });
});
