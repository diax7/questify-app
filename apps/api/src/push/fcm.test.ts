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
import { PROVIDER_MARGIN_MS } from "#src/push/send";
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
/** Whether a 400 with this one detail names the registration token. */
const namedBy = (detail: unknown): boolean =>
  fcmError(JSON.stringify(fcmBody(400, "INVALID_ARGUMENT", [detail]))).tokenNamed;

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

// Equivalent mutants left alive: fcmError's empty catch (the unparsed body reads as no error all the same), its `[]`
// fallback and message fallback (a stand-in is filtered out or names no token), bearerBy's clearTimeout (the late timer
// only settles a race already over), the `fetch` spread (the token source falls back to `fetch`), and the
// `kind === "answer"` checks around a status (a request never answered has no status, and only an answer fails).
describe("fcmError and fcmResult without a network", () => {
  const nothing = { errorCode: null, status: null, tokenNamed: false };

  it("reads FCM's own code, Google's status and whether the token is named, and nothing else", () => {
    expect(
      fcmError(JSON.stringify(fcmBody(404, "NOT_FOUND", [fcmDetail("UNREGISTERED")]))),
    ).toEqual({ errorCode: "UNREGISTERED", status: "NOT_FOUND", tokenNamed: false });
    expect(fcmError("<html>")).toEqual(nothing);
    expect(fcmError(JSON.stringify({ error: { status: `bad ${DEVICE}` } }))).toEqual(nothing);
  });

  it("reads nothing from a body of another shape, and codes only where Google puts them", () => {
    for (const body of ["null", "5", '"refused"', "{}", '{"error":null}']) {
      expect(fcmError(body), body).toEqual(nothing);
    }
    const otherDetail = {
      "@type": "type.googleapis.com/google.rpc.ErrorInfo",
      errorCode: "QUOTA_EXCEEDED",
    };
    expect(
      fcmError(
        JSON.stringify(
          fcmBody(404, "NOT_FOUND", [null, 5, "x", otherDetail, fcmDetail("UNREGISTERED")]),
        ),
      ),
    ).toEqual({ errorCode: "UNREGISTERED", status: "NOT_FOUND", tokenNamed: false });
    for (const [status, errorCode] of [
      [["NOT_FOUND"], ["UNREGISTERED"]],
      ["UNAVAILABLE now", "x UNREGISTERED"],
    ]) {
      const body = { error: { status, details: [{ ...fcmDetail(""), errorCode }] } };
      expect(fcmError(JSON.stringify(body))).toEqual(nothing);
    }
  });

  it("finds the token named only by a BadRequest violation on message.token", () => {
    const fieldViolations = [{ field: "message.data" }, { field: "message.token" }];
    expect(namedBy({ "@type": "type.googleapis.com/google.rpc.BadRequest", fieldViolations })).toBe(
      true,
    );
    expect(namedBy({ "@type": "type.googleapis.com/google.rpc.ErrorInfo", fieldViolations })).toBe(
      false,
    );
  });

  it("maps a request never written to requeue, a lost one to unknown, a bare 5xx to requeue", () => {
    expect(fcmResult({ kind: "not_sent", code: "connect_failed" })).toEqual({
      kind: "requeue",
      code: "connect_failed",
      written: false,
    });
    expect(fcmResult({ kind: "lost", code: "reset" })).toEqual({ kind: "unknown", code: "reset" });
    expect(fcmResult({ kind: "answer", status: 502, headers: {}, body: "" })).toStrictEqual({
      kind: "requeue",
      code: "http_502",
      written: true,
    });
    expect(fcmResult({ kind: "answer", status: 404, headers: {}, body: "" })).toEqual({
      kind: "failed",
      code: "http_404",
    });
  });

  it("holds on a bare 401, and takes a named token as invalid only on a 400", () => {
    expect(fcmResult({ kind: "answer", status: 401, headers: {}, body: "" })).toEqual(
      hold("http_401"),
    );
    const notValid = fcmBody(404, "NOT_FOUND", [], "not a valid FCM registration token");
    expect(
      fcmResult({ kind: "answer", status: 404, headers: {}, body: JSON.stringify(notValid) }),
    ).toEqual({ kind: "failed", code: "NOT_FOUND" });
  });
});

