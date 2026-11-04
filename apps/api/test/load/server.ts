import { createServer, type Server } from "node:http";
import { Pool } from "pg";
import { buildApp } from "#src/app";
import { poolOptions } from "#src/db/pool-options";
import { MemoryIdempotencyStore } from "#src/idempotency-store";
import { createFakeProvider } from "#src/push/fake";
import { PUSH_TARGETS } from "#src/push/provider";
import { createRankingRedis, createRankingStore, type RankingRedis } from "#src/ranking/store";
import { qrSecret, required } from "#test/load/settings";
import { testConfig } from "#test/support/auth-app";

/**
 * The API for the load test (T-804, ops/load): the product's app as `src/server.ts` builds it, with production's pool
 * size, Redis options and background ticks, on a throw-away database. Test code only. Differences from production, on
 * purpose: SMS and email are stubbed (they answer "sent" at once, as the tests' senders do), push goes to the fake
 * provider, telemetry is off, and the Redis keys carry a prefix of this run so the cleanup can find them.
 *
 * Request logs are production's (pino at info on standard output; the harness discards them, so their cost stays).
 * Settings: LOAD_DATABASE_URL (the API role's URL), LOAD_REDIS_URL, LOAD_REDIS_PREFIX, LOAD_PORT, DATABASE_POOL_SIZE,
 * LOAD_CODE_PORT (optional: the stubs keep the last code sent to each phone or email and answer
 * `GET /code?to=<contact>` on 127.0.0.1 at that port, so the rush driver can type codes back, T-804b `--rush-verify`).
 */
const REDIS_COMMAND_TIMEOUT_MS = 250;
const REDIS_CONNECT_TIMEOUT_MS = 2000;
const PRODUCTION_POOL_SIZE = 10;
const PUSH_POOL_SIZE = 3;

function createRedis(url: string, prefix: string): RankingRedis {
  const client: RankingRedis = createRankingRedis({
    url,
    keyPrefix: prefix,
    disableOfflineQueue: true,
    commandOptions: { timeout: REDIS_COMMAND_TIMEOUT_MS },
    socket: { connectTimeout: REDIS_CONNECT_TIMEOUT_MS, reconnectStrategy: () => 1000 },
  });
  client.on("error", (error: unknown) => {
    process.stderr.write(`redis error: ${error instanceof Error ? error.message : "unknown"}\n`);
  });
  return client;
}

/** The last sign-in code the stubs "sent" to each contact, for the rush driver (test code only, never in `src/`). */
const lastCodes = new Map<string, string>();
const remember = (to: string, text: string): void => {
  const code = /[0-9]{6}/.exec(text)?.[0];
  if (code !== undefined) {
    lastCodes.set(to, code);
  }
};

/** Serves the remembered codes on 127.0.0.1 only. */
function serveCodes(port: number): Server {
  const server = createServer((req, res) => {
    const to = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("to") ?? "";
    const code = lastCodes.get(to);
    res.writeHead(code === undefined ? 404 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify(code === undefined ? {} : { code }));
  });
  server.listen(port, "127.0.0.1");
  return server;
}

async function main(): Promise<void> {
  const databaseUrl = required("LOAD_DATABASE_URL");
  const poolSize = Number(process.env["DATABASE_POOL_SIZE"] ?? PRODUCTION_POOL_SIZE);
  const config = {
    ...testConfig(databaseUrl),
    qrSecret: qrSecret(),
    nodeEnv: "production" as const,
    port: Number(required("LOAD_PORT")),
    databasePoolSize: poolSize,
  };
  const pool = new Pool(poolOptions(config));
  const pushPool = new Pool({ ...poolOptions(config), max: PUSH_POOL_SIZE });
  const redis = createRedis(required("LOAD_REDIS_URL"), required("LOAD_REDIS_PREFIX"));
  await redis.connect();
  const sent = {
    send: (message: { to: string; text: string }) => {
      remember(message.to, message.text);
      return Promise.resolve({ kind: "sent" as const });
    },
  };
  const codePort = process.env["LOAD_CODE_PORT"];
  const codes = codePort === undefined ? undefined : serveCodes(Number(codePort));
  const app = buildApp({
    config,
    idempotencyStore: new MemoryIdempotencyStore(),
    pool,
    emailSender: {
      name: "load-stub",
      send: (message: { to: string; text: string }) => {
        remember(message.to, message.text);
        return Promise.resolve();
      },
    },
    breachCheck: () => Promise.resolve(false),
    smsSender: { name: "load-stub", ...sent },
    promoSmsSender: { name: "load-stub-promo", ...sent },
    lifecycleIntervalMs: 30_000,
    rankingStore: createRankingStore(redis),
    rankingRepairIntervalMs: 2000,
    communityIntervalMs: 5000,
    souvenirIntervalMs: 5000,
    invitationIntervalMs: 5000,
    rankPushIntervalMs: 10_000,
    organizerAlerts: { intervalMs: 60_000 },
    teamAlertIntervalMs: 60_000,
    push: { pool: pushPool, providers: PUSH_TARGETS.map((target) => createFakeProvider(target)) },
  });
  const stop = async (): Promise<void> => {
    codes?.close();
    await app.close();
    await pool.end();
    await pushPool.end();
    await redis.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  await app.listen({ host: "127.0.0.1", port: config.port });
  process.stderr.write(`load api ready on ${config.port}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`load api: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
