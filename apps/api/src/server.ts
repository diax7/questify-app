import { Pool } from "pg";
import { createClient, type RedisClientType } from "redis";
import { buildApp } from "#src/app";
import { createBreachCheck } from "#src/auth/breached";
import { createFailoverSender } from "#src/auth/email/failover";
import { createGmailSender } from "#src/auth/email/gmail";
import { createResendSender } from "#src/auth/email/resend";
import type { EmailSender } from "#src/auth/email/sender";
import { dummyVerify } from "#src/auth/password";
import { loadConfig, type AppConfig } from "#src/config";
import { poolOptions } from "#src/db/pool-options";
import { MemoryIdempotencyStore } from "#src/idempotency-store";
import { createMsegatSender } from "#src/players/sms";
import { createRankingStore } from "#src/ranking/store";

const LIFECYCLE_INTERVAL_MS = 30_000;
/** The community tick (ADR-222): settles each goal and pays due rewards every 5 s. */
const COMMUNITY_INTERVAL_MS = 5000;
const RANKING_REPAIR_INTERVAL_MS = 2000;
/** The invitation tick (ADR-333): starts, sends rounds of 5 for up to 3 s, settles every 10 minutes. */
const INVITATION_INTERVAL_MS = 5000;
/** A ranking write or read that Redis cannot answer this fast falls back to PostgreSQL (ADR-118). */
const REDIS_COMMAND_TIMEOUT_MS = 250;
const REDIS_CONNECT_TIMEOUT_MS = 2000;

/**
 * The Redis client for rankings: commands fail at once while it is disconnected (no offline queue), so callers fall
 * back to PostgreSQL instead of waiting; it keeps reconnecting in the background.
 */
function createRedis(url: string, log: (fields: Record<string, string>) => void): RedisClientType {
  const client: RedisClientType = createClient({
    url,
    disableOfflineQueue: true,
    commandOptions: { timeout: REDIS_COMMAND_TIMEOUT_MS },
    socket: {
      connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
      reconnectStrategy: (retries) => Math.min(200 * (retries + 1), 5000),
    },
  });
  client.on("error", (error: unknown) => {
    log({ event: "redis.error", reason: error instanceof Error ? error.name : "unknown" });
  });
  return client;
}

/** Rankings need Redis to keep every key: an evicting policy could drop a set while its "built" mark stays. */
async function checkEviction(
  client: RedisClientType,
  log: (fields: Record<string, string>) => void,
) {
  try {
    const policy = (await client.configGet("maxmemory-policy"))["maxmemory-policy"];
    if (policy !== "noeviction") {
      log({ event: "redis.eviction_policy", policy: policy ?? "unknown" });
    }
  } catch {
    log({ event: "redis.eviction_policy", policy: "unreadable" });
  }
}

function createPool(config: AppConfig): Pool {
  return new Pool(poolOptions(config));
}

/** The push worker's own pool (ADR-345 (1)): a large fan-out never takes the API's connections. */
const PUSH_POOL_SIZE = 3;

function createEmailSender(config: AppConfig, onFailover: (from: string, to: string) => void) {
  const { gmail } = config.auth;
  const primary = createGmailSender({
    key: gmail.key,
    from: gmail.from,
    ...(gmail.actAs === undefined ? {} : { actAs: gmail.actAs }),
  });
  const backup: EmailSender | undefined =
    config.auth.resend === undefined ? undefined : createResendSender(config.auth.resend);
  return createFailoverSender({
    primary,
    ...(backup === undefined ? {} : { backup }),
    onFailover,
  });
}

/** A line on standard error for Redis problems, which happen before and outside any request. */
const warn = (fields: Record<string, string>) =>
  process.stderr.write(`${JSON.stringify(fields)}
`);

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const pool = createPool(config);
  pool.on("error", (error) => {
    process.stderr.write(`Database pool error: ${error.name}\n`);
  });
  const pushPool = new Pool({ ...poolOptions(config), max: PUSH_POOL_SIZE });
  pushPool.on("error", (error) => {
    process.stderr.write(`Push pool error: ${error.name}\n`);
  });
  const redis = config.redisUrl === undefined ? undefined : createRedis(config.redisUrl, warn);
  if (redis !== undefined) {
    // Not awaited: the API starts without Redis and serves rankings from PostgreSQL until it connects.
    redis
      .connect()
      .then(() => checkEviction(redis, warn))
      .catch(() => warn({ event: "redis.connect_failed" }));
  }
  // One instance for now, so remembering keys in memory is enough. The database-backed store arrives with T-105.
  const app = buildApp({
    config,
    idempotencyStore: new MemoryIdempotencyStore(),
    pool,
    emailSender: createEmailSender(config, (from, to) => {
      app.log.warn({ event: "staff.email_failover", from, to });
    }),
    breachCheck: createBreachCheck(),
    ...(config.msegat === undefined ? {} : { smsSender: createMsegatSender(config.msegat) }),
    // Invitations go only from the registered promotional sender (FR-1112); loadConfig refused it equal to the service one.
    ...(config.msegat === undefined || config.msegatPromoSender === undefined
      ? {}
      : {
          promoSmsSender: createMsegatSender({
            ...config.msegat,
            sender: config.msegatPromoSender,
          }),
        }),
    lifecycleIntervalMs: LIFECYCLE_INTERVAL_MS,
    ...(redis === undefined ? {} : { rankingStore: createRankingStore(redis) }),
    rankingRepairIntervalMs: RANKING_REPAIR_INTERVAL_MS,
    communityIntervalMs: COMMUNITY_INTERVAL_MS,
    souvenirIntervalMs: 5000,
    invitationIntervalMs: INVITATION_INTERVAL_MS,
    // No provider until T-501b's APNs and FCM clients: the center fills, every push expires unsent.
    push: { pool: pushPool, providers: [] },
  });
  // Make the dummy password hash now, so the first sign-in with an unknown email is not slower than later ones.
  await dummyVerify("warm-up");

  const stop = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    await pool.end();
    await pushPool.end();
    if (redis?.isOpen === true) {
      await redis.close();
    }
    process.exit(0);
  };
  process.once("SIGTERM", () => void stop("SIGTERM"));
  process.once("SIGINT", () => void stop("SIGINT"));

  await app.listen({ host: config.host, port: config.port });
}

main().catch((error: unknown) => {
  process.stderr.write(
    `Could not start the API: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
