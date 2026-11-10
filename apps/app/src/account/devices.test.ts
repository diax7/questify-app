import { describe, expect, it } from "vitest";
import type { ApiRequest } from "#src/api/client.ts";
import type { AuthedResult } from "#src/api/session.ts";
import { deviceLabelOf } from "#src/account/device-label.ts";
import {
  endDevices,
  loadDevices,
  otherDeviceCount,
  requestReauthCode,
  verifyReauthCode,
} from "#src/account/devices-api.ts";
import {
  codeChannels,
  daysSince,
  fallbackNameKey,
  devicesStep,
  startDevices,
  type Device,
  type DevicesState,
} from "#src/account/devices-flow.ts";

const headers = new Headers();
const MESSAGE = { ar: "رسالة", en: "Message" };
const ok = (body: unknown): AuthedResult => ({ kind: "ok", status: 200, body, headers });
const fail = (
  status: number,
  code: string,
  details: Record<string, unknown> = {},
): AuthedResult => ({
  kind: "error",
  status,
  code,
  message: MESSAGE,
  details,
  headers,
});

const HERE: Device = {
  id: "11111111-1111-4111-8111-111111111111",
  platform: "ios",
  model: "iPhone 15 Pro",
  signedInAt: "2026-11-01T10:00:00Z",
  lastUsedAt: "2026-11-05T10:00:00Z",
  current: true,
};
const OTHER: Device = {
  ...HERE,
  id: "22222222-2222-4222-8222-222222222222",
  model: null,
  current: false,
};

function setup(answer: AuthedResult) {
  const calls: Omit<ApiRequest, "accessToken">[] = [];
  const deps = {
    session: {
      request: async (request: Omit<ApiRequest, "accessToken">) => {
        calls.push(request);
        return answer;
      },
    },
    now: () => 1_000,
    newKey: () => "key-1",
  };
  return { deps, calls };
}

describe("the devices screen's steps (T-810c)", () => {
  const listed = devicesStep(startDevices, { type: "loaded", devices: [HERE, OTHER] });
  const one = { kind: "one", id: OTHER.id, name: "Android phone" } as const;

  it("goes list, confirm, code, confirm again, then a fresh list with the done note", () => {
    const confirming = devicesStep(listed, { type: "ask", target: one });
    expect(confirming).toMatchObject({ step: "confirm", target: one });
    const reauth = devicesStep(confirming, { type: "reauth_required" });
    expect(reauth).toMatchObject({ step: "reauth", sent: null });
    const sent = devicesStep(reauth, {
      type: "code_sent",
      challengeToken: "t",
      sentTo: "x",
      now: 5,
    });
    expect(sent).toMatchObject({ sent: { challengeToken: "t", resendAt: 60_005 } });
    const wrong = devicesStep(sent, { type: "wrong_code", attemptsLeft: 2, problem: MESSAGE });
    expect(wrong).toMatchObject({ attemptsLeft: 2, problem: MESSAGE });
    expect(devicesStep(wrong, { type: "code_expired", problem: MESSAGE })).toMatchObject({
      sent: null,
    });
    expect(devicesStep(wrong, { type: "confirmed" })).toMatchObject({
      step: "confirm",
      target: one,
    });
    const ended = devicesStep(wrong, { type: "ended", target: one });
    expect(ended).toEqual({ step: "loading", notice: "myDevices.doneOne" });
    expect(devicesStep(ended, { type: "loaded", devices: [HERE] })).toMatchObject({
      step: "list",
      notice: "myDevices.doneOne",
    });
  });

  it("shows the already-ended note when the device is gone, and ignores late answers", () => {
    expect(devicesStep(listed, { type: "gone" })).toEqual({
      step: "loading",
      notice: "myDevices.alreadyEnded",
    });
    expect(devicesStep(listed, { type: "reauth_required" })).toBe(listed);
    expect(
      devicesStep(listed, { type: "code_sent", challengeToken: "t", sentTo: "x", now: 1 }),
    ).toBe(listed);
    const failed: DevicesState = devicesStep(startDevices, {
      type: "load_failed",
      problem: MESSAGE,
    });
    expect(failed).toEqual({ step: "failed", problem: MESSAGE });
    expect(devicesStep(failed, { type: "ask", target: one })).toBe(failed);
    expect(
      devicesStep(devicesStep(listed, { type: "ask", target: one }), { type: "cancel" }),
    ).toMatchObject({
      step: "list",
    });
  });

  it("names a device by its model, else its platform, and counts calendar days", () => {
    expect(fallbackNameKey({ platform: "ios" })).toBe("myDevices.fallbackIos");
    expect(fallbackNameKey({ platform: "android" })).toBe("myDevices.fallbackAndroid");
    expect(fallbackNameKey({ platform: null })).toBe("myDevices.fallbackPhone");
    expect(daysSince(new Date(2026, 10, 4, 23, 59), new Date(2026, 10, 5, 0, 1))).toBe(1);
    expect(daysSince(new Date(2026, 10, 5, 8), new Date(2026, 10, 5, 22))).toBe(0);
    expect(codeChannels({ phone: "+9665••", email: null })).toEqual(["phone"]);
    expect(codeChannels({ phone: "+9665••", email: "a•@x.sa" })).toEqual(["phone", "email"]);
  });
});

