import { describe, expect, it } from "vitest";
import {
  checkInRead,
  explainAfterJoin,
  readingOf,
  scanReading,
  type Fix,
  type LocationReader,
  type Permission,
} from "#src/event/location.ts";

const NOW = 1_800_000_000_000;
const fix = (fields: Partial<Fix["coords"]> = {}, ageMs = 4000, mocked?: boolean): Fix => ({
  coords: { latitude: 24.7136, longitude: 46.6753, accuracy: 12, ...fields },
  timestamp: NOW - ageMs,
  ...(mocked === undefined ? {} : { mocked }),
});

/** A reader that records what it was asked, answering with a set permission and fixes. */
function reader(
  permission: Permission,
  options: Readonly<{
    current?: () => Promise<Fix>;
    lastKnown?: Fix | null;
    failPermission?: boolean;
  }> = {},
) {
  const calls: string[] = [];
  const made: LocationReader = {
    permission: async () => {
      calls.push("permission");
      if (options.failPermission === true) {
        throw new Error("native module gone");
      }
      return permission;
    },
    ask: async () => {
      calls.push("ask");
      return "granted";
    },
    current: () => {
      calls.push("current");
      return options.current?.() ?? Promise.resolve(fix());
    },
    lastKnown: async (maxAgeMs) => {
      calls.push(`lastKnown:${maxAgeMs}`);
      return options.lastKnown === undefined ? fix() : options.lastKnown;
    },
  };
  return { made, calls };
}

describe("readingOf", () => {
  it("turns a fix into the API's reading, its age in seconds and the mocked mark only when set", () => {
    expect(readingOf(fix(), NOW)).toEqual({ lat: 24.7136, lng: 46.6753, accuracyM: 12, ageS: 4 });
    expect(readingOf(fix({}, 0, true), NOW)).toMatchObject({ mocked: true, ageS: 0 });
    expect(readingOf(fix({}, 0, false), NOW)).not.toHaveProperty("mocked");
    expect(readingOf(fix({}, -3000), NOW)?.ageS).toBe(0);
  });

  it("gives nothing for a fix without a usable accuracy", () => {
    expect(readingOf(fix({ accuracy: null }), NOW)).toBeNull();
    expect(readingOf(fix({ accuracy: 0 }), NOW)).toBeNull();
  });
});

describe("checkInRead", () => {
  it("reads a fresh fix once allowed", async () => {
    const { made, calls } = reader("granted");
    expect(await checkInRead(made, () => NOW)).toEqual({
      kind: "position",
      position: { lat: 24.7136, lng: 46.6753, accuracyM: 12, ageS: 4 },
    });
    expect(calls).toEqual(["permission", "current"]);
  });

  it("never asks by itself: undetermined goes to the explanation, denied to the QR", async () => {
    const undetermined = reader("undetermined");
    expect(await checkInRead(undetermined.made, () => NOW)).toEqual({ kind: "ask" });
    expect(undetermined.calls).toEqual(["permission"]);
    expect(await checkInRead(reader("denied").made, () => NOW)).toEqual({ kind: "denied" });
  });

  it("gives up after the timeout, and reads a missing module or a failure as unavailable", async () => {
    const slow = reader("granted", { current: () => new Promise<Fix>(() => undefined) });
    expect(await checkInRead(slow.made, () => NOW, 10)).toEqual({ kind: "timeout" });
    expect(await checkInRead(null, () => NOW)).toEqual({ kind: "unavailable" });
    const broken = reader("granted", { current: () => Promise.reject(new Error("no fix")) });
    expect(await checkInRead(broken.made, () => NOW)).toEqual({ kind: "unavailable" });
    const gone = reader("granted", { failPermission: true });
    expect(await checkInRead(gone.made, () => NOW)).toEqual({ kind: "unavailable" });
    const vague = reader("granted", { current: () => Promise.resolve(fix({ accuracy: null })) });
    expect(await checkInRead(vague.made, () => NOW)).toEqual({ kind: "unavailable" });
  });
});

describe("scanReading", () => {
  it("adds the last known fix of the last 2 minutes once allowed, never a fresh one", async () => {
    const { made, calls } = reader("granted");
    expect(await scanReading(made, true, () => NOW)).toMatchObject({ accuracyM: 12 });
    expect(calls).toEqual(["permission", "lastKnown:120000"]);
  });

  it("adds nothing with the switch off, before the player allowed it or on any failure, and never asks", async () => {
    const off = reader("granted");
    expect(await scanReading(off.made, false, () => NOW)).toBeNull();
    expect(off.calls).toEqual([]);
    const undetermined = reader("undetermined");
    expect(await scanReading(undetermined.made, true, () => NOW)).toBeNull();
    expect(undetermined.calls).toEqual(["permission"]);
    expect(await scanReading(null, true, () => NOW)).toBeNull();
    expect(
      await scanReading(reader("granted", { lastKnown: null }).made, true, () => NOW),
    ).toBeNull();
    expect(
      await scanReading(reader("granted", { failPermission: true }).made, true, () => NOW),
    ).toBeNull();
  });
});

describe("explainAfterJoin", () => {
  const ready = {
    locationOn: true,
    locationPrompt: true,
    explained: false,
    permission: "undetermined" as Permission | null,
  };

  it("explains after joining an in-person event with a venue pin, before the player was asked", () => {
    expect(explainAfterJoin(ready)).toBe(true);
  });

  it("stays quiet with the switch off, a virtual or unpinned event, once shown, or once asked", () => {
    expect(explainAfterJoin({ ...ready, locationOn: false })).toBe(false);
    expect(explainAfterJoin({ ...ready, locationPrompt: false })).toBe(false);
    expect(explainAfterJoin({ ...ready, explained: true })).toBe(false);
    expect(explainAfterJoin({ ...ready, permission: "granted" })).toBe(false);
    expect(explainAfterJoin({ ...ready, permission: "denied" })).toBe(false);
    expect(explainAfterJoin({ ...ready, permission: null })).toBe(false);
  });
});
