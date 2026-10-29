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
import { createFirstBonusCache } from "#src/quests/first-bonus";
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
import { registerItemRoutes } from "#src/players/item-routes";
import { registerProfileRoutes } from "#src/players/profile";
import { registerQuestifyRoutes } from "#src/questify/routes";
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
import { startRankPushTick } from "#src/ranking/top-ten-tick";
import { startOrganizerAlertWorker } from "#src/organizer-alerts/worker";
import { startLifecycleTick } from "#src/events/tick";
import { startCommunityTick } from "#src/community/tick";
import { startSouvenirTick } from "#src/souvenirs/tick";
import type { InvitationDeps } from "#src/invitation-campaigns/campaigns";
import { registerInvitationOpenRoute } from "#src/invitation-campaigns/routes";
import { startInvitationTick } from "#src/invitation-campaigns/tick";
import { createPushDoors } from "#src/push/doors";
import type { PushProvider } from "#src/push/provider";
import { startPushWorker } from "#src/push/worker";
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
  /**
   * Sends Questify invitations from the promotional "-AD" sender (T-409, FR-1112), never the service one. Without it
   * invitation SMS cannot be approved and nothing is sent.
   */
  promoSmsSender?: SmsSender;
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
  souvenirIntervalMs?: number;
  /** How often invitations are started, sent and settled (ADR-333); off when not given (tests call the doors). */
  invitationIntervalMs?: number;
  /** How often each live event's top ten is diffed for the rank push (T-503, ADR-362); off when not given. */
  rankPushIntervalMs?: number;
  /**
   * The organizer alert worker (T-503, FR-1727): settles the outbox and scans flags every interval, and sends only with a
   * transport. Production gives none (transport OFF, ADR-360), so nothing leaves the machine. Off when not given.
   */
  organizerAlerts?: Readonly<{ intervalMs: number; transport?: EmailSender }>;
  /**
   * The push worker (T-501, ADR-345): its own small pool and the providers built from the settings (none without keys,
   * T-501b). Off when not given (tests call the doors); the fan-out and settle run whenever it is on, providers or not.
   */
  push?: Readonly<{ pool: Pool; providers: readonly PushProvider[] }>;
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
    serializers: {
      req: (request) => ({
        method: request.method,
        url: (request.url.split("?")[0] ?? "/").replace(
          /^\/v1\/players\/[^/]+/,
          "/v1/players/:username",
        ),
      }),
    },
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

/** The top-10 rank push tick and the organizer alert worker, each on when its option is given. */
function startAlertTicks(app: FastifyInstance, options: AppOptions): (() => Promise<void>)[] {
  const stops: (() => Promise<void>)[] = [];
  if (options.rankPushIntervalMs !== undefined) {
    const tick = startRankPushTick({
      pool: options.pool,
      intervalMs: options.rankPushIntervalMs,
      log: (level, fields) => app.log[level](fields),
    });
    stops.push(tick.stop);
  }
  if (options.organizerAlerts !== undefined) {
    const worker = startOrganizerAlertWorker({
      pool: options.pool,
      ...(options.organizerAlerts.transport === undefined
        ? {}
        : { transport: options.organizerAlerts.transport }),
      dashboardOrigin: options.config.auth.dashboardOrigin,
      intervalMs: options.organizerAlerts.intervalMs,
      log: (level, fields) => app.log[level](fields),
    });
    stops.push(worker.stop);
  }
  return stops;
}

/**
 * The background ticks each option turns on (tests leave them off and call the database functions): event lifecycle,
 * community goals, souvenirs, invitations, the rank push and organizer alerts. Each stops when the server closes.
 */
function startTicks(
  app: FastifyInstance,
  options: AppOptions,
  deps: Readonly<{
    settings: SettingsService;
    keys: ReturnType<typeof createAuthKeys>;
    invitations: InvitationDeps;
  }>,
): void {
  const stops = startAlertTicks(app, options);
  if (options.lifecycleIntervalMs !== undefined) {
    const tick = startLifecycleTick({
      pool: options.pool,
      intervalMs: options.lifecycleIntervalMs,
      log: (level, fields) => app.log[level](fields),
    });
    stops.push(tick.stop);
  }
  if (options.communityIntervalMs !== undefined) {
    const tick = startCommunityTick({
      pool: options.pool,
      settings: deps.settings,
      intervalMs: options.communityIntervalMs,
      log: (level, fields) => app.log[level](fields),
    });
    stops.push(tick.stop);
  }
  if (options.souvenirIntervalMs !== undefined) {
    const tick = startSouvenirTick({
      pool: options.pool,
      intervalMs: options.souvenirIntervalMs,
      log: (fields) => app.log.error(fields),
    });
    stops.push(tick.stop);
  }
  if (options.invitationIntervalMs !== undefined) {
    const tick = startInvitationTick({
      ...deps.invitations,
      settings: deps.settings,
      keys: deps.keys,
      intervalMs: options.invitationIntervalMs,
      log: (level, fields) => app.log[level](fields),
    });
    stops.push(tick.stop);
  }
  if (options.push !== undefined) {
    const worker = startPushWorker({
      doors: createPushDoors(options.push.pool),
      providers: options.push.providers,
      settings: deps.settings,
      log: (level, fields) => app.log[level](fields),
      production: options.config.nodeEnv === "production",
    });
    stops.push(worker.stop);
  }
  for (const stop of stops) app.addHook("onClose", stop);
}

/**
 * The invitation doors' dependencies: the promotional SMS sender when set, and whether both push providers are set up
 * (a player chosen for push on a platform without its provider would get neither push nor the SMS), so the console
 * offers only the channels this server can send (ADR-331 (1), ADR-356 (4)).
 */
export function invitationDepsOf(
  options: Pick<AppOptions, "config" | "pool" | "promoSmsSender">,
): InvitationDeps {
  const { push } = options.config;
  return {
    pool: options.pool,
    ...(options.promoSmsSender === undefined ? {} : { promoSms: options.promoSmsSender }),
    pushReady: push.apns !== undefined && push.fcm !== undefined,
  };
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
  // One per instance, shared by the quests read and the live read (T-313, ADR-263).
  const firstBonus = createFirstBonusCache();
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
  registerItemRoutes(app, { pool: options.pool, keys: signInDeps.keys });
  registerQuestifyRoutes(app, { pool: options.pool, keys: signInDeps.keys });
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
  registerHomeRoutes(app, { pool: options.pool, settings, firstBonus });
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
  registerPlayRoutes(app, { pool: options.pool, ranking, settings, firstBonus });
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
  const invitations = invitationDepsOf(options);
  const staffSessions = createSessions(options.pool);
  registerConsoleRoutes(app, {
    activation,
    settings,
    sessions: staffSessions,
    dashboardOrigin: config.auth.dashboardOrigin,
    tickets: { pool: options.pool, keys: signInDeps.keys },
    questify: { pool: options.pool },
    invitations,
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
    invitations,
    dashboardOrigin: config.auth.dashboardOrigin,
  });
  registerInvitationOpenRoute(app, { pool: options.pool, keys: signInDeps.keys });

  startTicks(app, options, { settings, keys: signInDeps.keys, invitations });
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
