import { createVerify, generateKeyPairSync, type KeyObject } from "node:crypto";
import { constants } from "node:http2";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ApnsSettings } from "#src/config";
import {
  APNS_HOLD_MS,
  APNS_ORIGINS,
  APNS_TOKEN_REFRESH_MS,
  apnsResult,
  createApnsProvider,
  createApnsToken,
} from "#src/push/apns";
import type { PushMessage, PushProvider, PushResult } from "#src/push/provider";
import { startH2Server, type FakeH2, type Reply } from "#test/support/h2-server";

const DEVICE = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
const message: PushMessage = {
  token: DEVICE,
  collapseId: "n42",
  priority: "high",
  expiresAt: new Date("2030-01-01T12:00:00Z"),
  title: "Flash quest — مهمة سريعة",
  body: "Ends at 18:30",
  channel: "personal",
  threadId: "11111111-2222-3333-4444-555555555555",
  data: { n: "42", k: "join_decision", e: "", r: "{}" },
};

const decode = (segment: string | undefined): Record<string, unknown> =>
  JSON.parse(Buffer.from(segment ?? "", "base64url").toString("utf8")) as Record<string, unknown>;

const soon = (ms = 2000): Date => new Date(Date.now() + ms);

/** An answer with a status and no body. */
const bare = (status: number): PushResult =>
  apnsResult({ kind: "answer", status, headers: {}, body: "" });

const accept = (): Reply => ({ status: 200 });

const hold = (code: string): PushResult => ({ kind: "hold", code, holdMs: APNS_HOLD_MS });

let settings: ApnsSettings;
let publicKey: KeyObject;

beforeAll(() => {
  const pair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  settings = {
    keyId: "ABC123DEFG",
    teamId: "DEF123GHIJ",
    privateKey: pair.privateKey,
    topic: "app.questify.mobile",
  };
  publicKey = pair.publicKey;
});

describe("createApnsToken", () => {
  it("signs an ES256 JWT with the key id, the team and the time in seconds, verifiable with the key", () => {
    const token = createApnsToken(settings, () => 1_700_000_000_500).current();
    const [header, claims, signature] = token.split(".");
    expect(decode(header)).toEqual({ alg: "ES256", kid: "ABC123DEFG" });
    expect(decode(claims)).toEqual({ iss: "DEF123GHIJ", iat: 1_700_000_000 });
    const raw = Buffer.from(signature ?? "", "base64url");
    expect(raw).toHaveLength(64);
    const valid = createVerify("SHA256")
      .update(`${header}.${claims}`)
      .verify({ key: publicKey, dsaEncoding: "ieee-p1363" }, raw);
    expect(valid).toBe(true);
  });

  it("keeps one token for 40 minutes, then signs a new one", () => {
    let clock = 1_700_000_000_000;
    const token = createApnsToken(settings, () => clock);
    const first = token.current();
    clock += APNS_TOKEN_REFRESH_MS - 1;
    expect(token.current()).toBe(first);
    clock += 1;
    const second = token.current();
    expect(second).not.toBe(first);
    expect(decode(second.split(".")[1])["iat"]).toBe(1_700_000_000 + 40 * 60);
  });

  it("renews once for a stale token and hands later callers the same new one", () => {
    let clock = 1_700_000_000_000;
    const token = createApnsToken(settings, () => clock);
    const stale = token.current();
    clock += 1000;
    const renewed = token.renew(stale);
    expect(renewed).not.toBe(stale);
    clock += 1000;
    expect(token.renew(stale)).toBe(renewed);
    expect(token.current()).toBe(renewed);
  });

  it("stops the start when the key cannot sign, naming the setting and never the key", () => {
    const pem = settings.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    let error: unknown;
    try {
      createApnsToken({ ...settings, privateKey: publicKey });
    } catch (caught) {
      error = caught;
    }
    expect(String((error as Error).message)).toBe(
      "APNS_PRIVATE_KEY could not sign the APNs provider token.",
    );
    expect(String((error as Error).message)).not.toContain(pem.slice(40, 80));
  });
});

