import { randomUUID } from "node:crypto";
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import type { Pool } from "pg";
import type { BreachCheck } from "#src/auth/breached";
import { createDeferred, type Deferred } from "#src/auth/deferred";
import type { EmailSender } from "#src/auth/email/sender";
import { createAuthKeys } from "#src/auth/keys";
import { AUTH_LIMITS } from "#src/auth/limits";
import { createPasswords } from "#src/auth/password-reset";
import { registerStaffRoutes } from "#src/auth/routes";
import { createSessions } from "#src/auth/session";
import { createSignIn, reasonOf } from "#src/auth/sign-in";
import { createVerifyGate } from "#src/auth/verify-gate";
import type { AppConfig } from "#src/config";
import { registerConventions } from "#src/conventions";
import { registerOrganizerRoutes } from "#src/organizers/routes";
import { registerRouteInventory, type RouteInfo } from "#src/route-access";
import { registerConfigRoutes } from "#src/settings/routes";
import { createSettingsService, type SettingsService } from "#src/settings/service";
import { registerTranslationRoutes } from "#src/translations/routes";
import { createTranslationService, type TranslationService } from "#src/translations/service";
import type { IdempotencyStore } from "#src/idempotency-store";

export type AppOptions = Readonly<{
  config: AppConfig;
  idempotencyStore: IdempotencyStore;
  /** The connection pool for the API's own database role. */
  pool: Pool;
  /** Sends the sign-in codes (Gmail first, Resend as the backup). */
  emailSender: EmailSender;
  /** Checks new passwords against known breaches (Pwned Passwords in production, a fake in tests). */
  breachCheck: BreachCheck;
  /** Work that runs after an answer has gone. Created when not given; tests give one to wait on. */
  deferred?: Deferred;
  /** Reads and saves configuration. Created from the pool when not given (tests give one with a short cache). */
  settings?: SettingsService;
  /** Reads and saves the translation store. Created from the pool when not given. */
  translations?: TranslationService;
  logger?: FastifyServerOptions["logger"];
}>;

declare module "fastify" {
  interface FastifyInstance {
    /** Every route with who may call it; the tests walk it. */
    routeInventory: RouteInfo[];
  }
}

const READINESS_TIMEOUT_MS = 2000;
/** How long shutdown waits for emails still being sent. */
const DRAIN_TIMEOUT_MS = 5000;

/** Log level by environment, with secrets and keys removed from every log line. */
export function loggerOptions(config: AppConfig): {
  level: string;
  redact: string[];
  serializers: { req: (request: FastifyRequest) => { method: string; url: string } };
} {
  return {
    level: config.nodeEnv === "production" ? "info" : "debug",
    // Method and path only: the default serializer also writes the client address, which is personal data.
    serializers: { req: (request) => ({ method: request.method, url: request.url }) },
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
    genReqId: () => randomUUID(),
    // Trust exactly the proxies we run (hop 0 is the nearest); a client-sent X-Forwarded-For beyond them is ignored.
    trustProxy: (_address: string, hop: number) => hop < config.trustProxyHops,
  });
  app.decorate("routeInventory", registerRouteInventory(app));
  // JSON only: a form or plain-text body must never reach a handler.
  app.removeContentTypeParser("text/plain");

  registerConventions(app, {
    minAppVersion: config.minAppVersion,
    idempotencyStore: options.idempotencyStore,
  });

  const signInDeps = {
    pool: options.pool,
    keys: createAuthKeys(config.auth.secret),
    email: options.emailSender,
    gate: createVerifyGate(AUTH_LIMITS.verifyGate),
    securityAlertEmail: config.auth.securityAlertEmail,
  };
  const deferred =
    options.deferred ??
    createDeferred((error) => {
      app.log.error({ event: "deferred.task_failed", reason: reasonOf(error) });
    });
  app.addHook("onClose", async () => {
    await Promise.race([
      deferred.idle(),
      new Promise((resolve) => {
        setTimeout(resolve, DRAIN_TIMEOUT_MS).unref();
      }),
    ]);
    if (deferred.pending() > 0) {
      app.log.warn({ event: "deferred.dropped", count: deferred.pending() });
    }
  });
  registerStaffRoutes(app, {
    signIn: createSignIn(signInDeps),
    sessions: createSessions(options.pool),
    passwords: createPasswords({
      ...signInDeps,
      breachCheck: options.breachCheck,
      deferred,
      dashboardOrigin: config.auth.dashboardOrigin,
    }),
    dashboardOrigin: config.auth.dashboardOrigin,
  });

  registerOrganizerRoutes(app, {
    pool: options.pool,
    sessions: createSessions(options.pool),
    dashboardOrigin: config.auth.dashboardOrigin,
  });

  registerConfigRoutes(app, options.settings ?? createSettingsService({ pool: options.pool }));

  registerTranslationRoutes(
    app,
    options.translations ?? createTranslationService({ pool: options.pool }),
  );

  app.get("/healthz", { config: { access: "public" } }, async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return { status: "ok", release: config.releaseSha };
  });

  app.get("/readyz", { config: { access: "public" } }, async (_request, reply) => {
    reply.header("cache-control", "no-store");
    const database = await databaseReady(options.pool);
    return reply.code(database ? 200 : 503).send({
      status: database ? "ok" : "unavailable",
      checks: { database: database ? "ok" : "down" },
    });
  });

  return app;
}
