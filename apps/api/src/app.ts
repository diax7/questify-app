import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { Pool } from "pg";
import type { EmailSender } from "#src/auth/email/sender";
import { createAuthKeys } from "#src/auth/keys";
import { AUTH_LIMITS } from "#src/auth/limits";
import { registerStaffRoutes, type RouteInfo } from "#src/auth/routes";
import { createSessions } from "#src/auth/session";
import { createSignIn, type AuthLog } from "#src/auth/sign-in";
import { createVerifyGate } from "#src/auth/verify-gate";
import type { AppConfig } from "#src/config";
import { registerConventions } from "#src/conventions";
import type { IdempotencyStore } from "#src/idempotency-store";

export type AppOptions = Readonly<{
  config: AppConfig;
  idempotencyStore: IdempotencyStore;
  /** The connection pool for the API's own database role. */
  pool: Pool;
  /** Sends the sign-in codes (Gmail first, Resend as the backup). */
  emailSender: EmailSender;
  logger?: FastifyServerOptions["logger"];
}>;

declare module "fastify" {
  interface FastifyInstance {
    /** Every route in the staff scope and whether it is on the public list; the tests walk it. */
    staffRoutes: RouteInfo[];
  }
}

const READINESS_TIMEOUT_MS = 2000;

/** Log level by environment, with secrets and keys removed from every log line. */
export function loggerOptions(config: AppConfig): { level: string; redact: string[] } {
  return {
    level: config.nodeEnv === "production" ? "info" : "debug",
    redact: [
      "req.headers.authorization",
      "req.headers.cookie",
      'req.headers["idempotency-key"]',
      'res.headers["set-cookie"]',
    ],
  };
}

async function databaseReady(pool: Pool): Promise<boolean> {
  try {
    await Promise.race([
      pool.query("SELECT 1"),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("timeout")), READINESS_TIMEOUT_MS).unref();
      }),
    ]);
    return true;
  } catch {
    return false;
  }
}

/** Builds the API server. Nothing listens until the caller starts it. */
export function buildApp(options: AppOptions): FastifyInstance {
  const { config } = options;
  const app = Fastify({
    logger: options.logger ?? loggerOptions(config),
    // Trust exactly the proxies we run (hop 0 is the nearest); a client-sent X-Forwarded-For beyond them is ignored.
    trustProxy: (_address: string, hop: number) => hop < config.trustProxyHops,
  });
  // JSON only: a form or plain-text body must never reach a handler.
  app.removeContentTypeParser("text/plain");

  registerConventions(app, {
    minAppVersion: config.minAppVersion,
    idempotencyStore: options.idempotencyStore,
  });

  const log: AuthLog = (event, fields) => app.log.info({ event, ...fields });
  app.decorate(
    "staffRoutes",
    registerStaffRoutes(app, {
      signIn: createSignIn({
        pool: options.pool,
        keys: createAuthKeys(config.auth.secret),
        email: options.emailSender,
        gate: createVerifyGate(AUTH_LIMITS.verifyGate),
        log,
        securityAlertEmail: config.auth.securityAlertEmail,
      }),
      sessions: createSessions(options.pool),
      dashboardOrigin: config.auth.dashboardOrigin,
    }),
  );

  app.get("/healthz", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return { status: "ok", release: config.releaseSha };
  });

  app.get("/readyz", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    const database = await databaseReady(options.pool);
    return reply.code(database ? 200 : 503).send({
      status: database ? "ok" : "unavailable",
      checks: { database: database ? "ok" : "down" },
    });
  });

  return app;
}
