import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ATTRIBUTE_RULES, RESOURCE_KEYS } from "#src/telemetry/attributes";
import { instrumentEmail, instrumentPush, instrumentSms } from "#src/telemetry/outbound";
import { trackRun } from "#src/telemetry/runs";
import { pgError } from "#test/support/fake-pool";
import { buildLoggedApp, recordTelemetry, type Recording } from "#test/support/telemetry";

/** Values no signal may ever carry. Each is distinctive, so one occurrence anywhere is a leak. */
const SENTINELS = {
  username: "zz_sentinel_user",
  queryEmail: "sentinel.query@pii.test",
  bodyEmail: "sentinel.body@pii.test",
  phone: "+966555000111",
  bearer: "sentinel-bearer-token-9f3a",
  cookie: "sentinel-cookie-7c1d",
  address: "203.0.113.77",
  agent: "sentinel-agent/9.9",
  deviceId: "11111111-2222-4333-8444-555555555555",
  idempotencyKey: "sentinel-idem-key-42",
  smsText: "your sentinel code is 482913",
  pushToken: "sentinel-push-device-token",
};

let recording: Recording;
let app: FastifyInstance;
let lines: string[];

const failingPool = {
  connect: async () => {
    throw pgError({ code: "08006" });
  },
  query: async () => {
    throw pgError({ code: "08006" });
  },
} as unknown as Pool;

beforeEach(() => {
  recording = recordTelemetry();
});

afterEach(async () => {
  await app.close();
  await recording.shutdown();
});

async function driveTheServer(pool?: Pool): Promise<void> {
  ({ app, lines } = buildLoggedApp(pool));
  await app.ready();
  const headers = {
    authorization: `Bearer ${SENTINELS.bearer}`,
    cookie: `__Host-qs_session=${SENTINELS.cookie}`,
    "x-forwarded-for": SENTINELS.address,
    "user-agent": SENTINELS.agent,
    "x-device-id": SENTINELS.deviceId,
    "idempotency-key": SENTINELS.idempotencyKey,
    "content-type": "application/json",
  };
  await app.inject({
    method: "GET",
    url: `/v1/players/${SENTINELS.username}?email=${SENTINELS.queryEmail}`,
    headers,
  });
  await app.inject({
    method: "POST",
    url: "/v1/auth/code",
    headers,
    payload: { email: SENTINELS.bodyEmail },
  });
  await app.inject({
    method: "POST",
    url: "/v1/auth/code",
    headers,
    payload: { phone: SENTINELS.phone },
  });
  await app.inject({
    method: "POST",
    url: "/v1/staff/auth/password",
    headers,
    payload: { email: SENTINELS.bodyEmail, password: SENTINELS.cookie },
  });
  await app.inject({ method: "GET", url: `/${SENTINELS.username}/${SENTINELS.phone}`, headers });
  await app.inject({ method: "GET", url: "/healthz", headers });
}

async function driveTheProviders(): Promise<void> {
  const sms = instrumentSms(
    {
      name: "msegat",
      send: async () => ({ kind: "refused", reason: SENTINELS.phone }),
    },
    "msegat",
  );
  await sms.send({ to: SENTINELS.phone, text: SENTINELS.smsText });
  const email = instrumentEmail(
    {
      name: "gmail",
      send: async () => {
        throw new Error(`could not reach ${SENTINELS.bodyEmail}`);
      },
    },
    "gmail",
  );
  await email
    .send({ to: SENTINELS.bodyEmail, subject: "code", text: SENTINELS.smsText })
    .catch(() => undefined);
  const push = instrumentPush({
    target: "fcm",
    send: async () => ({ kind: "invalid_token", code: SENTINELS.pushToken, ambiguous: false }),
    close: async () => undefined,
  });
  await push.send(
    {
      token: SENTINELS.pushToken,
      collapseId: "n1",
      priority: "high",
      expiresAt: new Date(),
      title: SENTINELS.username,
      body: SENTINELS.smsText,
      channel: "personal",
      threadId: "questify",
      data: {},
    },
    new Date(),
  );
  await trackRun("community", async () => undefined);
}

describe("what leaves the machine", () => {
  it("holds no personal data after requests, refusals and failures carrying some", async () => {
    await driveTheServer();
    await driveTheProviders();
    const everything = await recording.everything();
    for (const [name, value] of Object.entries(SENTINELS)) {
      expect(everything, `${name} in a span or metric`).not.toContain(value);
    }
    expect(recording.spans().length).toBeGreaterThan(5);
  });

  it("holds none when the database fails too", async () => {
    await driveTheServer(failingPool);
    const everything = await recording.everything();
    for (const [name, value] of Object.entries(SENTINELS)) {
      expect(everything, `${name} in a span or metric`).not.toContain(value);
    }
    expect(JSON.stringify(recording.spans().map((span) => span.attributes))).toContain("500");
  });

  it("uses only attribute keys on the list, on every span and every metric point", async () => {
    await driveTheServer();
    await driveTheProviders();
    const allowed = new Set<string>(Object.keys(ATTRIBUTE_RULES));
    const spanKeys = recording.spans().flatMap((span) => Object.keys(span.attributes));
    const pointKeys = [...(await recording.metrics()).values()]
      .flat()
      .flatMap((point) => Object.keys(point.attributes));
    expect([...new Set([...spanKeys, ...pointKeys])].filter((key) => !allowed.has(key))).toEqual(
      [],
    );
    const resourceKeys = recording.spans().flatMap((span) => Object.keys(span.resource.attributes));
    const known = new Set<string>(RESOURCE_KEYS);
    expect(
      [...new Set(resourceKeys)].filter((key) => !known.has(key) && !key.startsWith("telemetry.")),
    ).toEqual([]);
  });

  it("puts no event on a span: nothing a handler passes can ride along", async () => {
    await driveTheServer();
    expect(recording.spans().flatMap((span) => span.events)).toEqual([]);
  });
});

describe("what is written to the log", () => {
  it("holds no personal data from the requests, with telemetry on", async () => {
    await driveTheServer();
    const written = lines.join("\n");
    expect(written).toContain("trace_id");
    for (const [name, value] of Object.entries(SENTINELS)) {
      expect(written, `${name} in a log line`).not.toContain(value);
    }
  });

  it("holds none when the database fails, and still names the request by its pattern", async () => {
    await driveTheServer(failingPool);
    const written = lines.join("\n");
    for (const [name, value] of Object.entries(SENTINELS)) {
      expect(written, `${name} in a log line`).not.toContain(value);
    }
    expect(written).toContain("/v1/players/:username");
  });
});
