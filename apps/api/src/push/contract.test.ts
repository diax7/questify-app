import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApnsProvider, createApnsToken } from "#src/push/apns";
import { createFakeProvider } from "#src/push/fake";
import { createFcmProvider } from "#src/push/fcm";
import type { PushMessage, PushProvider, PushResult } from "#src/push/provider";
import { startH2Server, type FakeH2, type Reply } from "#test/support/h2-server";

/** What the far side does: accept, say the app is gone, fail with a 5xx, or never answer. */
type Scenario = "accept" | "uninstalled" | "outage" | "silent";

type Harness = Readonly<{
  provider: PushProvider;
  /** Makes the far side behave as `scenario` for the next send. */
  far: (scenario: Scenario) => void;
  teardown: () => Promise<void>;
}>;

const message: PushMessage = {
  token: "c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00",
  collapseId: "n9",
  priority: "normal",
  expiresAt: new Date("2030-01-01T12:00:00Z"),
  title: "Shop closes soon",
  body: "يغلق المتجر قريبًا",
  channel: "offers",
  threadId: "questify",
  data: { n: "9", k: "shop_closing", e: "", r: "{}" },
};

const EXPECTED: Readonly<Record<Exclude<Scenario, "silent">, PushResult["kind"]>> = {
  accept: "sent",
  uninstalled: "invalid_token",
  outage: "requeue",
};
const KINDS = new Set(["sent", "unknown", "requeue", "failed", "invalid_token", "hold"]);
const SILENT_DEADLINE_MS = 400;

/** A far side on a local HTTP/2 server, answering each scenario in the provider's own wire format. */
async function onServer(
  replies: Readonly<Record<Scenario, Reply>>,
  build: (server: FakeH2) => PushProvider,
): Promise<Harness> {
  let scenario: Scenario = "accept";
  const server = await startH2Server(() => replies[scenario]);
  const provider = build(server);
  return {
    provider,
    far: (next) => {
      scenario = next;
    },
    teardown: async () => {
      await provider.close();
      await server.close();
    },
  };
}

const harnesses: ReadonlyArray<readonly [string, () => Promise<Harness>]> = [
  [
    "the fake provider",
    () => {
      const fake = createFakeProvider("apns:production");
      const results: Readonly<Record<Exclude<Scenario, "silent">, PushResult>> = {
        accept: { kind: "sent" },
        uninstalled: { kind: "invalid_token", code: "Unregistered", ambiguous: false },
        outage: { kind: "requeue", code: "ServiceUnavailable", written: true },
      };
      return Promise.resolve({
        provider: fake,
        far: (scenario) => {
          fake.latencyMs = scenario === "silent" ? SILENT_DEADLINE_MS : 0;
          const result: PushResult =
            scenario === "silent" ? { kind: "unknown", code: "timeout" } : results[scenario];
          fake.script = [() => result];
        },
        teardown: () => fake.close(),
      });
    },
  ],
  [
    "the APNs client",
    () =>
      onServer(
        {
          accept: { status: 200 },
          uninstalled: { status: 410, body: { reason: "Unregistered", timestamp: 1 } },
          outage: { status: 503, body: { reason: "ServiceUnavailable" } },
          silent: { hang: true },
        },
        (server) => {
          const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey;
          return createApnsProvider({
            target: "apns:production",
            token: createApnsToken({
              keyId: "ABC123DEFG",
              teamId: "DEF123GHIJ",
              privateKey: key,
              topic: "app.questify.mobile",
            }),
            topic: "app.questify.mobile",
            log: () => undefined,
            origin: server.origin,
          });
        },
      ),
  ],
  [
    "the FCM client",
    () =>
      onServer(
        {
          accept: { status: 200, body: { name: "projects/p/messages/1" } },
          uninstalled: {
            status: 404,
            body: {
              error: {
                code: 404,
                status: "NOT_FOUND",
                details: [
                  {
                    "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
                    errorCode: "UNREGISTERED",
                  },
                ],
              },
            },
          },
          outage: { status: 503, body: { error: { code: 503, status: "UNAVAILABLE" } } },
          silent: { hang: true },
        },
        (server) =>
          createFcmProvider({
            settings: {
              projectId: "questify-test",
              key: {
                clientEmail: "push@questify-test.iam.gserviceaccount.com",
                privateKey: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey,
                tokenUri: "https://oauth2.googleapis.test/token",
              },
            },
            log: () => undefined,
            origin: server.origin,
            fetch: (async () =>
              Response.json({
                access_token: "ya29.t",
                expires_in: 3600,
              })) as unknown as typeof fetch,
          }),
      ),
  ],
];

/** Every result the worker can be handed: a known kind and, where there is one, a code its ack can store. */
function wellFormed(result: PushResult): void {
  expect(KINDS.has(result.kind)).toBe(true);
  if ("code" in result) expect(result.code).toMatch(/^[A-Za-z0-9_]{1,40}$/);
}

describe.each(harnesses)("the provider contract: %s", (_name, setup) => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await setup();
  });

  afterAll(async () => {
    await harness.teardown();
  });

  it.each(["accept", "uninstalled", "outage"] as const)(
    "answers the worker's outcome when the far side does %s",
    async (scenario) => {
      harness.far(scenario);
      const result = await harness.provider.send(message, new Date(Date.now() + 2000));
      wellFormed(result);
      expect(result.kind).toBe(EXPECTED[scenario]);
      if (scenario === "uninstalled") expect(result).toMatchObject({ ambiguous: false });
      if (scenario === "outage") expect(result).toMatchObject({ written: true });
    },
  );

  it("answers by its deadline when the far side never does, and never throws", async () => {
    harness.far("silent");
    const started = Date.now();
    const result = await harness.provider.send(message, new Date(started + SILENT_DEADLINE_MS));
    wellFormed(result);
    expect(result.kind).toBe("unknown");
    expect(Date.now() - started).toBeLessThan(SILENT_DEADLINE_MS + 150);
  });

  it("closes, and closes again", async () => {
    harness.far("accept");
    await expect(harness.provider.close()).resolves.toBeUndefined();
    await expect(harness.provider.close()).resolves.toBeUndefined();
  });
});
