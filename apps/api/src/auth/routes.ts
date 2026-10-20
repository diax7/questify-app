import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  acceptanceRequired,
  breachCheckUnavailable,
  busy,
  challengeExpired,
  currentPasswordWrong,
  emailUnavailable,
  invalidCode,
  invalidCredentials,
  invalidOrganizerName,
  inviteInvalid,
  inviteOtherAccount,
  alreadyMember,
  signInToAccept,
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
import type { ResendResult, SignIn } from "#src/auth/sign-in";
import type { SignUp } from "#src/auth/sign-up";
import type { Invites } from "#src/organizers/accept";
import { callerOf, parse } from "#src/auth/request";
import { checkOrigin, requireSession } from "#src/auth/staff-guard";

export type StaffRoutesDeps = Readonly<{
  signIn: SignIn;
  sessions: Sessions;
  passwords: Passwords;
  signUp: SignUp;
  invites: Invites;
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
const acceptBody = z.object({
  terms: z.string().max(20),
  dpa: z.string().max(20),
  contentRules: z.string().max(20),
});
const signUpBody = z.object({
  email: z.string().min(3).max(254),
  password: z.string().min(1).max(1024),
  organizerName: z.string().min(1).max(400),
  accept: acceptBody,
});
const inviteTokenBody = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
const acceptNewBody = inviteTokenBody.extend({ password: z.string().min(1).max(1024) });
const createOrganizerBody = z.object({ name: z.string().min(1).max(400), accept: acceptBody });
const BREACH_RETRY_SECONDS = 30;
const staffOnly = { config: { access: "staff" } } as const;

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

function registerSignUpRoutes(scope: FastifyInstance, deps: StaffRoutesDeps): void {
  const open = { config: { access: "public" }, bodyLimit: SIGN_IN_BODY_LIMIT } as const;

  scope.post("/auth/sign-up", open, async (request, reply) => {
    const body = parse(signUpBody, request.body);
    const result = await deps.signUp.start(body, callerOf(request));
    switch (result.kind) {
      case "code_sent":
        return { challengeToken: result.challengeToken, expiresInSeconds: result.expiresInSeconds };
      case "invalid_email":
        throw invalidRequest();
      case "invalid_name":
        throw invalidOrganizerName({ reason: result.reason });
      case "acceptance_required":
        throw acceptanceRequired({ documents: result.documents });
      case "email_unavailable":
        throw emailUnavailable();
      default:
        return refuseNewPassword(reply, result);
    }
  });

  scope.post("/auth/sign-up/code", open, async (request, reply) => {
    const body = parse(codeBody, request.body);
    const result = await deps.signUp.code(body, callerOf(request));
    switch (result.kind) {
      case "signed_up": {
        const limits = sessionLimitsFor(result.account.platformRole);
        reply.header("set-cookie", sessionCookie(result.sessionToken, limits.maxAgeSeconds));
        return {
          account: {
            id: result.account.id,
            email: result.account.email,
            platformRole: result.account.platformRole,
          },
          organizerId: result.organizerId,
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

  scope.post("/auth/sign-up/resend", open, async (request, reply) => {
    const body = parse(resendBody, request.body);
    return answerResend(reply, await deps.signUp.resend(body, callerOf(request)));
  });

  // A double click must not make two organizers: the Idempotency-Key replays the first answer.
  scope.post(
    "/organizers",
    { config: { access: "staff", idempotent: true }, bodyLimit: SIGN_IN_BODY_LIMIT },
    async (request, reply) => {
      const { account } = request.staff ?? failClosed();
      const body = parse(createOrganizerBody, request.body);
      const result = await deps.signUp.createOrganizer(body, account, callerOf(request));
      switch (result.kind) {
        case "created":
          return reply.code(201).send({ organizerId: result.organizerId });
        case "invalid_name":
          throw invalidOrganizerName({ reason: result.reason });
        case "acceptance_required":
          throw acceptanceRequired({ documents: result.documents });
        case "throttled":
          waitThen(reply, result.retryAfterSeconds);
          throw tooManyAttempts({ retryAfterSeconds: result.retryAfterSeconds });
      }
    },
  );
}

/** The answers to a resend, shared by sign-in and sign-up. */
function answerResend(reply: FastifyReply, result: ResendResult): Record<string, never> {
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
}

type InviteRefusal = Readonly<{
  kind: "invalid" | "other_account" | "already_member" | "sign_in_to_accept";
}>;

function refuseInvite(result: InviteRefusal): never {
  switch (result.kind) {
    case "invalid":
      throw inviteInvalid();
    case "other_account":
      throw inviteOtherAccount();
    case "already_member":
      throw alreadyMember();
    case "sign_in_to_accept":
      throw signInToAccept();
  }
}

function registerInviteRoutes(scope: FastifyInstance, deps: StaffRoutesDeps): void {
  const open = { config: { access: "public" }, bodyLimit: SIGN_IN_BODY_LIMIT } as const;

  scope.post("/invites/inspect", open, async (request, reply) => {
    const { token } = parse(inviteTokenBody, request.body);
    const result = await deps.invites.inspect(token, callerOf(request));
    if (result.kind === "invite") {
      return result.invite;
    }
    if (result.kind === "throttled") {
      waitThen(reply, result.retryAfterSeconds);
      throw tooManyAttempts({ retryAfterSeconds: result.retryAfterSeconds });
    }
    return refuseInvite(result);
  });

  scope.post(
    "/invites/accept",
    { ...staffOnly, bodyLimit: SIGN_IN_BODY_LIMIT },
    async (request) => {
      const { account } = request.staff ?? failClosed();
      const { token } = parse(inviteTokenBody, request.body);
      const result = await deps.invites.accept(token, account.id, callerOf(request));
      return result.kind === "joined" ? { organizerId: result.organizerId } : refuseInvite(result);
    },
  );

  scope.post("/invites/accept-new", open, async (request, reply) => {
    const body = parse(acceptNewBody, request.body);
    const result = await deps.invites.acceptNew(body, callerOf(request));
    switch (result.kind) {
      case "code_sent":
        return { challengeToken: result.challengeToken, expiresInSeconds: result.expiresInSeconds };
      case "invalid":
      case "other_account":
      case "already_member":
      case "sign_in_to_accept":
        return refuseInvite(result);
      case "email_unavailable":
        throw emailUnavailable();
      default:
        return refuseNewPassword(reply, result);
    }
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
    return answerResend(reply, await deps.signIn.resend(body, callerOf(request)));
  });
}

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
      registerSignUpRoutes(scope, deps);
      registerInviteRoutes(scope, deps);
      registerSessionRoutes(scope, deps);
    },
    { prefix: "/v1/staff" },
  );
}
