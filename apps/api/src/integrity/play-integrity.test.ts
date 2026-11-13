import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { payloadReasons } from "#src/integrity/play-integrity";
import {
  TEST_PACKAGE,
  fakePlayIntegrity,
  goodPayload,
  startPlayFake,
  type PlayFake,
} from "#test/support/play-integrity-fake";

const CHALLENGE = "AQAAAAB" + "x".repeat(43);

describe("Play Integrity verdicts (T-812)", () => {
  const now = 1_800_000_000_000;
  const reasons = (change: Parameters<typeof goodPayload>[1]) =>
    payloadReasons(goodPayload(CHALLENGE, change, now)["tokenPayloadExternal"], {
      packageName: TEST_PACKAGE,
      challenge: CHALLENGE,
      now,
    });

  it("passes a recognized app on a device that meets integrity, by nonce or by request hash", () => {
    expect(reasons({})).toEqual([]);
    expect(reasons({ requestDetails: { nonce: undefined, requestHash: CHALLENGE } })).toEqual([]);
    expect(reasons({ requestDetails: { nonce: `${CHALLENGE}==` } })).toEqual([]);
    expect(
      reasons({
        deviceIntegrity: {
          deviceRecognitionVerdict: ["MEETS_BASIC_INTEGRITY", "MEETS_DEVICE_INTEGRITY"],
        },
      }),
    ).toEqual([]);
  });

  it("names every way a verdict fails", () => {
    expect(
      reasons({ deviceIntegrity: { deviceRecognitionVerdict: ["MEETS_BASIC_INTEGRITY"] } }),
    ).toEqual(["device"]);
    expect(reasons({ deviceIntegrity: { deviceRecognitionVerdict: undefined } })).toEqual([
      "device",
    ]);
    expect(reasons({ appIntegrity: { appRecognitionVerdict: "UNRECOGNIZED_VERSION" } })).toEqual([
      "app",
    ]);
    expect(reasons({ appIntegrity: { packageName: "com.other" } })).toEqual(["package"]);
    expect(reasons({ requestDetails: { requestPackageName: "com.other" } })).toEqual(["package"]);
    expect(reasons({ requestDetails: { nonce: "someone-elses" } })).toEqual(["nonce"]);
    expect(reasons({ requestDetails: { timestampMillis: String(now - 11 * 60_000) } })).toEqual([
      "stale",
    ]);
    expect(reasons({ requestDetails: { timestampMillis: String(now + 2 * 60_000) } })).toEqual([
      "stale",
    ]);
    expect(reasons({ requestDetails: { timestampMillis: "soon" } })).toEqual(["stale"]);
    expect(
      payloadReasons(undefined, { packageName: TEST_PACKAGE, challenge: CHALLENGE, now }),
    ).toEqual(["package", "nonce", "stale", "app", "device"]);
  });
});

describe("Play Integrity over HTTP, against a local fake of Google (T-812)", () => {
  let fake: PlayFake;
  beforeAll(async () => {
    fake = await startPlayFake();
  });
  afterAll(async () => {
    await fake.close();
  });
  beforeEach(() => {
    fake.calls.length = 0;
  });

  it("decodes the token with a bearer token at the package's address and reads the verdict", async () => {
    fake.answer({ status: 200, body: goodPayload(CHALLENGE) });
    const verdict = await fakePlayIntegrity(fake).decide("the-token", CHALLENGE);
    expect(verdict).toEqual({ kind: "verdict", passed: true, reasons: [] });
    expect(fake.calls).toEqual([
      {
        path: `/v1/${TEST_PACKAGE}:decodeIntegrityToken`,
        bearer: expect.stringMatching(/^Bearer access-/),
        token: "the-token",
      },
    ]);
  });

  it("fails a token Google calls invalid (400), and a failed device", async () => {
    fake.answer({ status: 400, body: { error: { status: "INVALID_ARGUMENT" } } });
    expect(await fakePlayIntegrity(fake).decide("forged", CHALLENGE)).toEqual({
      kind: "verdict",
      passed: false,
      reasons: ["token"],
    });
    fake.answer({
      status: 200,
      body: goodPayload(CHALLENGE, { deviceIntegrity: { deviceRecognitionVerdict: [] } }),
    });
    expect(await fakePlayIntegrity(fake).decide("rooted", CHALLENGE)).toEqual({
      kind: "verdict",
      passed: false,
      reasons: ["device"],
    });
  });

  it("asks once more after a 5xx and gives no verdict when Google still does not answer", async () => {
    fake.answer({ status: 503, body: {} }, { status: 200, body: goodPayload(CHALLENGE) });
    expect(await fakePlayIntegrity(fake).decide("t", CHALLENGE)).toMatchObject({
      kind: "verdict",
      passed: true,
    });
    expect(fake.calls).toHaveLength(2);
    fake.calls.length = 0;
    fake.answer({ status: 500, body: { error: { status: "INTERNAL" } } });
    expect(await fakePlayIntegrity(fake).decide("t", CHALLENGE)).toEqual({
      kind: "unavailable",
      why: "500_INTERNAL",
    });
    expect(fake.calls).toHaveLength(2);
  });

  it("gets a new access token after a 401, and stops on a refusal of our account (403)", async () => {
    fake.answer({ status: 401, body: {} }, { status: 200, body: goodPayload(CHALLENGE) });
    const play = fakePlayIntegrity(fake);
    const before = fake.tokenRequests();
    expect(await play.decide("t", CHALLENGE)).toMatchObject({ kind: "verdict", passed: true });
    expect(fake.tokenRequests() - before).toBe(2);
    fake.calls.length = 0;
    fake.answer({ status: 403, body: { error: { status: "PERMISSION_DENIED" } } });
    expect(await play.decide("t", CHALLENGE)).toEqual({
      kind: "unavailable",
      why: "403_PERMISSION_DENIED",
    });
    expect(fake.calls).toHaveLength(1);
  });

  it("times out a call that hangs, and gives no verdict", async () => {
    fake.answer({ hang: true });
    const started = Date.now();
    expect(await fakePlayIntegrity(fake, 150).decide("t", CHALLENGE)).toEqual({
      kind: "unavailable",
      why: "unreachable",
    });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("gives no verdict when Google's token address cannot be reached", async () => {
    const gone = await startPlayFake();
    await gone.close();
    expect(await fakePlayIntegrity(gone, 300).decide("t", CHALLENGE)).toEqual({
      kind: "unavailable",
      why: "token_unreachable",
    });
  });
});
