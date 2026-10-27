import { describe, expect, it } from "vitest";
import { createTargetState } from "#src/push/targets";

const make = () => {
  let now = 0;
  const logged: string[] = [];
  const state = createTargetState(
    () => now,
    (fields) => logged.push(`${fields.event}:${fields.target}:${fields.code}`),
  );
  return { state, logged, at: (ms: number) => (now = ms) };
};
const failTimes = (state: ReturnType<typeof make>["state"], n: number) => {
  for (let i = 0; i < n; i += 1) state.failure("fcm");
};

describe("createTargetState (ADR-345 (5))", () => {
  it("10 consecutive 503: target held 30 s, then 60 s, doubling to 15 min at most; a 200 resets", () => {
    const { state, logged, at } = make();
    failTimes(state, 9);
    expect(state.held("fcm")).toBe(false);
    state.failure("fcm");
    expect(state.held("fcm")).toBe(true);
    at(29_999);
    expect(state.held("fcm")).toBe(true);
    at(30_000);
    expect(state.held("fcm")).toBe(false);
    failTimes(state, 10);
    at(30_000 + 59_999);
    expect(state.held("fcm")).toBe(true);
    at(30_000 + 60_000);
    expect(state.held("fcm")).toBe(false);
    for (let trip = 2; trip < 12; trip += 1) failTimes(state, 10);
    const capped = 90_000 + 15 * 60_000;
    at(capped - 1);
    expect(state.held("fcm")).toBe(true);
    at(capped);
    expect(state.held("fcm")).toBe(false);
    state.success("fcm");
    failTimes(state, 10);
    at(capped + 29_999);
    expect(state.held("fcm")).toBe(true);
    at(capped + 30_000);
    expect(state.held("fcm")).toBe(false);
    expect(logged[0]).toBe("push.provider_hold:fcm:breaker");
  });

  it("a success clears the count of failures", () => {
    const { state } = make();
    failTimes(state, 9);
    state.success("fcm");
    failTimes(state, 9);
    expect(state.held("fcm")).toBe(false);
  });

  it("holds each target on its own: a sandbox hold leaves production available", () => {
    const { state, at } = make();
    state.hold("apns:sandbox", 900_000, "BadEnvironmentKeyIdInToken");
    expect(state.available(["apns:production", "apns:sandbox", "fcm"])).toEqual([
      "apns:production",
      "fcm",
    ]);
    state.hold("apns:sandbox", 1000, "breaker");
    at(1000);
    expect(state.held("apns:sandbox")).toBe(true);
    at(900_000);
    expect(state.available(["apns:sandbox"])).toEqual(["apns:sandbox"]);
  });
});