describe("the devices calls", () => {
  it("lists, keeping only well-formed devices", async () => {
    const { deps } = setup(ok({ devices: [HERE, { id: 1 }], freshUntil: null }));
    expect(await loadDevices(deps)).toEqual({ type: "loaded", devices: [HERE] });
    expect(await otherDeviceCount(setup(ok({ devices: [HERE, OTHER] })).deps)).toBe(1);
    expect(await otherDeviceCount(setup({ kind: "network" }).deps)).toBe(0);
  });

  it("ends with an Idempotency-Key and reads each refusal", async () => {
    const done = setup(ok(undefined));
    expect(await endDevices(done.deps, { kind: "others" })).toEqual({
      type: "ended",
      target: { kind: "others" },
    });
    expect(done.calls[0]).toMatchObject({
      method: "POST",
      path: "/v1/me/devices/end-others",
      headers: { "idempotency-key": "key-1" },
    });
    const target = { kind: "one", id: OTHER.id, name: "x" } as const;
    expect(await endDevices(setup(fail(403, "reauth_required")).deps, target)).toEqual({
      type: "reauth_required",
    });
    expect(await endDevices(setup(fail(404, "not_found")).deps, target)).toEqual({ type: "gone" });
    expect(await endDevices(setup({ kind: "signed_out" }).deps, target)).toMatchObject({
      type: "refused",
    });
  });

  it("asks for a code and confirms it", async () => {
    const asked = setup(ok({ challengeToken: "t", sentTo: "+9665•••••12", expiresInSeconds: 300 }));
    expect(await requestReauthCode(asked.deps, { channel: "phone", lang: "ar" })).toEqual({
      type: "code_sent",
      challengeToken: "t",
      sentTo: "+9665•••••12",
      now: 1_000,
    });
    const verify = { challengeToken: "t", code: "123456" };
    expect(await verifyReauthCode(setup(ok({ freshUntil: "x" })).deps, verify)).toEqual({
      type: "confirmed",
    });
    expect(
      await verifyReauthCode(setup(fail(422, "invalid_code", { attemptsLeft: 1 })).deps, verify),
    ).toEqual({ type: "wrong_code", attemptsLeft: 1, problem: MESSAGE });
    expect(await verifyReauthCode(setup(fail(410, "challenge_expired")).deps, verify)).toEqual({
      type: "code_expired",
      problem: MESSAGE,
    });
  });
});

describe("the sign-in's device label", () => {
  it("sends the platform and a clean model, never more", async () => {
    expect(await deviceLabelOf("ios", async () => ({ modelName: " iPhone  15 Pro " }))).toEqual({
      platform: "ios",
      model: "iPhone 15 Pro",
    });
    expect(await deviceLabelOf("android", async () => ({ modelName: "Sara's phone" }))).toEqual({
      platform: "android",
    });
    expect(await deviceLabelOf("web", async () => ({ modelName: "x" }))).toEqual({
      platform: "web",
    });
    expect(await deviceLabelOf("windows", async () => ({ modelName: "x" }))).toBeUndefined();
  });

  it("sends the platform alone when expo-device cannot load", async () => {
    expect(
      await deviceLabelOf("android", async () => {
        throw new Error("not in this build");
      }),
    ).toEqual({ platform: "android" });
  });
});
