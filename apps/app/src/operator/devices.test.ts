import { describe, expect, it } from "vitest";
import type { AuthedResult } from "#src/api/session.ts";
import {
  claimDevice,
  codeGraceMs,
  deviceStatusKey,
  devicesPageOf,
  fetchScreenCode,
  nextCodeDelayMs,
  pairingCodeOf,
  previewDevice,
  revokeDevice,
  scannedPairingCode,
  shutKey,
} from "#src/operator/devices.ts";

const EVENT = "e1";
const STAGING = "https://questify-web-staging-4ecphq.cranl.net";

/** A session that answers every request with `answer` and keeps what was asked. */
function session(answer: AuthedResult) {
  const asked: unknown[] = [];
  return {
    asked,
    request: async (request: unknown) => {
      asked.push(request);
      return answer;
    },
  };
}
const ok = (body: unknown): AuthedResult => ({ kind: "ok", status: 200, body }) as AuthedResult;
const refused = (code: string): AuthedResult =>
  ({
    kind: "error",
    status: 409,
    code,
    message: { ar: "ع", en: "e" },
    details: {},
  }) as AuthedResult;

describe("pairing codes in staff mode (T-309)", () => {
  it("normalises a typed code and refuses the excluded letters", () => {
    expect(pairingCodeOf("abcd-efgh")).toBe("ABCDEFGH");
    expect(pairingCodeOf(" AB CD EF GH ")).toBe("ABCDEFGH");
    expect(pairingCodeOf("ABCDEFG0")).toBeUndefined();
    expect(pairingCodeOf("ABCDEFGO")).toBeUndefined();
    expect(pairingCodeOf("ABCDEFG")).toBeUndefined();
  });

  it("reads a pairing page's QR only on a Questify host or the build's extra one", () => {
    expect(scannedPairingCode("https://questify.nafes.com/ar/pair#ABCDEFGH", null)).toBe(
      "ABCDEFGH",
    );
    expect(scannedPairingCode(`${STAGING}/en/pair#abcdefgh`, STAGING)).toBe("ABCDEFGH");
    for (const text of [
      `${STAGING}/en/pair#ABCDEFGH`,
      "https://evil.example/ar/pair#ABCDEFGH",
      "http://questify.nafes.com/ar/pair#ABCDEFGH",
      "https://questify.nafes.com/ar/pair?ABCDEFGH",
      "https://questify.nafes.com/ar/pair#ABCDEFG0",
      "https://questify.nafes.com/fr/pair#ABCDEFGH",
      "ABCDEFGH",
    ]) {
      expect(scannedPairingCode(text, null), text).toBeNull();
    }
  });
});

describe("the operator's device calls (T-309)", () => {
  it("previews a code and reads the kind and client", async () => {
    const one = session(ok({ kind: "station", client: "Chrome on Android", expiresAt: "t" }));
    expect(await previewDevice(one, EVENT, "ABCDEFGH")).toEqual({
      kind: "preview",
      preview: { kind: "station", client: "Chrome on Android" },
    });
    expect(one.asked[0]).toMatchObject({
      method: "POST",
      path: "/v1/operator/events/e1/devices/preview",
      body: { code: "ABCDEFGH" },
    });
    expect(await previewDevice(session(ok({ kind: "phone" })), EVENT, "x")).toEqual({
      kind: "network",
    });
    expect(await previewDevice(session(refused("unknown_code")), EVENT, "x")).toMatchObject({
      kind: "refused",
      code: "unknown_code",
    });
  });

  it("claims with the caller's key, and revokes", async () => {
    const one = session(ok({ id: "d1" }));
    const claim = { code: "ABCDEFGH", kind: "station" as const, questId: "q1", label: "TV" };
    expect(await claimDevice(one, EVENT, claim, "k1")).toEqual({ kind: "paired", id: "d1" });
    expect(one.asked[0]).toMatchObject({ body: claim, headers: { "idempotency-key": "k1" } });
    expect(await claimDevice(session(ok({})), EVENT, claim, "k")).toEqual({ kind: "network" });
    expect(await claimDevice(session({ kind: "signed_out" }), EVENT, claim, "k")).toEqual({
      kind: "signed_out",
    });
    const two = session(ok(undefined));
    expect(await revokeDevice(two, EVENT, "d1")).toEqual({ kind: "revoked" });
    expect(two.asked[0]).toMatchObject({ path: "/v1/operator/events/e1/devices/d1/revoke" });
  });

  it("reads the devices page, dropping what it cannot read", () => {
    expect(
      devicesPageOf({
        devices: [
          {
            id: "d1",
            kind: "station",
            label: "TV",
            quest: { en: "Hall" },
            status: "active",
            paused: true,
          },
          { id: "d2", kind: "phone" },
          { id: "d3", kind: "screen", status: "revoked" },
        ],
        quests: [{ id: "q1", title: { ar: "قاعة" }, points: 10 }, { title: {} }],
      }),
    ).toEqual({
      devices: [
        {
          id: "d1",
          kind: "station",
          label: "TV",
          quest: { ar: null, en: "Hall" },
          status: "active",
          paused: true,
        },
        { id: "d3", kind: "screen", label: "", quest: null, status: "revoked", paused: false },
      ],
      quests: [{ id: "q1", title: { ar: "قاعة", en: null }, points: 10 }],
    });
    expect(devicesPageOf(null)).toEqual({ devices: [], quests: [] });
  });

  it("reads a screen code, or why none is shown", async () => {
    expect(
      await fetchScreenCode(
        session(ok({ state: "open", url: "u", changesInMs: 900 })),
        EVENT,
        "q1",
      ),
    ).toEqual({ kind: "code", url: "u", changesInMs: 900 });
    expect(await fetchScreenCode(session(ok({ state: "paused" })), EVENT, "q1")).toEqual({
      kind: "shut",
      shut: "paused",
    });
    expect(await fetchScreenCode(session(ok({ state: "open" })), EVENT, "q1")).toEqual({
      kind: "network",
    });
    expect(await fetchScreenCode(session(refused("ability_off")), EVENT, "q1")).toMatchObject({
      code: "ability_off",
    });
  });
});

describe("the rotating code's timing and words (T-309)", () => {
  it("asks again when the code changes plus up to 1.5 s, and keeps it 15 s past its change", () => {
    expect(nextCodeDelayMs(1000, 0)).toBe(1000);
    expect(nextCodeDelayMs(1000, 1)).toBe(2500);
    expect(nextCodeDelayMs(-1, -1)).toBe(0);
    expect(codeGraceMs(1000)).toBe(16_000);
  });

  it("names every shut reason and every device status", () => {
    expect(shutKey("paused")).toBe("device.shut.paused");
    expect(shutKey("method_off")).toBe("device.shut.methodOff");
    expect(shutKey("not_started")).toBe("device.shut.notStarted");
    expect(shutKey("ended")).toBe("device.shut.ended");
    expect(shutKey("event_ended")).toBe("device.shut.eventEnded");
    expect(shutKey("other")).toBe("device.shut.hidden");
    const device = { id: "d", kind: "station" as const, label: "", quest: null, paused: false };
    expect(deviceStatusKey({ ...device, status: "active" })).toBe("devices.status.active");
    expect(deviceStatusKey({ ...device, status: "active", paused: true })).toBe(
      "devices.status.paused",
    );
    expect(deviceStatusKey({ ...device, status: "ended" })).toBe("devices.status.ended");
    expect(deviceStatusKey({ ...device, status: "revoked" })).toBe("devices.status.revoked");
  });
});