describe("apnsResult without a network", () => {
  it("maps a request never written to requeue, uncounted, and a lost one to unknown", () => {
    expect(apnsResult({ kind: "not_sent", code: "ECONNREFUSED" })).toEqual({
      kind: "requeue",
      code: "ECONNREFUSED",
      written: false,
    });
    expect(apnsResult({ kind: "lost", code: "timeout" })).toEqual({
      kind: "unknown",
      code: "timeout",
    });
  });

  it("reads a Retry-After on a 5xx and ignores a reason that is not a plain word", () => {
    const now = Date.parse("2030-01-01T00:00:00Z");
    expect(
      apnsResult(
        {
          kind: "answer",
          status: 503,
          headers: { "retry-after": "Tue, 01 Jan 2030 00:00:04 GMT" },
          body: JSON.stringify({ reason: "ServiceUnavailable" }),
        },
        now,
      ),
    ).toEqual({ kind: "requeue", code: "ServiceUnavailable", written: true, retryAfterMs: 4000 });
    expect(
      apnsResult({
        kind: "answer",
        status: 400,
        headers: {},
        body: JSON.stringify({ reason: `token ${DEVICE}` }),
      }),
    ).toEqual({ kind: "failed", code: "http_400" });
    expect(apnsResult({ kind: "answer", status: 400, headers: {}, body: "not json" })).toEqual({
      kind: "failed",
      code: "http_400",
    });
  });

  it("removes the device on any 410 and holds on any 403, whatever the reason", () => {
    expect(bare(410)).toEqual({ kind: "invalid_token", code: "http_410", ambiguous: false });
    expect(bare(403)).toEqual({ kind: "hold", code: "http_403", holdMs: APNS_HOLD_MS });
    expect(bare(405)).toEqual({ kind: "failed", code: "http_405" });
    expect(bare(500)).toEqual({ kind: "requeue", code: "http_500", written: true });
  });
});

