import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { clientDataHashOf } from "#src/integrity/app-attest";
import { startApp, type TestApp } from "#test/support/auth-app";
import {
  TEST_APP_ID,
  makeAssertion,
  makeAttestation,
  testChain,
  type Attestation,
} from "#test/support/app-attest";
import {
  fakePlayIntegrity,
  goodPayload,
  startPlayFake,
  type PlayFake,
} from "#test/support/play-integrity-fake";
import { questifyFixture } from "#test/support/questify";
import { TEST_DATABASE_URL } from "#test/support/test-db";

type Fixture = Awaited<ReturnType<typeof questifyFixture>>;

/**
 * The device-integrity doors over HTTP (T-812, FR-334): off without keys exactly as before, a challenge bound to the
 * player and install, Play Integrity against a local fake of Google, App Attest with a test root, a failed phone
 * flagged on the team's Flags page while its player still scans, the answer never saying the verdict, nothing personal
 * in the logs, and the limits.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("device integrity over HTTP", () => {
  let f: Fixture;
  let on: TestApp;
  let off: TestApp;
  let play: PlayFake;
  let lines: string[];
  const chain = testChain();

  beforeAll(async () => {
    f = await questifyFixture();
    play = await startPlayFake();
    lines = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString());
        done();
      },
    });
    on = await startApp(
      f.db,
      { level: "info", stream },
      {},
      {
        integrity: {
          play: fakePlayIntegrity(play, 1000),
          appAttest: { appId: TEST_APP_ID, development: false, root: chain.root.cert },
        },
      },
    );
    off = await startApp(f.db);
  });
  afterAll(async () => {
    await on.close();
    await off.close();
    await play.close();
    await f.close();
  });
  beforeEach(() => {
    play.calls.length = 0;
  });

  const session = async (player: string): Promise<string> => {
    const token = randomBytes(32).toString("base64url");
    await f.owner(
      `INSERT INTO player_session (player_id, token_hash, expires_at)
       VALUES ($1, $2, now() + interval '1 hour')`,
      [player, createHash("sha256").update(token).digest()],
    );
    return token;
  };
  type Caller = Readonly<{ player: string; token: string; install: string }>;
  const caller = async (): Promise<Caller> => {
    const player = await f.newPlayer();
    return { player, token: await session(player), install: randomUUID() };
  };
  const post = (
    app: TestApp,
    who: Caller,
    url: string,
    payload: object,
    install: string | null = who.install,
  ) =>
    app.app.inject({
      method: "POST",
      url,
      headers: {
        authorization: `Bearer ${who.token}`,
        ...(install === null ? {} : { "x-device-id": install }),
      },
      payload,
    });
  const challenge = async (who: Caller, platform: "ios" | "android", app = on) => {
    const answer = await post(app, who, "/v1/me/device-integrity/challenge", { platform });
    expect(answer.statusCode).toBe(200);
    return answer.json<{ enabled: boolean; challenge?: string; expiresAt?: string }>();
  };
  const check = (who: Caller, payload: object, app = on) =>
    post(app, who, "/v1/me/device-integrity", payload);

  /** The player in a live event with one scan from their install. */
  const played = async (who: Caller): Promise<string> => {
    const event = await f.newEvent({ phase: "live" });
    const enrollment = await f.join(event, who.player);
    const [quest] = await f.owner<{ id: string }>(
      `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap, visible, type_config)
       SELECT $1, id, 'scan_qr', 'Lion', 10, 100, true, '{}' FROM category WHERE event_id = $1 LIMIT 1 RETURNING id`,
      [event],
    );
    await f.owner(
      `INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                     idempotency_key, device_id)
       SELECT organizer_id, id, $2, $3, 1, 'qr', $4, $5 FROM event WHERE id = $1`,
      [event, enrollment, quest?.id, randomUUID(), who.install],
    );
    return enrollment;
  };
  const flags = (enrollment: string) =>
    f.owner<{ kind: string; evidence: Record<string, unknown> }>(
      "SELECT kind, evidence FROM flag WHERE enrollment_id = $1 AND kind = 'device_integrity'",
      [enrollment],
    );

  it("answers enabled: false and records nothing without keys, as before T-812", async () => {
    const who = await caller();
    expect(await challenge(who, "android", off)).toEqual({ enabled: false });
    expect(await challenge(who, "ios", off)).toEqual({ enabled: false });
    const answer = await check(
      who,
      { platform: "android", challenge: "x".repeat(50), token: "t" },
      off,
    );
    expect(answer.json()).toEqual({ next: "done" });
    expect(
      await f.owner("SELECT 1 FROM device_check WHERE install_id = $1", [who.install]),
    ).toEqual([]);
  });

  it("refuses a caller without an install id, a stranger and a malformed body", async () => {
    const who = await caller();
    const bare = await post(
      on,
      who,
      "/v1/me/device-integrity/challenge",
      { platform: "ios" },
      null,
    );
    expect(bare.statusCode).toBe(400);
    const stranger = await on.app.inject({
      method: "POST",
      url: "/v1/me/device-integrity/challenge",
      payload: { platform: "ios" },
    });
    expect(stranger.statusCode).toBe(401);
    for (const body of [
      { platform: "web" },
      { platform: "android", challenge: "x" },
      { platform: "ios", challenge: "x", keyId: "a", attestation: "b", assertion: "c" },
      { platform: "ios", challenge: "x", keyId: "not base64!", assertion: "AAAA" },
    ]) {
      expect((await check(who, body)).statusCode, JSON.stringify(body)).toBe(400);
    }
  });

  it("passes a good Android phone, and flags a failed one without telling it or stopping its play", async () => {
    const good = await caller();
    const goodEnrollment = await played(good);
    const goodChallenge = (await challenge(good, "android")).challenge ?? "";
    expect(goodChallenge).toHaveLength(50);
    play.answer({ status: 200, body: goodPayload(goodChallenge) });
    expect(
      (
        await check(good, { platform: "android", challenge: goodChallenge, token: "good-token" })
      ).json(),
    ).toEqual({
      next: "done",
    });
    expect(await flags(goodEnrollment)).toEqual([]);

    const bad = await caller();
    const badEnrollment = await played(bad);
    const badChallenge = (await challenge(bad, "android")).challenge ?? "";
    play.answer({
      status: 200,
      body: goodPayload(badChallenge, {
        deviceIntegrity: { deviceRecognitionVerdict: ["MEETS_BASIC_INTEGRITY"] },
      }),
    });
    const answer = await check(bad, {
      platform: "android",
      challenge: badChallenge,
      token: "rooted-token",
    });
    expect(answer.statusCode).toBe(200);
    expect(answer.headers["cache-control"]).toBe("private, no-store");
    expect(answer.json()).toEqual({ next: "done" });
    const [flag] = await flags(badEnrollment);
    expect(flag?.evidence).toMatchObject({ platform: "android", reasons: ["device"] });

    const logged = lines.join("");
    for (const secret of [bad.install, bad.player, badChallenge, "rooted-token", good.install]) {
      expect(logged).not.toContain(secret);
    }
    expect(logged).toContain('"outcome":"failed"');
  });

  it("records nothing and answers later when Google does not answer, or the challenge is another install's", async () => {
    const who = await caller();
    const enrollment = await played(who);
    const made = (await challenge(who, "android")).challenge ?? "";
    play.answer({ status: 503, body: {} });
    expect((await check(who, { platform: "android", challenge: made, token: "t" })).json()).toEqual(
      { next: "later" },
    );
    const other = { ...who, install: randomUUID() };
    expect(
      (await check(other, { platform: "android", challenge: made, token: "t" })).json(),
    ).toEqual({
      next: "later",
    });
    expect(play.calls).toHaveLength(2);
    expect(await flags(enrollment)).toEqual([]);
    expect(
      await f.owner("SELECT 1 FROM device_check WHERE install_id = $1", [who.install]),
    ).toEqual([]);
  });

  const attestFor = async (who: Caller): Promise<Readonly<{ made: Attestation; text: string }>> => {
    const text = (await challenge(who, "ios")).challenge ?? "";
    const made = makeAttestation({ chain, clientDataHash: clientDataHashOf(text) });
    return { made, text };
  };

  describe("App Attest", () => {
    it("attests a key, then takes assertions with a rising counter, ignoring a byte-identical resend", async () => {
      const who = await caller();
      const enrollment = await played(who);
      const { made, text } = await attestFor(who);
      const keyId = made.keyId.toString("base64");
      expect(
        (
          await check(who, {
            platform: "ios",
            challenge: text,
            keyId,
            attestation: made.attestation.toString("base64"),
          })
        ).json(),
      ).toEqual({ next: "done" });
      const second = (await challenge(who, "ios")).challenge ?? "";
      const assertion = makeAssertion(made.key, clientDataHashOf(second), 1).toString("base64");
      expect(
        (await check(who, { platform: "ios", challenge: second, keyId, assertion })).json(),
      ).toEqual({
        next: "done",
      });
      expect(await flags(enrollment)).toEqual([]);
      const recorded = await f.owner("SELECT 1 FROM device_check WHERE install_id = $1", [
        who.install,
      ]);

      expect(
        (await check(who, { platform: "ios", challenge: second, keyId, assertion })).json(),
      ).toEqual({ next: "done" });
      expect(await flags(enrollment)).toEqual([]);
      expect(
        await f.owner("SELECT 1 FROM device_check WHERE install_id = $1", [who.install]),
      ).toEqual(recorded);
    });

    it("flags an assertion whose counter is below the stored one", async () => {
      const who = await caller();
      const enrollment = await played(who);
      const { made, text } = await attestFor(who);
      const keyId = made.keyId.toString("base64");
      await check(who, {
        platform: "ios",
        challenge: text,
        keyId,
        attestation: made.attestation.toString("base64"),
      });
      const send = async (counter: number) => {
        const next = (await challenge(who, "ios")).challenge ?? "";
        const assertion = makeAssertion(made.key, clientDataHashOf(next), counter).toString(
          "base64",
        );
        return (await check(who, { platform: "ios", challenge: next, keyId, assertion })).json();
      };
      expect(await send(5)).toEqual({ next: "done" });
      expect(await flags(enrollment)).toEqual([]);
      expect(await send(3)).toEqual({ next: "done" });
      const [flag] = await flags(enrollment);
      expect(flag?.evidence).toMatchObject({ platform: "ios", reasons: ["counter"] });
    });

    it("asks for a new attestation for a key it does not know, or one of another install", async () => {
      const who = await caller();
      const { made, text } = await attestFor(who);
      const keyId = made.keyId.toString("base64");
      await check(who, {
        platform: "ios",
        challenge: text,
        keyId,
        attestation: made.attestation.toString("base64"),
      });
      const elsewhere = { ...who, install: randomUUID() };
      const there = (await challenge(elsewhere, "ios")).challenge ?? "";
      const assertion = makeAssertion(made.key, clientDataHashOf(there), 1).toString("base64");
      expect(
        (await check(elsewhere, { platform: "ios", challenge: there, keyId, assertion })).json(),
      ).toEqual({
        next: "attest",
      });
      expect(
        (
          await check(who, {
            platform: "ios",
            challenge: (await challenge(who, "ios")).challenge ?? "",
            keyId: randomBytes(32).toString("base64"),
            assertion,
          })
        ).json(),
      ).toEqual({ next: "attest" });
    });

    it("flags an attestation that does not chain to the root", async () => {
      const who = await caller();
      const enrollment = await played(who);
      const text = (await challenge(who, "ios")).challenge ?? "";
      const made = makeAttestation({ chain: testChain(), clientDataHash: clientDataHashOf(text) });
      await check(who, {
        platform: "ios",
        challenge: text,
        keyId: made.keyId.toString("base64"),
        attestation: made.attestation.toString("base64"),
      });
      const [flag] = await flags(enrollment);
      expect(flag?.evidence).toMatchObject({ platform: "ios", reasons: ["chain"] });
      expect(
        await f.owner("SELECT 1 FROM app_attest_key WHERE install_id = $1", [who.install]),
      ).toEqual([]);
    });
  });

  it("holds each door to 10 an hour per player", async () => {
    const who = await caller();
    for (let i = 0; i < 10; i += 1) await challenge(who, "ios");
    const over = await post(on, who, "/v1/me/device-integrity/challenge", { platform: "ios" });
    expect(over.statusCode).toBe(429);
  });
});
