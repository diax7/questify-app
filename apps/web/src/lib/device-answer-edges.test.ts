import { describe, expect, it } from "vitest";
import { deviceAnswerOf } from "#src/lib/device.ts";

describe("the device's answers, edges", () => {
  it("reads a pending page's code and expiry defensively", () => {
    expect(deviceAnswerOf({ state: "pending", kind: "screen", code: 5, expiresAt: null })).toEqual({
      state: "pending",
      kind: "screen",
      code: null,
      expiresAt: "",
    });
    expect(deviceAnswerOf({ state: "pending", kind: 3 })).toBeUndefined();
    expect(deviceAnswerOf({ kind: "screen" })).toBeUndefined();
    expect(deviceAnswerOf("paired")).toBeUndefined();
  });

  it("waits when a paired device is not activated or has no known kind", () => {
    const waiting = { state: "waiting" };
    expect(deviceAnswerOf({ state: "paired", activated: true })).toEqual(waiting);
    expect(deviceAnswerOf({ state: "paired", activated: true, kind: "phone" })).toEqual(waiting);
    expect(deviceAnswerOf({ state: "paired", activated: true, kind: 2 })).toEqual(waiting);
    expect(deviceAnswerOf({ state: "paired", activated: "yes", kind: "screen" })).toEqual(waiting);
    expect(deviceAnswerOf({ state: "paired", activated: false, kind: "screen" })).toEqual(waiting);
  });
});
