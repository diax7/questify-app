import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  breachCheckUnavailable,
  busy,
  challengeExpired,
  currentPasswordWrong,
  emailUnavailable,
  invalidCode,
  invalidCredentials,
  invalidRequest,
  notFound,
  resendLimit,
  resendTooSoon,
  resetLinkInvalid,
  tooManyAttempts,
  tooManyChallenges,
  unauthenticated,
  weakPassword,
} from "#src/auth/http-errors";
import { sessionLimitsFor } from "#src/auth/limits";
import type { Passwords, WeakReason } from "#src/auth/password-reset";
import { clearedSessionCookie, sessionCookie, type Sessions } from "#src/auth/session";
import type { Caller, SignIn } from "#src/auth/sign-in";
import { checkOrigin, requireSession } from "#src/auth/staff-guard";

export type StaffRoutesDeps = Readonly<{
  signIn: SignIn;
  sessions: Sessions;
  passwords: Passwords;
  /** The one origin allowed to make state-changing requests with the session cookie. */
  dashboardOrigin: string;
}>;

const SIGN_IN_BODY_LIMIT = 4096;

const passwordBody = z.object({
  email: z.string().min(3).max(254),
  password: z.string().min(1).max(1024),
});
const codeBody = z.object({
  challengeToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  code: z.string().regex(/^[0-9]{6}$/),
});
const resendBody = z.object({ challengeToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
const sessionParams = z.object({ id: z.uuid() });
const resetRequestBody = z.object({
  email: z.string().min(3).max(254),
  lang: z.enum(["ar", "en"]),
});
const resetConfirmBody = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  newPassword: z.string().min(1).max(1024),
});
const changeBody = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(1).max(1024),
});
const BREACH_RETRY_SECONDS = 30;

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw invalidRequest();
  }
  return result.data;
}

function callerOf(request: FastifyRequest): Caller {
  const agent = request.headers["user-agent"];
  return {
    address: request.ip,
    userAgent: typeof agent === "string" ? agent.slice(0, 300) : null,
    log: (event, fields) => request.log.info({ event, ...fields }),
    requestId: request.id,
  };
}

function waitThen(reply: FastifyReply, seconds: number): void {
  reply.header("retry-after", String(seconds));
}

type NotSet =
  | Readonly<{ kind: "weak"; reason: WeakReason }>
  | Readonly<{ kind: "breach_unavailable" }>
  | Readonly<{ kind: "busy" }>
  | Readonly<{ kind: "throttled"; retryAfterSeconds: number }>;

/** The answers a new password can get when it was not set, shared by reset and change. */
function refuseNewPassword(reply: FastifyReply, result: NotSet): never {
  switch (result.kind) {
    case "weak":
      throw weakPassword({ reason: result.reason });
    case "breach_unavailable":
      waitThen(reply, BREACH_RETRY_SECONDS);
      throw breachCheckUnavailable({ retryAfterSeconds: BREACH_RETRY_SECONDS });
    case "busy":
      waitThen(reply, 2);
      throw busy();
    case "throttled":
      waitThen(reply, result.retryAfterSeconds);
      throw tooManyAttempts({ retryAfterSeconds: result.retryAfterSeconds });
  }
}

function registerResetRoutes(scope: FastifyInstance, deps: StaffRoutesDeps): void {
  const open = { config: { access: "public" }, bodyLimit: SIGN_IN_BODY_LIMIT } as const;

  scope.post("/auth/reset/request", open, async (request, reply) => {
    const body = parse(resetRequestBody, request.body);
    const result = await deps.passwords.requestReset(body, callerOf(request));
    switch (result.kind) {
      case "accepted":
        return reply.code(202).send({});
      case "throttled":
        waitThen(reply, result.retryAfterSeconds);
        throw tooManyAttempts({ retryAfterSeconds: result.retryAfterSeconds });
    }
  });

  scope.post("/auth/reset/confirm", open, async (request, reply) => {
    const body = parse(resetConfirmBody, request.body);
    const result = await deps.passwords.confirmReset(body, callerOf(request));
    if (result.kind === "reset") {
      return reply.code(204).send();
    }
    if (result.kind === "link_invalid") {
      throw resetLinkInvalid();
    }
    return refuseNewPassword(reply, result);
  });
}

