import { randomUUID } from "node:crypto";
import Fastify, {
  type FastifyInstance,
  type FastifyRequest,
  type FastifyServerOptions,
} from "fastify";
import type { Pool } from "pg";
import type { BreachCheck } from "#src/auth/breached";
import { createDeferred, type Deferred } from "#src/auth/deferred";
import { registerDeletionRoutes } from "#src/deletion/routes";
import type { EmailSender } from "#src/auth/email/sender";
import { createAuthKeys } from "#src/auth/keys";
import { AUTH_LIMITS } from "#src/auth/limits";
import { createPasswords } from "#src/auth/password-reset";
import { createSignUp } from "#src/auth/sign-up";
import { registerStaffRoutes } from "#src/auth/routes";
import { createSessions } from "#src/auth/session";
import { createSignIn, reasonOf } from "#src/auth/sign-in";
import { createVerifyGate } from "#src/auth/verify-gate";
import type { AppConfig } from "#src/config";
import { registerConventions } from "#src/conventions";
import { registerCompletionRoutes } from "#src/completions/routes";
import { createRewardCodeKey } from "#src/rewards/codes";
import { registerShopRoutes } from "#src/rewards/routes";
import { createEvents } from "#src/events/events";
import { registerPlayerGuard } from "#src/players/guard";
import { registerHomeRoutes } from "#src/home/routes";
import { registerOperatorAwardRoutes } from "#src/awards/routes";
import { registerSubmissionPlayerRoutes } from "#src/submissions/routes";
import { registerTicketRoutes } from "#src/tickets/routes";
import { registerGameRoutes, registerMeetRoutes, registerPlayRoutes } from "#src/plays/routes";
import { registerPassportRoutes } from "#src/passport/routes";
import { registerRevealRoutes } from "#src/reveal/routes";
import { registerDeskRoutes } from "#src/desk/routes";
import { registerNfcRoutes } from "#src/nfc/routes";
import { registerDeviceGuard } from "#src/devices/guard";
import {
  registerDeviceOperatorRoutes,
  registerDeviceRoutes,
  registerLiveCodeRoute,
} from "#src/devices/routes";
import { createTicketKey } from "#src/nfc/ticket";
import { registerOperatorPlayerRoutes } from "#src/operators/routes";
import { registerJoinRoutes } from "#src/join/routes";
import { registerResultsPlayerRoutes } from "#src/results/routes";
import { registerRehearsalPlayerRoutes } from "#src/rehearsal/routes";
import { createRehearsal } from "#src/rehearsal/service";
import { registerContactRoutes } from "#src/players/contact";
import { registerProfileRoutes } from "#src/players/profile";
import { registerPlayerAuthRoutes } from "#src/players/routes";
import { createPlayerSignIn } from "#src/players/sign-in";
import type { SmsSender } from "#src/players/sms";
import {
  createInviteCodeKey,
  createLiveCodeKey,
  createMyCodeKey,
  createQuestCodeKey,
  createRevealCodeKey,
  createScreenCodeKey,
  createStepCodeKey,
  createTagCodeKey,
} from "#src/quests/qr";
import { createRanking } from "#src/ranking/ranking";
import { registerRankingRoutes } from "#src/ranking/routes";
import type { RankingStore } from "#src/ranking/store";
import { startRankingTick } from "#src/ranking/tick";
import { startLifecycleTick } from "#src/events/tick";
import { startCommunityTick } from "#src/community/tick";
import { createInvites } from "#src/organizers/accept";
import { registerConsoleRoutes } from "#src/activation/routes";
import { createActivation } from "#src/activation/service";
import { registerOrganizerRoutes } from "#src/organizers/routes";
import { createTeam } from "#src/organizers/team";
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
  /** Sends player sign-in codes by SMS (Msegat). Without one, every SMS is refused and the app offers email. */
  smsSender?: SmsSender;
  /** Work that runs after an answer has gone. Created when not given; tests give one to wait on. */
  deferred?: Deferred;
  /** Reads and saves configuration. Created from the pool when not given (tests give one with a short cache). */
  settings?: SettingsService;
  /** Reads and saves the translation store. Created from the pool when not given. */
  translations?: TranslationService;
  logger?: FastifyServerOptions["logger"];
  /** How often events move through their lifecycle; off when not given (tests call the database function). */
  lifecycleIntervalMs?: number;
  /** The Redis copy of the rankings (ADR-118); without one, rankings are read from PostgreSQL. */
  rankingStore?: RankingStore;
  /** How often marked rankings are repaired; off when not given (tests call `repairDue`). */
  rankingRepairIntervalMs?: number;
  /** How often community goals are settled and paid (ADR-222); off when not given (tests call the functions). */
  communityIntervalMs?: number;
}>;

