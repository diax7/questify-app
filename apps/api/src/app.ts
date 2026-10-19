import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { AppConfig } from "./config";
import { registerConventions } from "./conventions";
import type { IdempotencyStore } from "./idempotency-store";

export type AppOptions = Readonly<{
  config: AppConfig;
  idempotencyStore: IdempotencyStore;
  logger?: FastifyServerOptions["logger"];
}>;

/** Builds the API server. Nothing listens until the caller starts it. */
export function buildApp(options: AppOptions): FastifyInstance {
  const app = Fastify({
    logger: options.logger ?? {
      level: options.config.nodeEnv === "production" ? "info" : "debug",
      redact: ["req.headers.authorization", "req.headers.cookie", 'req.headers["idempotency-key"]'],
    },
    trustProxy: true,
  });

  registerConventions(app, {
    minAppVersion: options.config.minAppVersion,
    idempotencyStore: options.idempotencyStore,
  });

  app.get("/healthz", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return { status: "ok", release: options.config.releaseSha };
  });

  // Dependency checks (database, cache) are added here as they are connected.
  app.get("/readyz", async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return { status: "ok", checks: {} };
  });

  return app;
}
