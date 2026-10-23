import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isBelowMinimum } from "@questify/shared";
import { HttpError } from "#src/http-error";
import type { IdempotencyStore } from "#src/idempotency-store";

declare module "fastify" {
  interface FastifyContextConfig {
    /** The route needs an Idempotency-Key header and replays the first answer to a retry. */
    idempotent?: boolean;
  }
}

export type ConventionOptions = Readonly<{
  /** Lowest app version the server still supports. Older apps get 426. */
  minAppVersion: string;
  idempotencyStore: IdempotencyStore;
}>;

type Claim = Readonly<{ scope: string; key: string }>;

/** PostgreSQL lock_timeout (55P03), statement_timeout (57014) and too many connections (53300): a busy database, not a bug. */
/**
 * Database errors a retry can fix: a lock or statement timeout, too many connections, and a deadlock or serialization
 * failure (Postgres aborts one side of a rare crossed lock order, ADR-211). Answered 503 busy with Retry-After.
 */
const DATABASE_BUSY = new Set(["55P03", "57014", "53300", "40P01", "40001"]);
/**
 * Visible ASCII; `sub:`, `quiz:`, `pass:`, `meet:` and `game:` are reserved for the database's own completion keys
 * (T-301, T-302, T-304b, T-303c, T-305).
 */
const KEY_FORMAT = /^(?!sub:|quiz:|pass:|meet:|game:)[\x21-\x7e]{1,255}$/;
const APP_VERSION = /^[0-9]+(\.[0-9]+){1,2}$/;

const headerValue = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

/**
 * What a key promises to repeat: the method, the real path (not the route's pattern, so the same key on two quests'
 * `/v1/quests/:questId/complete` is two different requests) and the body.
 */
const bodyHash = (request: FastifyRequest): string =>
  createHash("sha256")
    .update(
      `${request.method} ${request.url.split("?")[0]}\n${JSON.stringify(request.body ?? null)}`,
    )
    .digest("hex");

const principal = (request: FastifyRequest): string => request.principalId ?? "anonymous";

/**
 * Applies the rules in docs/API.md (Conventions) to every route: one error envelope,
 * a request id, the app-version check, and idempotency keys on unsafe routes.
 */
export function registerConventions(app: FastifyInstance, options: ConventionOptions): void {
  const claims = new WeakMap<FastifyRequest, Claim>();
  const replays = new WeakSet<FastifyRequest>();

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
    const version = headerValue(request.headers["x-app-version"]);
    if (version === undefined) {
      return;
    }
    if (!APP_VERSION.test(version)) {
      throw new HttpError(400, "invalid_app_version", {
        ar: "رقم إصدار التطبيق غير صالح.",
        en: "The app version header is not a valid version.",
      });
    }
    if (isBelowMinimum(version, options.minAppVersion)) {
      throw new HttpError(
        426,
        "update_required",
        { ar: "يرجى تحديث التطبيق للمتابعة.", en: "Please update the app to continue." },
        { minimumVersion: options.minAppVersion },
      );
    }
  });

  app.addHook("preHandler", async (request, reply) => {
    if (request.routeOptions.config.idempotent !== true) {
      return;
    }
    const key = headerValue(request.headers["idempotency-key"]);
    if (key === undefined) {
      throw new HttpError(400, "idempotency_key_required", {
        ar: "هذا الإجراء يتطلب مفتاح Idempotency-Key.",
        en: "This action needs an Idempotency-Key header.",
      });
    }
    if (!KEY_FORMAT.test(key)) {
      throw new HttpError(400, "idempotency_key_invalid", {
        ar: "مفتاح Idempotency-Key غير صالح.",
        en: "The Idempotency-Key must be 1 to 255 visible characters with no spaces.",
      });
    }
    const scope = principal(request);
    const result = await options.idempotencyStore.begin(scope, key, bodyHash(request));
    if (result.kind === "mismatch") {
      throw new HttpError(422, "idempotency_key_reused", {
        ar: "تم استخدام هذا المفتاح مع طلب مختلف.",
        en: "This key was already used with a different request.",
      });
    }
    if (result.kind === "in_progress") {
      throw new HttpError(409, "request_in_progress", {
        ar: "الطلب نفسه قيد التنفيذ. حاول بعد لحظات.",
        en: "The same request is still running. Try again in a moment.",
      });
    }
    if (result.kind === "replay") {
      replays.add(request);
      return reply
        .header("idempotent-replayed", "true")
        .header("content-type", result.contentType)
        .code(result.status)
        .send(result.payload);
    }
    claims.set(request, { scope, key });
  });

  app.addHook("onSend", async (request, reply, payload) => {
    const claim = claims.get(request);
    if (claim === undefined || replays.has(request)) {
      return payload;
    }
    claims.delete(request);
    // An empty answer (204) has no payload; it is remembered as empty so a retry replays it instead of running again.
    const body = payload === undefined || payload === null ? "" : payload;
    if (reply.statusCode >= 500 || typeof body !== "string") {
      await options.idempotencyStore.abort(claim.scope, claim.key);
      return payload;
    }
    const contentType = String(reply.getHeader("content-type") ?? "application/json");
    await options.idempotencyStore.finish(
      claim.scope,
      claim.key,
      reply.statusCode,
      body,
      contentType,
    );
    return payload;
  });

  app.setErrorHandler(
    async (
      error: Error & { statusCode?: number; code?: string },
      _request,
      reply: FastifyReply,
    ) => {
      if (error instanceof HttpError) {
        return reply.code(error.status).send(error.envelope);
      }
      if (error.statusCode !== undefined && error.statusCode >= 400 && error.statusCode < 500) {
        return reply.code(error.statusCode).send({
          code: "invalid_request",
          message: { ar: "الطلب غير صالح.", en: "The request is not valid." },
          details: {},
        });
      }
      if (error.code !== undefined && DATABASE_BUSY.has(error.code)) {
        app.log.warn({ event: "database.busy", code: error.code });
        return reply
          .code(503)
          .header("retry-after", "2")
          .send({
            code: "busy",
            message: {
              ar: "الخدمة مشغولة. حاول بعد لحظات.",
              en: "The service is busy. Try again in a moment.",
            },
            details: {},
          });
      }
      app.log.error(error);
      return reply.code(500).send({
        code: "internal_error",
        message: {
          ar: "حدث خطأ غير متوقع. حاول مرة أخرى.",
          en: "Something went wrong. Try again.",
        },
        details: {},
      });
    },
  );

  app.setNotFoundHandler(async (_request, reply) =>
    reply.code(404).send({
      code: "not_found",
      message: { ar: "غير موجود.", en: "Not found." },
      details: {},
    }),
  );
}
