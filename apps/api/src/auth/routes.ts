import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  acceptanceRequired,
  breachCheckUnavailable,
  busy,
  challengeExpired,
  contactCodeWrong,
  emailChangeLinkInvalid,
  emailChangeLocked,
  emailChangeNoticeFailed,
  emailTaken,
  wrongCodeOrPassword,
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
  reauthRequired,
  resetLinkInvalid,
  tooManyAttempts,
  tooManyChallenges,
  unauthenticated,
  weakPassword,
} from "#src/auth/http-errors";
import { sessionLimitsFor } from "#src/auth/limits";
import type { EmailChange } from "#src/auth/email-change";
import type { Passwords, WeakReason } from "#src/auth/password-reset";
import type { StaffReauth } from "#src/auth/reauth";
import { clearedSessionCookie, sessionCookie, type Sessions } from "#src/auth/session";
import type { SignIn, StaffResendResult } from "#src/auth/sign-in";
import type { SignUp } from "#src/auth/sign-up";
import type { Invites } from "#src/organizers/accept";
import { callerOf, parse } from "#src/auth/request";
import { guardStaffDoor, surfaceOf } from "#src/auth/staff-guard";
import { waitThen } from "#src/http-error";

export type StaffRoutesDeps = Readonly<{
  signIn: SignIn;
  sessions: Sessions;
  reauth: StaffReauth;
  passwords: Passwords;
  signUp: SignUp;
  invites: Invites;
  emailChange: EmailChange;
  /** The dashboard's origin: while no console origin is set, the one allowed to make state-changing cookie requests. */
  dashboardOrigin: string;
  /**
   * The console's own origin (T-810d), or undefined. Set, sign-in steps take either origin, a cookie request only its own
   * session's (ADR-721), and a platform admin's sign-in from it opens a console session (ADR-720).
   */
  consoleOrigin: string | undefined;
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
const emptyBody = z.strictObject({});

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

/** The confirm's refusals that carry no detail. */
const CONFIRM_REFUSALS = {
  locked: emailChangeLocked,
  notice_failed: emailChangeNoticeFailed,
  email_taken: emailTaken,
  invalid: emailChangeLinkInvalid,
} as const;

const emailChangeTokenBody = z.strictObject({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) });
const emailChangeConfirmBody = emailChangeTokenBody.extend({
  code: z.string().regex(/^[0-9]{6}$/),
  password: z.string().min(1).max(1024).nullable(),
});

/**
 * The owner's confirm page and the old address's Stop page (T-701b): public, the token in the body, never in a URL.
 * Each call counts against the client address (20 in 15 minutes).
 */
function registerEmailChangeRoutes(scope: FastifyInstance, deps: StaffRoutesDeps): void {
  const open = { config: { access: "public" }, bodyLimit: SIGN_IN_BODY_LIMIT } as const;

  scope.post("/auth/email-change/view", open, async (request, reply) => {
    const { token } = parse(emailChangeTokenBody, request.body);
    const caller = callerOf(request);
    await deps.emailChange.admit(caller, reply);
    const found = await deps.emailChange.view(token);
    if (found === undefined) {
      throw emailChangeLinkInvalid();
    }
    return found;
  });

  scope.post("/auth/email-change/confirm", open, async (request, reply) => {
    const body = parse(emailChangeConfirmBody, request.body);
    const caller = callerOf(request);
    await deps.emailChange.admit(caller, reply);
    const result = await deps.emailChange.confirm(body, caller);
    switch (result.kind) {
      case "confirmed":
        return { outcome: "confirmed", email: result.email };
      case "held":
        return { outcome: "held", appliesAt: result.appliesAt };
      case "wrong":
        throw wrongCodeOrPassword({ attemptsLeft: result.attemptsLeft });
      case "busy":
        waitThen(reply, 2);
        throw busy();
      default:
        throw CONFIRM_REFUSALS[result.kind]();
    }
  });

  scope.post("/auth/email-change/stop", open, async (request, reply) => {
    const { token } = parse(emailChangeTokenBody, request.body);
    const caller = callerOf(request);
    await deps.emailChange.admit(caller, reply);
    return { outcome: await deps.emailChange.stop(token, caller) };
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
function answerResend(reply: FastifyReply, result: StaffResendResult): Record<string, never> {
  switch (result.kind) {
    case "throttled":
      waitThen(reply, result.retryAfterSeconds);
      throw tooManyAttempts({ retryAfterSeconds: result.retryAfterSeconds });
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
    const result = await deps.signIn.codeStep(
      {
        ...body,
        surface: surfaceOf(request, {
          dashboard: deps.dashboardOrigin,
          console: deps.consoleOrigin,
        }),
      },
      callerOf(request),
    );
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
    const [live, freshUntil] = await Promise.all([
      deps.sessions.list(account.id, account.platformRole),
      deps.sessions.freshUntil(account.id, sessionId),
    ]);
    return {
      sessions: live.map((session) => ({ ...session, current: session.id === sessionId })),
      freshUntil,
    };
  });

  scope.delete("/sessions/:id", staffOnly, async (request, reply) => {
    const { id } = parse(sessionParams, request.params);
    const outcome = await deps.sessions.end(ownerOf(request), id, { requestId: request.id });
    if (outcome === "reauth_required") {
      throw reauthRequired();
    }
    if (outcome === "not_found") {
      throw notFound();
    }
    if (id === request.staff?.sessionId) {
      reply.header("set-cookie", clearedSessionCookie());
    }
    return reply.code(204).send();
  });

  scope.post(
    "/sessions/end-others",
    { config: { access: "staff", idempotent: true } } as const,
    async (request) => {
      parse(emptyBody, request.body ?? {});
      const result = await deps.sessions.endOthers(ownerOf(request), { requestId: request.id });
      if (result.kind === "reauth_required") {
        throw reauthRequired();
      }
      return { ended: result.ended };
    },
  );

  registerReauthRoutes(scope, deps);

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
    const { sessionId } = request.staff ?? failClosed();
    await deps.sessions.end(ownerOf(request), sessionId, { requestId: request.id });
    reply.header("set-cookie", clearedSessionCookie());
    return reply.code(204).send();
  });
}

