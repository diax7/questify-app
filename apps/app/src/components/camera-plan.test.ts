import { describe, expect, it } from "vitest";
import { cameraPlan } from "#src/components/camera-plan.ts";

type Permission = Readonly<{ granted: boolean; canAskAgain: boolean }> | null;

// The conditions the scanner and station screens held inline before the plan moved here.
const old = (permission: Permission, present: boolean, usable: boolean) => {
  const granted = permission?.granted === true;
  return {
    loading: present && permission === null,
    askShown: present && permission !== null && !granted,
    camera: present && granted && usable,
  };
};

const PERMISSIONS: readonly Permission[] = [
  null,
  { granted: true, canAskAgain: true },
  { granted: true, canAskAgain: false },
  { granted: false, canAskAgain: true },
  { granted: false, canAskAgain: false },
];

describe("cameraPlan", () => {
  it.each<[string, Permission, boolean, boolean, boolean, boolean | null, boolean]>([
    ["permission unread", null, true, true, true, null, false],
    ["permission unread, nothing to scan", null, false, true, false, null, false],
    ["granted and usable", { granted: true, canAskAgain: true }, true, true, false, null, true],
    ["granted, not usable", { granted: true, canAskAgain: true }, true, false, false, null, false],
    [
      "granted, nothing to scan",
      { granted: true, canAskAgain: true },
      false,
      true,
      false,
      null,
      false,
    ],
    [
      "denied, can ask again",
      { granted: false, canAskAgain: true },
      true,
      true,
      false,
      true,
      false,
    ],
    ["denied for good", { granted: false, canAskAgain: false }, true, true, false, false, false],
    [
      "denied, nothing to scan",
      { granted: false, canAskAgain: true },
      false,
      true,
      false,
      null,
      false,
    ],
  ])("%s", (_name, permission, present, usable, loading, canAskAgain, camera) => {
    expect(cameraPlan(permission, present, usable)).toEqual({
      loading,
      ask: canAskAgain === null ? null : { canAskAgain },
      camera,
    });
  });

  it("matches the old inline conditions for every combination", () => {
    for (const permission of PERMISSIONS) {
      for (const present of [true, false]) {
        for (const usable of [true, false]) {
          const plan = cameraPlan(permission, present, usable);
          const before = old(permission, present, usable);
          expect(plan.loading).toBe(before.loading);
          expect(plan.ask !== null).toBe(before.askShown);
          expect(plan.camera).toBe(before.camera);
        }
      }
    }
  });
});