declare module "fastify" {
  interface FastifyInstance {
    /** Every route with who may call it; the tests walk it. */
    routeInventory: RouteInfo[];
  }
}

const READINESS_TIMEOUT_MS = 2000;

/** Stands in when no SMS gateway is configured (development, tests that do not send SMS). */
const NO_SMS: SmsSender = {
  name: "none",
  send: () => Promise.resolve({ kind: "refused", reason: "not_configured" }),
};
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
  const passwordDeps = {
    ...signInDeps,
    breachCheck: options.breachCheck,
    deferred,
    dashboardOrigin: config.auth.dashboardOrigin,
  };
  const signIn = createSignIn(signInDeps);
  registerStaffRoutes(app, {
    signIn,
    invites: createInvites(passwordDeps, signIn),
    sessions: createSessions(options.pool),
    passwords: createPasswords(passwordDeps),
    signUp: createSignUp(passwordDeps),
    dashboardOrigin: config.auth.dashboardOrigin,
  });

  const questCodeKey = createQuestCodeKey(config.qrSecret);
  const stepCodeKey = createStepCodeKey(config.qrSecret);
  const revealCodeKey = createRevealCodeKey(config.qrSecret);
  const operatorDeps = {
    pool: options.pool,
    inviteKey: createInviteCodeKey(config.qrSecret),
    email: options.emailSender,
    dashboardOrigin: config.auth.dashboardOrigin,
  };
  const settings = options.settings ?? createSettingsService({ pool: options.pool });
  const ranking = createRanking({
    pool: options.pool,
    store: options.rankingStore,
    log: (level, fields) => app.log[level](fields),
  });
  registerPlayerGuard(app, options.pool);
  registerPlayerAuthRoutes(
    app,
    createPlayerSignIn({
      pool: options.pool,
      keys: signInDeps.keys,
      sms: options.smsSender ?? NO_SMS,
      email: options.emailSender,
    }),
  );
  const screenKey = createScreenCodeKey(config.qrSecret);
  registerCompletionRoutes(app, {
    pool: options.pool,
    codeKey: questCodeKey,
    screenKey,
    keys: signInDeps.keys,
    settings,
    ranking,
  });
  registerRankingRoutes(app, { ranking, settings });
  registerProfileRoutes(app, { pool: options.pool, settings });
  registerContactRoutes(app, {
    pool: options.pool,
    settings,
    keys: signInDeps.keys,
    sms: options.smsSender ?? NO_SMS,
    email: options.emailSender,
  });
  registerDeletionRoutes(app, {
    pool: options.pool,
    keys: signInDeps.keys,
    sms: options.smsSender ?? NO_SMS,
    email: options.emailSender,
    deferred,
    idempotencyStore: options.idempotencyStore,
  });
  registerJoinRoutes(app, { pool: options.pool, keys: signInDeps.keys, settings });
  const rehearsal = createRehearsal({ pool: options.pool, keys: signInDeps.keys });
  registerRehearsalPlayerRoutes(app, rehearsal);
  registerHomeRoutes(app, { pool: options.pool, settings });
  registerOperatorPlayerRoutes(app, {
    ...operatorDeps,
    myKey: createMyCodeKey(config.qrSecret),
    ranking,
    keys: signInDeps.keys,
  });
  registerDeskRoutes(app, {
    pool: options.pool,
    myKey: createMyCodeKey(config.qrSecret),
    keys: signInDeps.keys,
  });
  registerOperatorAwardRoutes(app, { pool: options.pool, keys: signInDeps.keys });
  registerSubmissionPlayerRoutes(app, { pool: options.pool, ranking });
  registerTicketRoutes(app, { pool: options.pool, settings, keys: signInDeps.keys });
  registerPlayRoutes(app, { pool: options.pool, ranking, settings });
  registerMeetRoutes(app, { pool: options.pool, ranking, settings, keys: signInDeps.keys });
  registerGameRoutes(app, { pool: options.pool, ranking, settings, keys: signInDeps.keys });
  registerNfcRoutes(app, {
    pool: options.pool,
    tagKey: createTagCodeKey(config.qrSecret),
    ticketKey: createTicketKey(config.qrSecret),
    keys: signInDeps.keys,
    settings,
    dashboardOrigin: config.auth.dashboardOrigin,
    ranking,
  });
  const deviceClaims = {
    pool: options.pool,
    keys: signInDeps.keys,
    alarm: (event: string, fields: Readonly<Record<string, unknown>>) =>
      app.log.error({ event, ...fields }),
  };
  const deviceDeps = {
    ...deviceClaims,
    screenKey,
    settings,
    dashboardOrigin: config.auth.dashboardOrigin,
  };
  registerDeviceGuard(app, { pool: options.pool, dashboardOrigin: config.auth.dashboardOrigin });
  const liveKey = createLiveCodeKey(config.qrSecret);
  registerDeviceRoutes(app, {
    ...deviceDeps,
    kiosk: {
      pool: options.pool,
      liveKey,
      myKey: createMyCodeKey(config.qrSecret),
      keys: signInDeps.keys,
      settings,
      ranking,
    },
  });
  registerLiveCodeRoute(app, { pool: options.pool, liveKey, keys: signInDeps.keys, settings });
  registerDeviceOperatorRoutes(app, { ...deviceDeps, claims: deviceClaims });
  registerPassportRoutes(app, { pool: options.pool, stepKey: stepCodeKey, ranking });
  registerRevealRoutes(app, { pool: options.pool, revealKey: revealCodeKey });
  registerResultsPlayerRoutes(app, { pool: options.pool });
  const rewardCodeKey = createRewardCodeKey(config.rewardCodeSecret);
  registerShopRoutes(app, {
    pool: options.pool,
    codeKey: rewardCodeKey,
    log: (fields) => app.log.error(fields),
  });
  if (options.rankingRepairIntervalMs !== undefined) {
    const tick = startRankingTick(ranking, options.rankingRepairIntervalMs, (fields) =>
      app.log.error(fields),
    );
    app.addHook("onClose", tick.stop);
  }

  const activation = createActivation({ pool: options.pool, onAddonsChanged: settings.forget });
  const staffSessions = createSessions(options.pool);
  registerConsoleRoutes(app, {
    activation,
    settings,
    sessions: staffSessions,
    dashboardOrigin: config.auth.dashboardOrigin,
  });
  registerOrganizerRoutes(app, {
    pool: options.pool,
    sessions: staffSessions,
    activation,
    rehearsal,
    team: createTeam(passwordDeps),
    events: createEvents({ pool: options.pool }),
    settings,
    questCodes: {
      codeKey: questCodeKey,
      stepKey: stepCodeKey,
      revealKey: revealCodeKey,
      codeOrigin: config.auth.dashboardOrigin,
    },
    rewardCodeKey,
    operators: operatorDeps,
    ranking,
    devices: deviceClaims,
    dashboardOrigin: config.auth.dashboardOrigin,
  });

  if (options.lifecycleIntervalMs !== undefined) {
    const tick = startLifecycleTick({
      pool: options.pool,
      intervalMs: options.lifecycleIntervalMs,
      log: (level, fields) => app.log[level](fields),
    });
    app.addHook("onClose", tick.stop);
  }

  if (options.communityIntervalMs !== undefined) {
    const tick = startCommunityTick({
      pool: options.pool,
      settings,
      intervalMs: options.communityIntervalMs,
      log: (level, fields) => app.log[level](fields),
    });
    app.addHook("onClose", tick.stop);
  }

  registerConfigRoutes(app, settings);

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
