import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { constants } from "node:http2";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FcmSettings } from "#src/config";
import {
  createFcmProvider,
  FCM_HOLD_MS,
  FCM_ORIGIN,
  FCM_QUOTA_HOLD_MS,
  fcmError,
  fcmResult,
} from "#src/push/fcm";
import { fcmRequest } from "#src/push/message";
import type { PushMessage, PushProvider, PushResult } from "#src/push/provider";
import { startH2Server, type FakeH2, type Reply } from "#test/support/h2-server";

const TOKEN_URI = "https://oauth2.googleapis.test/token";
const DEVICE = "fcm-device-token:APA91bH_abcdefghijklmnopqrstuvwxyz0123456789";
const message: PushMessage = {
  token: DEVICE,
  collapseId: "n7",
  priority: "high",
  expiresAt: new Date("2030-01-01T12:00:00Z"),
  title: "Your request was accepted — تم قبول طلبك",
  body: "Open the event to start",
  channel: "personal",
  threadId: "questify",
  data: { n: "7", k: "join_decision", e: "", r: "{}" },
};

const soon = (ms = 2000): Date => new Date(Date.now() + ms);
const decode = (segment: string | undefined): Record<string, unknown> =>
  JSON.parse(Buffer.from(segment ?? "", "base64url").toString("utf8")) as Record<string, unknown>;

type TokenCall = Readonly<{ assertion: string }>;

/** Google's token endpoint (the network is the boundary): answers in order, then a fresh token each time. */
function tokenEndpoint(answers: Array<() => Response | Promise<Response>> = []) {
  const calls: TokenCall[] = [];
  const fake = (async (_url: string | URL, init?: RequestInit) => {
    calls.push({ assertion: new URLSearchParams(String(init?.body)).get("assertion") ?? "" });
    const answer = answers.shift();
    return answer === undefined
      ? Response.json({ access_token: `ya29.token-${calls.length}`, expires_in: 3600 })
      : answer();
  }) as typeof fetch;
  return { fetch: fake, calls };
}

const fcmBody = (code: number, status: string, details: unknown[], text = "refused") => ({
  error: { code, message: text, status, details },
});
const fcmDetail = (errorCode: string) => ({
  "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
  errorCode,
});

/** A token answer that comes after 1.5 s. */
const slowToken = () =>
  new Promise<Response>((resolve) => {
    setTimeout(() => resolve(Response.json({ access_token: "late", expires_in: 3600 })), 1500);
  });

const hold = (code: string, holdMs = FCM_HOLD_MS): PushResult => ({ kind: "hold", code, holdMs });

const accepted = (): Reply => ({ status: 200, body: { name: "projects/x/messages/1" } });