describe("the FCM client against a local HTTP/2 server", () => {
  let server: FakeH2;
  let next: (index: number) => Reply = accepted;
  let provider: PushProvider;
  let logs: Array<Record<string, unknown>>;
  let levels: string[];
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
    levels = [];
    google = tokenEndpoint(tokens);
    provider = createFcmProvider({
      settings,
      log: (level, fields) => {
        levels.push(level);
        logs.push(fields);
      },
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
    expect(levels).toEqual(["error"]);
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
    expect(levels).toEqual(["error"]);
    expect(await provider.send(message, soon())).toEqual({ kind: "sent" });
    expect(google.calls).toHaveLength(2);
  });

  it("waits for a slow token while the deadline allows", async () => {
    fresh([
      () => {
        throw new TypeError("fetch failed");
      },
      () =>
        new Promise<Response>((resolve) => {
          setTimeout(() => resolve(Response.json({ access_token: "slow", expires_in: 3600 })), 100);
        }),
    ]);
    await settled();
    expect(await provider.send(message, soon())).toEqual({ kind: "sent" });
    expect(server.seen[0]?.headers["authorization"]).toBe("Bearer slow");
  });

  it("requeues untried when no new token can be had after a 401", async () => {
    next = (index) =>
      index === 0 ? { status: 401, body: fcmBody(401, "UNAUTHENTICATED", []) } : accepted();
    fresh([
      () => Response.json({ access_token: "ya29.first", expires_in: 3600 }),
      () => {
        throw new TypeError("fetch failed");
      },
    ]);
    await settled();
    expect(await provider.send(message, soon())).toEqual({
      kind: "requeue",
      code: "token_unreachable",
      written: false,
    });
    expect(server.seen).toHaveLength(1);
  });

  it("alerts once for refusals that overlap, tells the hold left, and asks again when it ends", async () => {
    const start = 1_700_000_000_000;
    let clock = start;
    next = () => ({ status: 401, body: fcmBody(401, "UNAUTHENTICATED", []) });
    fresh([], () => clock);
    await settled();
    const both = await Promise.all([
      provider.send(message, soon()),
      provider.send(message, soon()),
    ]);
    expect(both).toEqual([hold("fcm_auth"), hold("fcm_auth")]);
    expect(logs).toHaveLength(1);
    clock += 60_000;
    expect(await provider.send(message, soon())).toEqual(hold("fcm_auth", FCM_HOLD_MS - 60_000));
    const asked = server.seen.length;
    clock = start + FCM_HOLD_MS;
    expect(await provider.send(message, soon())).toEqual(hold("fcm_auth"));
    expect(server.seen).toHaveLength(asked + 2);
    expect(levels).toEqual(["error", "error"]);
  });

  it("names the HTTP status when a refused token's answer carries no code", async () => {
    next = () => ({ status: 401 });
    fresh();
    await settled();
    expect(await provider.send(message, soon())).toEqual(hold("fcm_auth"));
    expect(logs).toEqual([{ event: "push.fcm_auth_failed", status: 401, code: "http_401" }]);
  });

  it("requeues untried once closed", async () => {
    fresh();
    await settled();
    await provider.close();
    expect(await provider.send(message, soon())).toEqual({
      kind: "requeue",
      code: "closed",
      written: false,
    });
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
    expect(Date.now() - started).toBeLessThan(300 + PROVIDER_MARGIN_MS);
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
      "429 QUOTA_EXCEEDED with Retry-After a day away, held 15 minutes at most",
      {
        status: 429,
        headers: { "retry-after": "86400" },
        body: fcmBody(429, "RESOURCE_EXHAUSTED", [fcmDetail("QUOTA_EXCEEDED")]),
      },
      hold("QUOTA_EXCEEDED", FCM_HOLD_MS),
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
    const refused = [expect.objectContaining({ event: "push.fcm_refused" })];
    expect(logs).toEqual(expected.kind === "failed" ? refused : []);
  });

  it("logs a refusal that is our own bug with the status and code only", async () => {
    next = () => ({ status: 400, body: fcmBody(400, "INVALID_ARGUMENT", [], `bad ${DEVICE}`) });
    fresh();
    await settled();
    await provider.send(message, soon());
    expect(logs).toEqual([{ event: "push.fcm_refused", status: 400, code: "INVALID_ARGUMENT" }]);
    expect(levels).toEqual(["error"]);
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