/** The caller of a session door: the user and their own session token's hash. */
function ownerOf(request: FastifyRequest): Readonly<{ staffUserId: string; tokenHash: string }> {
  const { account, tokenHash } = request.staff ?? failClosed();
  return { staffUserId: account.id, tokenHash };
}

/**
 * `POST /v1/staff/reauth/code` and `/v1/staff/reauth/verify` (T-810c, ASVS V7.5.2): a fresh emailed code before this
 * session ends the person's other sessions.
 */
function registerReauthRoutes(scope: FastifyInstance, deps: StaffRoutesDeps): void {
  scope.post("/reauth/code", staffOnly, async (request, reply) => {
    parse(emptyBody, request.body ?? {});
    const { account } = request.staff ?? failClosed();
    const result = await deps.reauth.start(
      { ...ownerOf(request), email: account.email },
      callerOf(request),
    );
    switch (result.kind) {
      case "code_sent":
        return reply.code(202).send({
          challengeToken: result.challengeToken,
          expiresInSeconds: result.expiresInSeconds,
        });
      case "throttled":
        waitThen(reply, result.retryAfterSeconds);
        throw tooManyAttempts({ retryAfterSeconds: result.retryAfterSeconds });
      case "email_unavailable":
        throw emailUnavailable();
    }
  });

  scope.post(
    "/reauth/verify",
    { config: { access: "staff", idempotent: true } } as const,
    async (request) => {
      const body = parse(codeBody, request.body);
      const { account } = request.staff ?? failClosed();
      const result = await deps.reauth.confirm(
        { ...ownerOf(request), email: account.email },
        { challengeToken: body.challengeToken, code: body.code, requestId: request.id },
        callerOf(request),
      );
      switch (result.kind) {
        case "confirmed":
          return { freshUntil: result.freshUntil };
        case "invalid_code":
          throw contactCodeWrong({ attemptsLeft: result.attemptsLeft });
        case "challenge_expired":
          throw challengeExpired();
      }
    },
  );
}

/** Reached only if the scope's session hook was bypassed, which must never answer a request. */
function failClosed(): never {
  throw unauthenticated();
}

/**
 * Registers every /v1/staff route inside one scope whose hook demands a valid session unless the route's access is
 * "public" (the three sign-in steps and the two reset steps). With the console on its own host (T-810d) it refuses a
 * request from another host before any session lookup, and an Origin that is not the session's own after it. Every
 * route declares its access; the app refuses to start otherwise (route-access.ts).
 */
export function registerStaffRoutes(app: FastifyInstance, deps: StaffRoutesDeps): void {
  app.register(
    async (scope) => {
      scope.addHook("onRequest", async (request, reply) => {
        reply.header("cache-control", "no-store");
        await guardStaffDoor(
          request,
          reply,
          {
            sessions: deps.sessions,
            origins: { dashboard: deps.dashboardOrigin, console: deps.consoleOrigin },
          },
          { kind: "staff", needsSession: request.routeOptions.config.access !== "public" },
        );
      });
      registerSignInRoutes(scope, deps);
      registerResetRoutes(scope, deps);
      registerSignUpRoutes(scope, deps);
      registerInviteRoutes(scope, deps);
      registerSessionRoutes(scope, deps);
      registerEmailChangeRoutes(scope, deps);
    },
    { prefix: "/v1/staff" },
  );
}
