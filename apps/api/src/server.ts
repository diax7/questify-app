import { Pool } from "pg";
import { buildApp } from "./app";
import { createFailoverSender } from "./auth/email/failover";
import { createResendSender } from "./auth/email/resend";
import type { EmailSender } from "./auth/email/sender";
import { createSmtpSender } from "./auth/email/smtp";
import { dummyVerify } from "./auth/password";
import { loadConfig, type AppConfig } from "./config";
import { MemoryIdempotencyStore } from "./idempotency-store";

const POOL_SIZE = 10;
const STATEMENT_TIMEOUT_MS = 5000;
const LOCK_TIMEOUT_MS = 2000;
const CONNECT_TIMEOUT_MS = 3000;

function createPool(config: AppConfig): Pool {
  return new Pool({
    connectionString: config.databaseUrl,
    max: POOL_SIZE,
    statement_timeout: STATEMENT_TIMEOUT_MS,
    query_timeout: STATEMENT_TIMEOUT_MS + 1000,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    options: `-c lock_timeout=${LOCK_TIMEOUT_MS}`,
  });
}

function createEmailSender(config: AppConfig, onFailover: (from: string, to: string) => void) {
  const primary = createSmtpSender({
    user: config.auth.smtpUser,
    appPassword: config.auth.smtpAppPassword,
  });
  const backup: EmailSender | undefined =
    config.auth.resend === undefined ? undefined : createResendSender(config.auth.resend);
  return createFailoverSender({
    primary,
    ...(backup === undefined ? {} : { backup }),
    onFailover,
  });
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const pool = createPool(config);
  pool.on("error", (error) => {
    process.stderr.write(`Database pool error: ${error.name}\n`);
  });
  // One instance for now, so remembering keys in memory is enough. The database-backed store arrives with T-105.
  const app = buildApp({
    config,
    idempotencyStore: new MemoryIdempotencyStore(),
    pool,
    emailSender: createEmailSender(config, (from, to) => {
      app.log.warn({ event: "staff.email_failover", from, to });
    }),
  });
  // Make the dummy password hash now, so the first sign-in with an unknown email is not slower than later ones.
  await dummyVerify("warm-up");

  const stop = async (signal: string): Promise<void> => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    await pool.end();
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
