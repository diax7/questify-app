import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AVATARS } from "@questify/shared";
import { z } from "zod";
import {
  accountBanned,
  challengeExpired,
  contactTaken,
  emailUnavailable,
  invalidBirthYear,
  invalidCode,
  invalidRequest,
  invalidUsername,
  phoneNotSupported,
  playerAcceptanceRequired,
  resendLimit,
  resendTooSoon,
  signupExpired,
  smsUnavailable,
  tooManyAttempts,
  tooYoung,
  unauthenticated,
  usernameBlocked,
  usernameTaken,
} from "#src/auth/http-errors";
import { callerOf, parse } from "#src/auth/request";
import type { Asker, Issued, PlayerSignIn } from "#src/players/sign-in";
import type { HttpError } from "#src/http-error";

const BODY_LIMIT = 2048;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const LANG = z.enum(["ar", "en"]).default("ar");

const VERSION = z.string().regex(/^[0-9]+(\.[0-9]+){0,2}$/);
const codeBody = z.strictObject({
  channel: z.enum(["phone", "email"]),
  value: z.string().min(1).max(254),
  previous: TOKEN.optional(),
  lang: LANG,
  // The terms and privacy versions the person accepted on the sign-in screen (FR-1705).
  accept: z.strictObject({ terms: VERSION, privacy: VERSION }),
});
const resendBody = z.strictObject({ challengeToken: TOKEN, lang: LANG });
const verifyBody = z.strictObject({ challengeToken: TOKEN, code: z.string().min(1).max(20) });
const signupBody = z.strictObject({
  signupToken: TOKEN,
  username: z.string().min(1).max(120),
  birthYear: z.int().min(0).max(9999),
  avatar: z.enum(AVATARS),
});
const refreshBody = z.strictObject({ refreshToken: TOKEN });

const open = { config: { access: "public" }, bodyLimit: BODY_LIMIT } as const;

/** Who is asking, with the app's install id when it is one (anything else is ignored, never trusted). */
export function askerOf(request: FastifyRequest): Asker {
  const device = request.headers["x-device-id"];
  return {
    ...callerOf(request),
    deviceId: typeof device === "string" && UUID.test(device) ? device.toLowerCase() : undefined,
  };
}

function throttled(reply: FastifyReply, retryAfterSeconds: number): HttpError {
  reply.header("retry-after", String(retryAfterSeconds));
  return tooManyAttempts({ retryAfterSeconds });
}

/** The phone-only refusals offer email, so the app can switch without guessing (FR-1812). */
const UNAVAILABLE = {
  sms_unavailable: () => smsUnavailable({ emailOffered: true }),
  email_unavailable: () => emailUnavailable(),
} as const;

const SIGNUP_REFUSALS = {
  signup_expired: signupExpired,
  invalid_birth_year: invalidBirthYear,
  too_young: tooYoung,
  username_taken: usernameTaken,
  username_blocked: usernameBlocked,
  contact_taken: contactTaken,
} as const;

/**
 * Player sign-in (T-107, FR-106–110): a code to a Saudi mobile or an email, the code, the profile step for a new
 * contact, then a 1-hour access token and a rotating refresh token. Public routes: the proof is in the body. Every
 * answer is `no-store`. The code answer is the same whether or not the contact has an account.
 */
export function registerPlayerAuthRoutes(app: FastifyInstance, signIn: PlayerSignIn): void {
  app.register(
    async (scope) => {
      scope.addHook("onSend", async (_request, reply) => {
        reply.header("cache-control", "no-store");
      });

      scope.post("/code", open, async (request, reply) => {
        const body = parse(codeBody, request.body);
        const result = await signIn.requestCode(body, askerOf(request));
        switch (result.kind) {
          case "code_sent": {
            const { kind: _kind, ...sent } = result;
            return reply.code(202).send(sent);
          }
          case "acceptance_required":
            throw playerAcceptanceRequired({ documents: result.documents });
          case "phone_not_supported":
            throw phoneNotSupported({ emailOffered: true });
          case "invalid_email":
            throw invalidRequest();
          case "throttled":
            throw throttled(reply, result.retryAfterSeconds);
          default:
            throw UNAVAILABLE[result.kind]();
        }
      });

      scope.post("/resend", open, async (request, reply) => {
        const body = parse(resendBody, request.body);
        const result = await signIn.resend(body, askerOf(request));
        switch (result.kind) {
          case "resent": {
            const { kind: _kind, ...sent } = result;
            return reply.code(202).send(sent);
          }
          case "challenge_expired":
            throw challengeExpired();
          case "resend_limit":
            throw resendLimit();
          case "resend_too_soon":
            reply.header("retry-after", String(result.retryAfterSeconds));
            throw resendTooSoon({ retryAfterSeconds: result.retryAfterSeconds });
          case "throttled":
            throw throttled(reply, result.retryAfterSeconds);
          default:
            throw UNAVAILABLE[result.kind]();
        }
      });

      scope.post("/verify", open, async (request, reply) => {
        const body = parse(verifyBody, request.body);
        const result = await signIn.verify(body, askerOf(request));
        switch (result.kind) {
          case "signed_in":
            return issuedBody(result.issued);
          case "new":
            return { isNew: true, signupToken: result.signupToken };
          case "invalid_code":
            throw invalidCode({ attemptsLeft: result.attemptsLeft });
          case "challenge_expired":
            throw challengeExpired();
          case "account_banned":
            throw accountBanned();
          case "throttled":
            throw throttled(reply, result.retryAfterSeconds);
        }
      });

      scope.post("/signup", open, async (request, reply) => {
        const body = parse(signupBody, request.body);
        const result = await signIn.signup(body, askerOf(request));
        switch (result.kind) {
          case "created":
            return reply.code(201).send(issuedBody(result.issued));
          case "invalid_username":
            throw invalidUsername({ reason: result.reason });
          default:
            throw SIGNUP_REFUSALS[result.kind]();
        }
      });

      scope.post("/refresh", open, async (request) => {
        const body = parse(refreshBody, request.body);
        const result = await signIn.refresh(body, askerOf(request));
        if (result.kind !== "rotated") {
          throw unauthenticated();
        }
        return issuedBody(result.issued);
      });

      // The refresh token is the proof, so a device whose access token expired can still sign out. Always 204.
      scope.post("/logout", open, async (request, reply) => {
        const body = parse(refreshBody, request.body);
        await signIn.logout(body);
        return reply.code(204).send();
      });
    },
    { prefix: "/v1/auth" },
  );
}

function issuedBody(issued: Issued) {
  return {
    accessToken: issued.accessToken,
    refreshToken: issued.refreshToken,
    expiresInSeconds: issued.expiresInSeconds,
    player: issued.player,
  };
}