function registerSignInRoutes(scope: FastifyInstance, deps: StaffRoutesDeps): void {
  const open = { config: { access: "public" }, bodyLimit: SIGN_IN_BODY_LIMIT } as const;

  scope.post("/auth/password", open, async (request, reply) => {
    const body = parse(passwordBody, request.body);
    const result = await deps.signIn.passwordStep(body, callerOf(request));
    switch (result.kind) {
      case "code_sent":
        return { challengeToken: result.challengeToken, expiresInSeconds: result.expiresInSeconds };
      case "invalid_credentials":
        throw invalidCredentials();
      case "throttled":
        waitThen(reply, result.retryAfterSeconds);
        throw tooManyAttempts({ retryAfterSeconds: result.retryAfterSeconds });
      case "challenge_cap":
        waitThen(reply, result.retryAfterSeconds);
        throw tooManyChallenges({ retryAfterSeconds: result.retryAfterSeconds });
      case "busy":
        waitThen(reply, 2);
        throw busy();
      case "email_unavailable":
        throw emailUnavailable();
    }
  });

  scope.post("/auth/code", open, async (request, reply) => {
    const body = parse(codeBody, request.body);
    const result = await deps.signIn.codeStep(body, callerOf(request));
    switch (result.kind) {
      case "signed_in": {
        const limits = sessionLimitsFor(result.account.platformRole);
        reply.header("set-cookie", sessionCookie(result.sessionToken, limits.maxAgeSeconds));
        return {
          account: {
            id: result.account.id,
            email: result.account.email,
            platformRole: result.account.platformRole,
          },
        };
      }
      case "invalid_code":
        throw invalidCode({ attemptsLeft: result.attemptsLeft });
      case "challenge_expired":
        throw challengeExpired();
      case "throttled":
        waitThen(reply, result.retryAfterSeconds);
        throw tooManyAttempts({ retryAfterSeconds: result.retryAfterSeconds });
    }
  });

  scope.post("/auth/resend", open, async (request, reply) => {
    const body = parse(resendBody, request.body);
    const result = await deps.signIn.resend(body, callerOf(request));
    switch (result.kind) {
      case "resent":
        return {};
      case "challenge_expired":
        throw challengeExpired();
      case "resend_too_soon":
        waitThen(reply, result.retryAfterSeconds);
        throw resendTooSoon({ retryAfterSeconds: result.retryAfterSeconds });
      case "resend_limit":
        throw resendLimit();
      case "email_unavailable":
        throw emailUnavailable();
    }
  });
}

const staffOnly = { config: { access: "staff" } } as const;

function registerSessionRoutes(scope: FastifyInstance, deps: StaffRoutesDeps): void {
  scope.get("/me", staffOnly, async (request) => {
    const { account } = request.staff ?? failClosed();
    return {
      id: account.id,
      email: account.email,
      platformRole: account.platformRole,
      memberships: await deps.sessions.memberships(account.id),
    };
  });

  scope.get("/sessions", staffOnly, async (request) => {
    const { account, sessionId } = request.staff ?? failClosed();
    const live = await deps.sessions.list(account.id, account.platformRole);
    return { sessions: live.map((session) => ({ ...session, current: session.id === sessionId })) };
  });

  scope.delete("/sessions/:id", staffOnly, async (request, reply) => {
    const { account, sessionId } = request.staff ?? failClosed();
    const { id } = parse(sessionParams, request.params);
    if (!(await deps.sessions.revoke(account.id, id, { requestId: request.id }))) {
      throw notFound();
    }
    if (id === sessionId) {
      reply.header("set-cookie", clearedSessionCookie());
    }
    return reply.code(204).send();
  });

  scope.post(
    "/password",
    { ...staffOnly, bodyLimit: SIGN_IN_BODY_LIMIT },
    async (request, reply) => {
      const staff = request.staff ?? failClosed();
      const body = parse(changeBody, request.body);
      const result = await deps.passwords.change(body, staff, callerOf(request));
      if (result.kind === "changed") {
        return reply.code(204).send();
      }
      if (result.kind === "current_wrong") {
        throw currentPasswordWrong();
      }
      return refuseNewPassword(reply, result);
    },
  );

  scope.post("/auth/sign-out", staffOnly, async (request, reply) => {
    const { account, sessionId } = request.staff ?? failClosed();
    await deps.sessions.revoke(account.id, sessionId, { requestId: request.id });
    reply.header("set-cookie", clearedSessionCookie());
    return reply.code(204).send();
  });
}

/** Reached only if the scope's session hook was bypassed, which must never answer a request. */
function failClosed(): never {
  throw unauthenticated();
}

/**
 * Registers every /v1/staff route inside one scope whose hook demands a valid session unless the route's access is
 * "public" (the three sign-in steps and the two reset steps). Every route declares its access; the app refuses to start otherwise
 * (route-access.ts).
 */
export function registerStaffRoutes(app: FastifyInstance, deps: StaffRoutesDeps): void {
  app.register(
    async (scope) => {
      scope.addHook("onRequest", async (request, reply) => {
        reply.header("cache-control", "no-store");
        const isPublic = request.routeOptions.config.access === "public";
        checkOrigin(request, deps.dashboardOrigin, !isPublic);
        if (!isPublic) {
          await requireSession(request, reply, deps.sessions);
        }
      });
      registerSignInRoutes(scope, deps);
      registerResetRoutes(scope, deps);
      registerSessionRoutes(scope, deps);
    },
    { prefix: "/v1/staff" },
  );
}