/** Lets the background token request at start finish. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 20));

let settings: FcmSettings;
let rsa: KeyObject;

beforeAll(() => {
  rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  settings = {
    projectId: "questify-test",
    key: {
      clientEmail: "push@questify-test.iam.gserviceaccount.com",
      privateKey: rsa,
      tokenUri: TOKEN_URI,
    },
  };
});

describe("fcmError and fcmResult without a network", () => {
  it("reads FCM's own code, Google's status and whether the token is named, and nothing else", () => {
    expect(
      fcmError(JSON.stringify(fcmBody(404, "NOT_FOUND", [fcmDetail("UNREGISTERED")]))),
    ).toEqual({ errorCode: "UNREGISTERED", status: "NOT_FOUND", tokenNamed: false });
    expect(fcmError("<html>")).toEqual({ errorCode: null, status: null, tokenNamed: false });
    expect(fcmError(JSON.stringify({ error: { status: `bad ${DEVICE}` } }))).toEqual({
      errorCode: null,
      status: null,
      tokenNamed: false,
    });
  });

  it("maps a request never written to requeue, a lost one to unknown, a bare 5xx to requeue", () => {
    expect(fcmResult({ kind: "not_sent", code: "connect_failed" })).toEqual({
      kind: "requeue",
      code: "connect_failed",
      written: false,
    });
    expect(fcmResult({ kind: "lost", code: "reset" })).toEqual({ kind: "unknown", code: "reset" });
    expect(fcmResult({ kind: "answer", status: 502, headers: {}, body: "" })).toEqual({
      kind: "requeue",
      code: "http_502",
      written: true,
    });
    expect(fcmResult({ kind: "answer", status: 404, headers: {}, body: "" })).toEqual({
      kind: "failed",
      code: "http_404",
    });
  });
});

describe("the FCM client against a local HTTP/2 server", () => {
  let server: FakeH2;
  let next: (index: number) => Reply = accepted;
  let provider: PushProvider;
  let logs: Array<Record<string, unknown>>;
  let google: ReturnType<typeof tokenEndpoint>;

  beforeAll(async () => {
    server = await startH2Server(() => next(server.seen.length - 1));
  });

  afterAll(async () => {
    await server.close();
  });

  const fresh = (
    tokens: Array<() => Response | Promise<Response>> = [],
    now?: () => number,
  ): PushProvider => {
    logs = [];
    google = tokenEndpoint(tokens);
    provider = createFcmProvider({
      settings,
      log: (_level, fields) => logs.push(fields),
      origin: server.origin,
      fetch: google.fetch,
      ...(now === undefined ? {} : { now }),
    });
    return provider;
  };

  afterEach(async () => {
    await provider.close();
    server.seen.length = 0;
    next = accepted;
  });

  it("asks for a firebase.messaging token at start and posts messages:send with it", async () => {
    fresh();
    await settled();
    expect(google.calls).toHaveLength(1);
    const claims = decode(google.calls[0]?.assertion.split(".")[1]);
    expect(claims).toMatchObject({
      iss: "push@questify-test.iam.gserviceaccount.com",
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: TOKEN_URI,
    });
    expect(claims).not.toHaveProperty("sub");
    expect(await provider.send(message, soon())).toEqual({ kind: "sent" });
    const [request] = server.seen;
    expect(request?.path).toBe("/v1/projects/questify-test/messages:send");
    expect(request?.headers["authorization"]).toBe("Bearer ya29.token-1");
    expect(request?.headers["content-type"]).toBe("application/json");
    const sent = JSON.parse(request?.body ?? "") as { message: { android: unknown } };
    const expected = JSON.parse(fcmRequest(message, new Date())) as {
      message: { android: unknown };
    };
    expect({ ...sent.message, android: undefined }).toEqual({
      ...expected.message,
      android: undefined,
    });
    expect(sent.message.android).toMatchObject({
      priority: "HIGH",
      notification: { tag: "n7", channel_id: "personal" },
    });
    expect(FCM_ORIGIN).toBe("https://fcm.googleapis.com");
  });

  it("keeps the token until 5 minutes before it ends, then asks again", async () => {
    let clock = 1_700_000_000_000;
    fresh([], () => clock);
    await settled();
    await provider.send(message, soon());
    clock += (3600 - 300 - 1) * 1000;
    await provider.send(message, soon());
    expect(google.calls).toHaveLength(1);
    clock += 1000;
    await provider.send(message, soon());
    expect(google.calls).toHaveLength(2);
    expect(server.seen.at(-1)?.headers["authorization"]).toBe("Bearer ya29.token-2");
  });

  it("asks for a new token once after a 401 and sends again", async () => {
    next = (index) =>
      index === 0
        ? { status: 401, body: fcmBody(401, "UNAUTHENTICATED", []) }
        : { status: 200, body: {} };
    fresh();
    await settled();
    expect(await provider.send(message, soon())).toEqual({ kind: "sent" });
    expect(server.seen.map((one) => one.headers["authorization"])).toEqual([
      "Bearer ya29.token-1",
      "Bearer ya29.token-2",
    ]);
  });

  it("holds 15 minutes when the new token is refused too, alerting once and sending nothing meanwhile", async () => {
    next = () => ({ status: 401, body: fcmBody(401, "UNAUTHENTICATED", []) });
    fresh();
    await settled();
    expect(await provider.send(message, soon())).toEqual({
      kind: "hold",
      code: "fcm_auth",
      holdMs: FCM_HOLD_MS,
    });
    const after = await provider.send(message, soon());
    expect(after).toMatchObject({ kind: "hold", code: "fcm_auth" });
    expect(server.seen).toHaveLength(2);
    expect(logs).toEqual([{ event: "push.fcm_auth_failed", status: 401, code: "UNAUTHENTICATED" }]);
  });

  it("holds when Google refuses the service account at start, before any send", async () => {
    fresh([() => Response.json({ error: "invalid_grant" }, { status: 400 })]);
    await settled();
    expect(logs).toEqual([{ event: "push.fcm_auth_failed", status: 400, code: "invalid_grant" }]);
    const result = await provider.send(message, soon());
    expect(result).toMatchObject({ kind: "hold", code: "fcm_auth" });
    expect(server.seen).toHaveLength(0);
  });

  it("logs an unreachable Google at start and asks again on the next send", async () => {
    fresh([
      () => {
        throw new TypeError("fetch failed");
      },
    ]);
    await settled();
    expect(logs).toEqual([{ event: "push.fcm_auth_failed", status: null, code: "unreachable" }]);
    expect(await provider.send(message, soon())).toEqual({ kind: "sent" });
    expect(google.calls).toHaveLength(2);
  });

  it("requeues untried when the token cannot be had: unreachable, a 5xx, or not by the deadline", async () => {
    fresh([
      () => {
        throw new TypeError("fetch failed");
      },
      () => {
        throw new TypeError("fetch failed");
      },
      () => Response.json({ error: "backend_error" }, { status: 503 }),
      slowToken,
    ]);
    await settled();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      expect(await provider.send(message, soon())).toEqual({
        kind: "requeue",
        code: "token_unreachable",
        written: false,
      });
    }
    const started = Date.now();
    expect(await provider.send(message, soon(300))).toEqual({
      kind: "requeue",
      code: "token_timeout",
      written: false,
    });
    expect(Date.now() - started).toBeLessThan(300 + 150);
    expect(server.seen).toHaveLength(0);
  });

  const rows: Array<[string, Reply, PushResult]> = [
    [
      "404 UNREGISTERED",
      { status: 404, body: fcmBody(404, "NOT_FOUND", [fcmDetail("UNREGISTERED")]) },
      { kind: "invalid_token", code: "UNREGISTERED", ambiguous: false },
    ],
    [
      "403 SENDER_ID_MISMATCH",
      { status: 403, body: fcmBody(403, "PERMISSION_DENIED", [fcmDetail("SENDER_ID_MISMATCH")]) },
      { kind: "invalid_token", code: "SENDER_ID_MISMATCH", ambiguous: true },
    ],
    [
      "400 INVALID_ARGUMENT naming message.token",
      {
        status: 400,
        body: fcmBody(400, "INVALID_ARGUMENT", [
          {
            "@type": "type.googleapis.com/google.rpc.BadRequest",
            fieldViolations: [
              { field: "message.token", description: "Invalid registration token" },
            ],
          },
        ]),
      },
      { kind: "invalid_token", code: "INVALID_ARGUMENT", ambiguous: true },
    ],
    [
      "400 INVALID_ARGUMENT, not a valid FCM registration token",
      {
        status: 400,
        body: fcmBody(
          400,
          "INVALID_ARGUMENT",
          [fcmDetail("INVALID_ARGUMENT")],
          "The registration token is not a valid FCM registration token",
        ),
      },
      { kind: "invalid_token", code: "INVALID_ARGUMENT", ambiguous: true },
    ],
    [
      "400 INVALID_ARGUMENT on another field",
      {
        status: 400,
        body: fcmBody(400, "INVALID_ARGUMENT", [
          {
            "@type": "type.googleapis.com/google.rpc.BadRequest",
            fieldViolations: [{ field: "message.data[0].value", description: "Invalid value" }],
          },
        ]),
      },
      { kind: "failed", code: "INVALID_ARGUMENT" },
    ],
    [
      "403 PERMISSION_DENIED",
      { status: 403, body: fcmBody(403, "PERMISSION_DENIED", []) },
      hold("PERMISSION_DENIED"),
    ],
    [
      "429 QUOTA_EXCEEDED with Retry-After 120",
      {
        status: 429,
        headers: { "retry-after": "120" },
        body: fcmBody(429, "RESOURCE_EXHAUSTED", [fcmDetail("QUOTA_EXCEEDED")]),
      },
      hold("QUOTA_EXCEEDED", 120_000),
    ],
    [
      "429 QUOTA_EXCEEDED with Retry-After 5",
      {
        status: 429,
        headers: { "retry-after": "5" },
        body: fcmBody(429, "RESOURCE_EXHAUSTED", [fcmDetail("QUOTA_EXCEEDED")]),
      },
      hold("QUOTA_EXCEEDED", FCM_QUOTA_HOLD_MS),
    ],
    [
      "429 QUOTA_EXCEEDED without Retry-After",
      { status: 429, body: fcmBody(429, "RESOURCE_EXHAUSTED", [fcmDetail("QUOTA_EXCEEDED")]) },
      hold("QUOTA_EXCEEDED", FCM_QUOTA_HOLD_MS),
    ],
    [
      "500 INTERNAL",
      { status: 500, body: fcmBody(500, "INTERNAL", [fcmDetail("INTERNAL")]) },
      { kind: "requeue", code: "INTERNAL", written: true },
    ],
    [
      "503 UNAVAILABLE with Retry-After 3",
      {
        status: 503,
        headers: { "retry-after": "3" },
        body: fcmBody(503, "UNAVAILABLE", [fcmDetail("UNAVAILABLE")]),
      },
      { kind: "requeue", code: "UNAVAILABLE", written: true, retryAfterMs: 3000 },
    ],
  ];

  it.each(rows)("maps %s", async (_name, reply, expected) => {
    next = () => reply;
    fresh();
    await settled();
    expect(await provider.send(message, soon())).toEqual(expected);
  });

  it("logs a refusal that is our own bug with the status and code only", async () => {
    next = () => ({ status: 400, body: fcmBody(400, "INVALID_ARGUMENT", [], `bad ${DEVICE}`) });
    fresh();
    await settled();
    await provider.send(message, soon());
    expect(logs).toEqual([{ event: "push.fcm_refused", status: 400, code: "INVALID_ARGUMENT" }]);
  });

  it("answers unknown for a reset or a timeout after the write", async () => {
    next = (index) =>
      index === 0 ? { reset: constants.NGHTTP2_INTERNAL_ERROR } : { status: 200, delayMs: 2000 };
    fresh();
    await settled();
    expect(await provider.send(message, soon())).toEqual({ kind: "unknown", code: "reset" });
    expect(await provider.send(message, soon(400))).toEqual({ kind: "unknown", code: "timeout" });
  });

  it("puts no token, key or push text in a result or a log line", async () => {
    const answers: Reply[] = [
      { status: 400, body: fcmBody(400, "INVALID_ARGUMENT", [], `${DEVICE} ${message.title}`) },
      { status: 401, body: fcmBody(401, "UNAUTHENTICATED", []) },
      { status: 401, body: fcmBody(401, "UNAUTHENTICATED", []) },
    ];
    next = (index) => answers[index] ?? { status: 200 };
    fresh();
    await settled();
    const results = [await provider.send(message, soon()), await provider.send(message, soon())];
    const pem = rsa.export({ type: "pkcs8", format: "pem" }).toString();
    const written = JSON.stringify({ results, logs });
    for (const secret of [DEVICE, "ya29.token", message.title, message.body, pem.slice(40, 80)]) {
      expect(written).not.toContain(secret);
    }
  });
});