describe("the APNs client against a local HTTP/2 server", () => {
  let server: FakeH2;
  let next: (index: number) => Reply = accept;
  let provider: PushProvider;
  let logs: Array<Record<string, unknown>>;

  beforeAll(async () => {
    server = await startH2Server(() => next(server.seen.length - 1));
  });

  afterAll(async () => {
    await server.close();
  });

  const fresh = (): PushProvider => {
    logs = [];
    provider = createApnsProvider({
      target: "apns:sandbox",
      token: createApnsToken(settings),
      topic: settings.topic,
      log: (_level, fields) => logs.push(fields),
      origin: server.origin,
    });
    return provider;
  };

  afterEach(async () => {
    await provider.close();
    server.seen.length = 0;
    next = accept;
  });

  it("posts the alert to /3/device/<token> with Apple's headers and the bearer token", async () => {
    expect(await fresh().send(message, soon())).toEqual({ kind: "sent" });
    const [request] = server.seen;
    expect(request?.path).toBe(`/3/device/${DEVICE}`);
    expect(request?.headers[":method"]).toBe("POST");
    expect(request?.headers).toMatchObject({
      "apns-push-type": "alert",
      "apns-topic": "app.questify.mobile",
      "apns-priority": "10",
      "apns-expiration": String(Date.parse("2030-01-01T12:00:00Z") / 1000),
      "apns-collapse-id": "n42",
    });
    const authorization = String(request?.headers["authorization"]);
    expect(authorization).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    expect(decode(authorization.split(" ")[1]?.split(".")[0])).toEqual({
      alg: "ES256",
      kid: "ABC123DEFG",
    });
    expect(JSON.parse(request?.body ?? "")).toMatchObject({
      aps: { alert: { title: message.title, body: message.body }, "thread-id": message.threadId },
      q: message.data,
    });
  });

  it("knows Apple's two hosts", () => {
    expect(APNS_ORIGINS).toEqual({
      "apns:production": "https://api.push.apple.com",
      "apns:sandbox": "https://api.sandbox.push.apple.com",
    });
  });

  const rows: Array<[number, string, PushResult]> = [
    [410, "Unregistered", { kind: "invalid_token", code: "Unregistered", ambiguous: false }],
    [410, "ExpiredToken", { kind: "invalid_token", code: "ExpiredToken", ambiguous: false }],
    [400, "BadDeviceToken", { kind: "invalid_token", code: "BadDeviceToken", ambiguous: true }],
    [
      400,
      "DeviceTokenNotForTopic",
      { kind: "invalid_token", code: "DeviceTokenNotForTopic", ambiguous: true },
    ],
    [403, "InvalidProviderToken", hold("InvalidProviderToken")],
    [403, "MissingProviderToken", hold("MissingProviderToken")],
    [403, "Forbidden", hold("Forbidden")],
    [403, "BadEnvironmentKeyIdInToken", hold("BadEnvironmentKeyIdInToken")],
    [403, "UnrelatedKeyIdInToken", hold("UnrelatedKeyIdInToken")],
    [400, "BadTopic", hold("BadTopic")],
    [400, "TopicDisallowed", hold("TopicDisallowed")],
    [400, "MissingTopic", hold("MissingTopic")],
    [429, "TooManyProviderTokenUpdates", hold("TooManyProviderTokenUpdates")],
    [413, "PayloadTooLarge", { kind: "failed", code: "PayloadTooLarge" }],
    [400, "BadCollapseId", { kind: "failed", code: "BadCollapseId" }],
    [400, "BadExpirationDate", { kind: "failed", code: "BadExpirationDate" }],
    [400, "BadPriority", { kind: "failed", code: "BadPriority" }],
    [400, "PayloadEmpty", { kind: "failed", code: "PayloadEmpty" }],
    [404, "BadPath", { kind: "failed", code: "BadPath" }],
    [429, "TooManyRequests", { kind: "failed", code: "TooManyRequests" }],
    [503, "Shutdown", { kind: "requeue", code: "Shutdown", written: false }],
    [400, "IdleTimeout", { kind: "requeue", code: "IdleTimeout", written: false }],
    [500, "InternalServerError", { kind: "requeue", code: "InternalServerError", written: true }],
    [503, "ServiceUnavailable", { kind: "requeue", code: "ServiceUnavailable", written: true }],
  ];

  it.each(rows)("maps %i %s", async (status, reason, expected) => {
    next = () => ({ status, body: { reason, timestamp: 1_700_000_000_000 } });
    expect(await fresh().send(message, soon())).toEqual(expected);
  });

  it("logs a refusal that is our own bug with the status and reason only, and never a device's 429", async () => {
    next = () => ({ status: 413, body: { reason: "PayloadTooLarge" } });
    await fresh().send(message, soon());
    expect(logs).toEqual([
      { event: "push.apns_refused", target: "apns:sandbox", status: 413, code: "PayloadTooLarge" },
    ]);
    next = () => ({ status: 429, body: { reason: "TooManyRequests" } });
    await provider.send(message, soon());
    expect(logs).toHaveLength(1);
  });

  it.each([
    ["Shutdown", 503],
    ["IdleTimeout", 400],
    ["UnrelatedKeyIdInToken", 403],
  ])("opens a new connection after %s", async (reason, status) => {
    const before = server.sessions();
    next = (index) => (index === 0 ? { status, body: { reason } } : { status: 200 });
    fresh();
    await provider.send(message, soon());
    expect(await provider.send(message, soon())).toEqual({ kind: "sent" });
    expect(server.seen.map((one) => one.session)).toEqual([before + 1, before + 2]);
  });

  it("signs a new token once after ExpiredProviderToken and sends again", async () => {
    next = (index) =>
      index === 0 ? { status: 403, body: { reason: "ExpiredProviderToken" } } : { status: 200 };
    expect(await fresh().send(message, soon())).toEqual({ kind: "sent" });
    const [first, second] = server.seen.map((one) => String(one.headers["authorization"]));
    expect(server.seen).toHaveLength(2);
    expect(second).not.toBe(first);
  });

  it("holds the target when the fresh token is called expired too", async () => {
    next = () => ({ status: 403, body: { reason: "ExpiredProviderToken" } });
    expect(await fresh().send(message, soon())).toEqual(hold("ExpiredProviderToken"));
    expect(server.seen).toHaveLength(2);
  });

  it("reuses one connection for every send", async () => {
    const before = server.sessions();
    fresh();
    for (let sent = 0; sent < 5; sent += 1) {
      expect(await provider.send(message, soon())).toEqual({ kind: "sent" });
    }
    await Promise.all([1, 2, 3].map(() => provider.send(message, soon())));
    expect(server.sessions()).toBe(before + 1);
  });

  it("requeues a stream above a GOAWAY's last stream id, and reconnects for the next send", async () => {
    const before = server.sessions();
    next = (index) =>
      index === 1 ? { goaway: constants.NGHTTP2_NO_ERROR } : { status: 200, delayMs: 50 };
    fresh();
    const results = await Promise.all([
      provider.send(message, soon()),
      provider.send({ ...message, collapseId: "n43" }, soon()),
    ]);
    expect(results).toEqual([
      { kind: "sent" },
      { kind: "requeue", code: "goaway", written: false },
    ]);
    expect(await provider.send(message, soon())).toEqual({ kind: "sent" });
    expect(server.seen.at(-1)?.session).toBe(before + 2);
  });

  it("answers unknown for a stream at or below the last id of a GOAWAY with an error", async () => {
    next = (index) =>
      index === 1 ? { goaway: constants.NGHTTP2_INTERNAL_ERROR, last: 1 } : { hang: true };
    fresh();
    const results = await Promise.all([
      provider.send(message, soon()),
      provider.send({ ...message, collapseId: "n43" }, soon()),
    ]);
    expect(results).toEqual([
      { kind: "unknown", code: "reset" },
      { kind: "requeue", code: "goaway", written: false },
    ]);
  });

  it("requeues a REFUSED_STREAM without counting it, on a new connection next time", async () => {
    const before = server.sessions();
    next = (index) => (index === 0 ? { reset: constants.NGHTTP2_REFUSED_STREAM } : { status: 200 });
    expect(await fresh().send(message, soon())).toEqual({
      kind: "requeue",
      code: "refused_stream",
      written: false,
    });
    expect(await provider.send(message, soon())).toEqual({ kind: "sent" });
    expect(server.seen.at(-1)?.session).toBe(before + 2);
  });

  it("answers unknown when the stream is reset after the request was written", async () => {
    next = () => ({ reset: constants.NGHTTP2_INTERNAL_ERROR });
    expect(await fresh().send(message, soon())).toEqual({ kind: "unknown", code: "reset" });
    expect(server.seen).toHaveLength(1);
  });

  it("gives up a slow answer at its deadline as unknown", async () => {
    next = () => ({ status: 200, delayMs: 2000 });
    const started = Date.now();
    expect(await fresh().send(message, soon(400))).toEqual({ kind: "unknown", code: "timeout" });
    expect(Date.now() - started).toBeLessThan(400 + 150);
  });

  it("never waits past its 10-second limit when the worker's deadline is later", async () => {
    next = () => ({ hang: true });
    fresh();
    const result = provider.send(message, new Date(Date.now() + 60_000));
    const timeout = await Promise.race([
      result,
      new Promise((resolve) => setTimeout(() => resolve("still waiting"), 10_600)),
    ]);
    expect(timeout).toEqual({ kind: "unknown", code: "timeout" });
  }, 15_000);

  it("never writes past the stream limit the server sets, and waits for a stream until the deadline", async () => {
    const narrow = await startH2Server(() => ({ status: 200, delayMs: 100 }), {
      maxConcurrentStreams: 1,
    });
    const capped = createApnsProvider({
      target: "apns:production",
      token: createApnsToken(settings),
      topic: settings.topic,
      log: () => undefined,
      origin: narrow.origin,
    });
    const results = await Promise.all([1, 2, 3].map(() => capped.send(message, soon())));
    expect(results).toEqual([{ kind: "sent" }, { kind: "sent" }, { kind: "sent" }]);
    expect(narrow.maxOpen()).toBe(1);
    const late = await Promise.all([
      capped.send(message, soon(2000)),
      capped.send(message, soon(250)),
    ]);
    expect(late).toEqual([{ kind: "sent" }, { kind: "requeue", code: "deadline", written: false }]);
    await capped.close();
    await narrow.close();
  });

  it("keeps at most 50 streams in flight on one connection", async () => {
    next = () => ({ status: 200, delayMs: 150 });
    fresh();
    const results = await Promise.all(
      Array.from({ length: 60 }, () => provider.send(message, soon(5000))),
    );
    expect(results.every((one) => one.kind === "sent")).toBe(true);
    expect(server.maxOpen()).toBeLessThanOrEqual(50);
  });

  it("requeues without counting when the connection is refused, by the deadline", async () => {
    const gone = await startH2Server(() => ({ status: 200 }));
    await gone.close();
    const offline = createApnsProvider({
      target: "apns:production",
      token: createApnsToken(settings),
      topic: settings.topic,
      log: () => undefined,
      origin: gone.origin,
    });
    const result = await offline.send(message, soon(1000));
    expect(result).toMatchObject({ kind: "requeue", written: false });
    await offline.close();
    expect(await offline.send(message, soon())).toEqual({
      kind: "requeue",
      code: "closed",
      written: false,
    });
  });

  it("puts no token, key or push text in a result or a log line", async () => {
    const answers: Reply[] = [
      { status: 413, body: { reason: "PayloadTooLarge" } },
      { status: 400, body: { reason: DEVICE } },
      { status: 410, body: { reason: "Unregistered" } },
      { reset: constants.NGHTTP2_INTERNAL_ERROR },
    ];
    next = (index) => answers[index] ?? { status: 200 };
    fresh();
    const results: PushResult[] = [];
    for (const _ of answers) results.push(await provider.send(message, soon()));
    const bearer = String(server.seen[0]?.headers["authorization"]).split(" ")[1] ?? "";
    const pem = settings.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const written = JSON.stringify({ results, logs });
    for (const secret of [DEVICE, bearer, message.title, message.body, pem.slice(30, 70)]) {
      expect(written).not.toContain(secret);
    }
  });
});
