import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  busy,
  challengeExpired,
  csrfRejected,
  emailUnavailable,
  invalidCode,
  invalidCredentials,
  invalidRequest,
  notFound,
  resendLimit,
  resendTooSoon,
  sessionExpired,
  tooManyAttempts,
  tooManyChallenges,
  unauthenticated,
} from "#src/auth/http-errors";
import { sessionLimitsFor } from "#src/auth/limits";
import {
  SESSION_COOKIE,
  clearedSessionCookie,
  readCookie,
  sessionCookie,
  type Sessions,
} from "#src/auth/session";
import type { Caller, SignIn } from "#src/auth/sign-in";

export type RouteInfo = Readonly<{ method: string; url: string; public: boolean }>;

export type StaffRoutesDeps = Readonly<{
  signIn: SignIn;
  sessions: Sessions;
  /** The one origin allowed to make state-changing requests with the session cookie. */
  dashboardOrigin: string;
}>;

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
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

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw invalidRequest();
  }
  return result.data;
}

function callerOf(request: FastifyRequest): Caller {
  const agent = request.headers["user-agent"];
  return { address: request.ip, userAgent: typeof agent === "string" ? agent.slice(0, 300) : null };
}

function waitThen(reply: FastifyReply, seconds: number): void {
  reply.header("retry-after", String(seconds));
}

/**
 * Cookie requests that change something must come from the dashboard's own origin. Browsers always send
 * Origin on such requests; sign-in steps carry no cookie yet, so they only refuse a *different* origin.
 */
function checkOrigin(request: FastifyRequest, origin: string, cookieRequired: boolean): void {
  if (SAFE_METHODS.has(request.method)) {
    return;
  }
  const sent = request.headers.origin;
  if (sent === undefined ? cookieRequired : sent !== origin) {
    throw csrfRejected();
  }
}

async function requireSession(
  request: FastifyRequest,
  reply: FastifyReply,
  sessions: Sessions,
): Promise<void> {
  const token = readCookie(request.headers.cookie, SESSION_COOKIE);
  if (token === undefined) {
    throw unauthenticated();
  }
  const result = await sessions.authenticate(token);
  if (result.kind === "valid") {
    request.staff = { account: result.account, sessionId: result.sessionId };
    request.principalId = result.account.id;
    return;
  }
  reply.header("set-cookie", clearedSessionCookie());
  throw result.kind === "none" ? unauthenticated() : sessionExpired();
}

function registerSignInRoutes(scope: FastifyInstance, deps: StaffRoutesDeps): void {
  const open = { config: { public: true }, bodyLimit: SIGN_IN_BODY_LIMIT } as const;

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
    const result = await deps.signIn.resend(body);
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

function registerSessionRoutes(scope: FastifyInstance, deps: StaffRoutesDeps): void {
  scope.get("/me", async (request) => {
    const { account } = request.staff ?? failClosed();
    return {
      id: account.id,
      email: account.email,
      platformRole: account.platformRole,
      memberships: await deps.sessions.memberships(account.id),
    };
  });

  scope.get("/sessions", async (request) => {
    const { account, sessionId } = request.staff ?? failClosed();
    const live = await deps.sessions.list(account.id, account.platformRole);
    return { sessions: live.map((session) => ({ ...session, current: session.id === sessionId })) };
  });

  scope.delete("/sessions/:id", async (request, reply) => {
    const { account, sessionId } = request.staff ?? failClosed();
    const { id } = parse(sessionParams, request.params);
    if (!(await deps.sessions.revoke(account.id, id))) {
      throw notFound();
    }
    if (id === sessionId) {
      reply.header("set-cookie", clearedSessionCookie());
    }
    return reply.code(204).send();
  });

  scope.post("/auth/sign-out", async (request, reply) => {
    const { account, sessionId } = request.staff ?? failClosed();
    await deps.sessions.revoke(account.id, sessionId);
    reply.header("set-cookie", clearedSessionCookie());
    return reply.code(204).send();
  });
}

/** Reached only if the scope's session hook was bypassed, which must never answer a request. */
function failClosed(): never {
  throw unauthenticated();
}

/**
 * Registers every /v1/staff route inside one scope whose hook demands a valid session unless the route is
 * on the explicit public list (the three sign-in steps). Forgetting to protect a new route is therefore
 * impossible: the default is closed. Returns the route inventory the tests walk.
 */
export function registerStaffRoutes(app: FastifyInstance, deps: StaffRoutesDeps): RouteInfo[] {
  const inventory: RouteInfo[] = [];
  app.register(
    async (scope) => {
      scope.addHook("onRoute", (route) => {
        const methods = Array.isArray(route.method) ? route.method : [route.method];
        for (const method of methods) {
          inventory.push({ method, url: route.url, public: route.config?.public === true });
        }
      });
      scope.addHook("onRequest", async (request, reply) => {
        reply.header("cache-control", "no-store");
        const isPublic = request.routeOptions.config.public === true;
        checkOrigin(request, deps.dashboardOrigin, !isPublic);
        if (!isPublic) {
          await requireSession(request, reply, deps.sessions);
        }
      });
      registerSignInRoutes(scope, deps);
      registerSessionRoutes(scope, deps);
    },
    { prefix: "/v1/staff" },
  );
  return inventory;
}
