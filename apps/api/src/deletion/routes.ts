import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  contactCodeWrong,
  deletionExpired,
  emailUnavailable,
  handoverPending,
  invalidRequest,
  phoneNotSupported,
  smsUnavailable,
  tooManyAttempts,
  unauthenticated,
} from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import {
  confirmDeletion,
  requestCode,
  requestOwnCode,
  verifyCode,
  type CodeResult,
  type DeletionDeps,
} from "#src/deletion/deletion";
import { askerOf } from "#src/players/routes";

const BODY_LIMIT = 1024;
const LANG = z.enum(["ar", "en"]).default("ar");
const TOKEN = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const CHANNEL = z.enum(["phone", "email"]);

const ownBody = z.strictObject({ channel: CHANNEL.optional(), lang: LANG });
const codeBody = z.strictObject({
  channel: CHANNEL,
  value: z.string().min(1).max(254),
  lang: LANG,
});
const verifyBody = z.strictObject({ challengeToken: TOKEN, code: z.string().min(1).max(20) });
const confirmBody = z.strictObject({ deletionToken: TOKEN, forfeit: z.boolean().default(false) });

const open = { config: { access: "public" }, bodyLimit: BODY_LIMIT } as const;

function throttled(reply: FastifyReply, retryAfterSeconds: number) {
  reply.header("retry-after", String(retryAfterSeconds));
  return tooManyAttempts({ retryAfterSeconds });
}

function codeAnswer(reply: FastifyReply, result: CodeResult, emailOffered: boolean) {
  switch (result.kind) {
    case "code_sent":
      return reply
        .code(202)
        .send({ challengeToken: result.challengeToken, expiresInSeconds: result.expiresInSeconds });
    case "phone_not_supported":
      throw phoneNotSupported({ emailOffered });
    case "invalid_email":
      throw invalidRequest();
    case "throttled":
      throw throttled(reply, result.retryAfterSeconds);
    case "sms_unavailable":
      throw smsUnavailable({ emailOffered });
    case "email_unavailable":
      throw emailUnavailable();
  }
}

/**
 * Account deletion (T-217; FR-126, FR-127, FR-128; ADR-177): a code to the account's own contact from the app, or to a
 * contact typed on the web page (the same answer whether or not an account uses it); the code gives a 10-minute
 * deletion token and the pending handovers; the confirmation deletes. Every answer is `no-store`. The public routes
 * take no Idempotency-Key: the single-use deletion token is the key, and a repeat answers 204.
 */
export function registerDeletionRoutes(app: FastifyInstance, deps: DeletionDeps): void {
  app.post(
    "/v1/me/deletion/code",
    { config: { access: "player" }, bodyLimit: BODY_LIMIT },
    async (request, reply) => {
      const body = parse(ownBody, request.body ?? {});
      // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the player guard answers first
      if (request.player === undefined) {
        throw unauthenticated();
      }
      const result = await requestOwnCode(
        deps,
        { playerId: request.player.id, channel: body.channel, lang: body.lang },
        askerOf(request),
      );
      return codeAnswer(reply, result, false);
    },
  );

  app.register(
    async (scope) => {
      scope.addHook("onSend", async (_request, reply) => {
        reply.header("cache-control", "no-store");
      });

      scope.post("/code", open, async (request, reply) => {
        const body = parse(codeBody, request.body);
        return codeAnswer(reply, await requestCode(deps, body, askerOf(request)), true);
      });

      scope.post("/verify", open, async (request, reply) => {
        const body = parse(verifyBody, request.body);
        const result = await verifyCode(deps, body, askerOf(request));
        switch (result.kind) {
          case "verified":
            return {
              deletionToken: result.deletionToken,
              expiresInSeconds: result.expiresInSeconds,
              pending: result.pending,
            };
          case "invalid_code":
            throw contactCodeWrong({ attemptsLeft: result.attemptsLeft });
          case "expired":
            throw deletionExpired();
          case "throttled":
            throw throttled(reply, result.retryAfterSeconds);
        }
      });

      scope.post("/confirm", open, async (request, reply) => {
        const body = parse(confirmBody, request.body);
        const result = await confirmDeletion(
          deps,
          { deletionToken: body.deletionToken, forfeit: body.forfeit, requestId: request.id },
          askerOf(request),
        );
        switch (result.kind) {
          case "erased":
            return reply.code(204).send();
          case "handover_pending":
            throw handoverPending({ pending: result.pending });
          case "expired":
            throw deletionExpired();
        }
      });
    },
    { prefix: "/v1/deletion" },
  );
}
