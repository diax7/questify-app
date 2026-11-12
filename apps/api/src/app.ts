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
import { createAuthKeys, type AuthKeys } from "#src/auth/keys";
import { AUTH_LIMITS } from "#src/auth/limits";
import { createEmailChange, type EmailChangeDeps } from "#src/auth/email-change";
import { createStaffReauth } from "#src/auth/reauth";
import { createPasswords, type PasswordDeps } from "#src/auth/password-reset";
import { createSignUp } from "#src/auth/sign-up";
import { registerStaffRoutes } from "#src/auth/routes";
import { createSessions } from "#src/auth/session";
import { createSignIn, reasonOf } from "#src/auth/sign-in";
import { createVerifyGate } from "#src/auth/verify-gate";
import type { AppConfig } from "#src/config";
import { registerConventions } from "#src/conventions";
import { registerCompletionRoutes } from "#src/completions/routes";
import { createRewardCodeKeyring } from "#src/rewards/codes";
import { registerShopRoutes } from "#src/rewards/routes";
import { createEvents } from "#src/events/events";
import { registerPlayerGuard } from "#src/players/guard";
import { createSuspendedSet } from "#src/events/suspended-set";
import type { HomeDeps } from "#src/home/home";
import { registerHomeRoutes } from "#src/home/routes";
import { createFirstBonusCache, type FirstBonusCache } from "#src/quests/first-bonus";
import { registerOperatorAwardRoutes } from "#src/awards/routes";
import type { ObjectStore } from "#src/storage/client";
import { registerPhotoWallPlayerRoutes } from "#src/screen/routes";
import type { KioskDeps } from "#src/devices/kiosk";
import { registerImageReadRoutes } from "#src/storage/read-routes";
import { registerPhotoRoutes } from "#src/storage/routes";
import { startMediaWorker } from "#src/storage/worker";
import { registerSubmissionPlayerRoutes } from "#src/submissions/routes";
import { registerTicketRoutes } from "#src/tickets/routes";
import { registerGameRoutes, registerMeetRoutes, registerPlayRoutes } from "#src/plays/routes";
import { registerPassportRoutes } from "#src/passport/routes";
import { registerRevealRoutes } from "#src/reveal/routes";
import { registerDeskRoutes } from "#src/desk/routes";
import { registerNfcRoutes } from "#src/nfc/routes";
import { registerReviewDemoPlayerRoutes } from "#src/review-demo/routes";
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
import { registerPlayerSafetyRoutes } from "#src/reports/routes";
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
  type QuestCodeKey,
  type RevealCodeKey,
  type StepCodeKey,
} from "#src/quests/qr";
import { createRanking, type Ranking } from "#src/ranking/ranking";
import { registerRankingRoutes } from "#src/ranking/routes";
import type { RankingStore } from "#src/ranking/store";
import { startRankingTick } from "#src/ranking/tick";
import { startRankPushTick } from "#src/ranking/top-ten-tick";
import { startOrganizerAlertWorker } from "#src/organizer-alerts/worker";
import { startTeamAlertWorker } from "#src/team-alerts/worker";
import { startLifecycleTick } from "#src/events/tick";
import { startCommunityTick } from "#src/community/tick";
import { startSouvenirTick } from "#src/souvenirs/tick";
import type { InvitationDeps } from "#src/invitation-campaigns/campaigns";
import { registerPublicLinkRoutes } from "#src/public-links";
import { startInvitationTick } from "#src/invitation-campaigns/tick";
import { createPushDoors } from "#src/push/doors";
import type { PushProvider } from "#src/push/provider";
import { startPushWorker } from "#src/push/worker";
import { createInvites } from "#src/organizers/accept";
import { registerConsoleRoutes, type ConsoleRoutesDeps } from "#src/activation/routes";
import type { ConsoleOrganizerDeps } from "#src/console/routes";
import { createActivation } from "#src/activation/service";
import { registerLegalRoutes } from "#src/legal/routes";
import { registerOrganizerRoutes } from "#src/organizers/routes";
import { createTeam } from "#src/organizers/team";
import { registerRouteInventory, type RouteInfo } from "#src/route-access";
import { registerHttpTelemetry } from "#src/telemetry/http";
import { logTelemetry } from "#src/telemetry/logs";
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
  /** The team alert worker (T-701b): due owner email changes and the urgent-report digest, on the sign-in transport. */
  teamAlertIntervalMs?: number;
  /**
   * The push worker (T-501, ADR-345): its own small pool and the providers built from the settings (none without keys,
   * T-501b). Off when not given (tests call the doors); the fan-out and settle run whenever it is on, providers or not.
   */
  push?: Readonly<{ pool: Pool; providers: readonly PushProvider[] }>;
  /**
   * The private photo bucket (T-301b), built from the S3 settings. Without it the photo doors answer 503 `photos_off`,
   * the builder refuses photo quests, and no URL is signed.
   */
  storage?: ObjectStore;
  /** How often the media worker sweeps, purges and deletes (T-301b); off when not given (tests call `runOnce`). */
  mediaIntervalMs?: number;
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

/** The fields a device alarm adds to its log line. */
type LogFields = Readonly<Record<string, unknown>>;

/** Log level by environment, with secrets and keys removed from every log line. */
export function loggerOptions(config: AppConfig): ReturnType<typeof logTelemetry> & {
  level: string;
  redact: string[];
  serializers: { req: (request: FastifyRequest) => { method: string; url: string } };
} {
  return {
    ...logTelemetry(),
    level: config.nodeEnv === "production" ? "info" : "debug",
    // Method and route pattern only: the default serializer also writes the client address, which is personal data,
    // and the filled path can hold a rehearsal, join or other code, a username or a token, so the pattern
    // (`/v1/rehearsals/:code`) is logged, never the path. A path no route answers is anything a caller typed, so it
    // is written as `unmatched` (T-018, ADR-603); Fastify leaves the pattern unset on a 404.
    serializers: {
      req: (request) => ({
        method: request.method,
        url: request.routeOptions.url ?? "unmatched",
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

/** The top-10 rank push tick, the organizer alert worker and the team alert worker, each on when its option is given. */
function startAlertTicks(
  app: FastifyInstance,
  options: AppOptions,
  emailChange: EmailChangeDeps,
): (() => Promise<void>)[] {
  const stops: (() => Promise<void>)[] = [];
  if (options.teamAlertIntervalMs !== undefined) {
    const worker = startTeamAlertWorker({
      ...emailChange,
      mailFrom: options.config.auth.gmail.from,
      intervalMs: options.teamAlertIntervalMs,
      log: (level, fields) => app.log[level](fields),
    });
    stops.push(worker.stop);
  }
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
    emailChange: EmailChangeDeps;
  }>,
): void {
  const stops = startAlertTicks(app, options, deps.emailChange);
  startMedia(app, options);
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

/** What the console's routes share with the rest of the server. */
type ConsoleShared = Pick<
  ConsoleRoutesDeps,
  "activation" | "settings" | "sessions" | "invitations" | "translations"
> &
  Readonly<{
    keys: ReturnType<typeof createAuthKeys>;
    suspended: ConsoleOrganizerDeps["suspended"];
    emailChange: EmailChangeDeps;
  }>;

/**
 * The console's routes (T-210, T-312, T-409, T-609, T-701, T-702, T-704, T-709). `platform` carries what this server has set up for the
 * health view, as yes or no per transport: nothing secret.
 */
function registerConsole(app: FastifyInstance, options: AppOptions, shared: ConsoleShared): void {
  const { config, pool } = options;
  registerConsoleRoutes(app, {
    activation: shared.activation,
    settings: shared.settings,
    sessions: shared.sessions,
    dashboardOrigin: config.auth.dashboardOrigin,
    tickets: { pool, keys: shared.keys, storage: options.storage },
    questify: { pool },
    invitations: shared.invitations,
    translations: shared.translations,
    organizers: { pool, keys: shared.keys, suspended: shared.suspended },
    players: {
      pool,
      keys: shared.keys,
      idempotencyStore: options.idempotencyStore,
      storage: options.storage,
    },
    ownerEmail: {
      ...shared.emailChange,
      log: (event, fields) => app.log.error({ event, ...fields }),
    },
    moderationAddresses: { pool, keys: shared.keys, mailFrom: config.auth.gmail.from },
    reviewDemo: { pool, keys: shared.keys },
    platform: {
      pool,
      keys: shared.keys,
      transports: {
        sms: options.smsSender !== undefined,
        promoSms: options.promoSmsSender !== undefined,
        emailBackup: config.auth.resend !== undefined,
        alertEmail: options.organizerAlerts?.transport !== undefined,
        pushIos: config.push.apns !== undefined,
        pushAndroid: config.push.fcm !== undefined,
      },
    },
  });
}

/** Staff sign-in, password reset, sign-up, invites, sessions and the owner email change link (T-701b). */
function registerStaff(app: FastifyInstance, deps: PasswordDeps): void {
  const signIn = createSignIn(deps);
  registerStaffRoutes(app, {
    signIn,
    invites: createInvites(deps, signIn),
    sessions: createSessions(deps.pool),
    reauth: createStaffReauth(deps),
    passwords: createPasswords(deps),
    signUp: createSignUp(deps),
    emailChange: createEmailChange(deps),
    dashboardOrigin: deps.dashboardOrigin,
  });
}

/**
 * The bare server: its logger, the proxies it trusts, the route inventory, the request span (first, so every other
 * hook and the handler run inside it, T-018, ADR-601) and JSON as the only body a handler may receive, a body carrying
 * `__proto__` or `constructor.prototype` refused.
 */
function createServer(options: AppOptions): FastifyInstance {
  const { config } = options;
  const app = Fastify({
    logger: options.logger ?? loggerOptions(config),
    genReqId: () => randomUUID(),
    // Trust exactly the proxies we run (hop 0 is the nearest); a client-sent X-Forwarded-For beyond them is ignored.
    trustProxy: (_address: string, hop: number) => hop < config.trustProxyHops,
    // Fastify's defaults today, pinned so a dependency update cannot loosen them (V15.3.6, T-810b).
    onProtoPoisoning: "error",
    onConstructorPoisoning: "error",
  });
  app.decorate("routeInventory", registerRouteInventory(app));
  registerHttpTelemetry(app);
  app.removeContentTypeParser("text/plain");
  return app;
}

/** What the operator routes need (T-204), with the organizer throttle key for email invites (ADR-823). */
function operatorDepsOf(options: AppOptions, keys: AuthKeys) {
  return {
    pool: options.pool,
    keys,
    inviteKey: createInviteCodeKey(options.config.qrSecret),
    email: options.emailSender,
    dashboardOrigin: options.config.auth.dashboardOrigin,
  };
}

/** The kiosk's doors' dependencies (T-309b): the pool and the player code key from the options, the rest given. */
const kioskDepsOf = (options: AppOptions, deps: Omit<KioskDeps, "pool" | "myKey">): KioskDeps => ({
  ...deps,
  pool: options.pool,
  myKey: createMyCodeKey(options.config.qrSecret),
});

/** Builds the API server. Nothing listens until the caller starts it. */
/** The Home doors' dependencies, with whether this server stores photos (T-301b). */
const homeDepsOf = (
  options: AppOptions,
  settings: SettingsService,
  firstBonus: FirstBonusCache,
): HomeDeps => ({
  pool: options.pool,
  settings,
  firstBonus,
  photos: options.storage !== undefined,
});

/** The after-answer work (given, or made here), drained for up to 5 s when the server closes. */
function drainedDeferred(app: FastifyInstance, options: AppOptions): Deferred {
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
  return deferred;
}

export function buildApp(options: AppOptions): FastifyInstance {
  const { config } = options;
  const app = createServer(options);

  registerConventions(app, {
    minAppVersion: config.minAppVersion,
    idempotencyStore: options.idempotencyStore,
  });

  const signInDeps = {
    pool: options.pool,
    keys: createAuthKeys(config.auth.secret, config.auth),
    email: options.emailSender,
    gate: createVerifyGate(AUTH_LIMITS.verifyGate),
    securityAlertEmail: config.auth.securityAlertEmail,
  };
  const deferred = drainedDeferred(app, options);
  const passwordDeps = {
    ...signInDeps,
    breachCheck: options.breachCheck,
    deferred,
    dashboardOrigin: config.auth.dashboardOrigin,
  };
  registerStaff(app, passwordDeps);

  const questCodeKey = createQuestCodeKey(config.qrSecret);
  const stepCodeKey = createStepCodeKey(config.qrSecret);
  const revealCodeKey = createRevealCodeKey(config.qrSecret);
  const operatorDeps = operatorDepsOf(options, signInDeps.keys);
  const settings = options.settings ?? createSettingsService({ pool: options.pool });
  // One per instance, shared by the quests read and the live read (T-313, ADR-263).
  const firstBonus = createFirstBonusCache();
  const ranking = createRanking({
    pool: options.pool,
    store: options.rankingStore,
    log: (level, fields) => app.log[level](fields),
  });
  const suspended = createSuspendedSet(options.pool);
  registerPlayerGuard(app, options.pool, suspended, settings);
  const playerMail = {
    pool: options.pool,
    keys: signInDeps.keys,
    sms: options.smsSender ?? NO_SMS,
    email: options.emailSender,
  };
  registerPlayerAuthRoutes(
    app,
    createPlayerSignIn({ ...playerMail, appealEmail: config.auth.gmail.from }),
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
  registerPlayerSafetyRoutes(app, { pool: options.pool, keys: signInDeps.keys });
  registerQuestifyRoutes(app, { pool: options.pool, keys: signInDeps.keys });
  registerContactRoutes(app, { ...playerMail, settings });
  registerDeletionRoutes(app, {
    ...playerMail,
    deferred,
    idempotencyStore: options.idempotencyStore,
  });
  registerJoinRoutes(app, { pool: options.pool, keys: signInDeps.keys, settings });
  const rehearsal = createRehearsal({ pool: options.pool, keys: signInDeps.keys });
  registerRehearsalPlayerRoutes(app, rehearsal);
  registerHomeRoutes(app, homeDepsOf(options, settings, firstBonus));
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
  registerPlayDoors(app, config, {
    pool: options.pool,
    keys: signInDeps.keys,
    settings,
    ranking,
    firstBonus,
    codeKeys: { codeKey: questCodeKey, stepKey: stepCodeKey, revealKey: revealCodeKey },
    storage: options.storage,
  });
  const deviceClaims = {
    pool: options.pool,
    keys: signInDeps.keys,
    alarm: (event: string, fields: LogFields) => app.log.error({ event, ...fields }),
  };
  const deviceDeps = {
    ...deviceClaims,
    screenKey,
    settings,
    dashboardOrigin: config.auth.dashboardOrigin,
  };
  registerDeviceGuard(app, { pool: options.pool, dashboardOrigin: config.auth.dashboardOrigin });
  const liveKey = createLiveCodeKey(config.qrSecret);
  const kiosk = { liveKey, keys: signInDeps.keys, settings, ranking };
  registerDeviceRoutes(app, {
    ...deviceDeps,
    storage: options.storage,
    kiosk: kioskDepsOf(options, kiosk),
  });
  registerLiveCodeRoute(app, { pool: options.pool, liveKey, keys: signInDeps.keys, settings });
  registerDeviceOperatorRoutes(app, { ...deviceDeps, claims: deviceClaims });
  registerPassportRoutes(app, { pool: options.pool, stepKey: stepCodeKey, ranking });
  registerRevealRoutes(app, { pool: options.pool, revealKey: revealCodeKey });
  registerResultsPlayerRoutes(app, { pool: options.pool, settings });
  const rewardCodeKey = createRewardCodeKeyring(config.rewardCodes);
  registerShopRoutes(app, {
    pool: options.pool,
    settings,
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
  const translations = options.translations ?? createTranslationService({ pool: options.pool });
  registerConsole(app, options, {
    activation,
    settings,
    sessions: staffSessions,
    invitations,
    keys: signInDeps.keys,
    suspended,
    translations,
    emailChange: passwordDeps,
  });
  registerOrganizerRoutes(app, {
    pool: options.pool,
    sessions: staffSessions,
    activation,
    rehearsal,
    team: createTeam(passwordDeps),
    events: createEvents({ pool: options.pool, log: (level, fields) => app.log[level](fields) }),
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
    suspended,
    dashboardOrigin: config.auth.dashboardOrigin,
    storage: options.storage,
  });
  registerPublicLinkRoutes(app, { pool: options.pool, keys: signInDeps.keys });

  startTicks(app, options, {
    settings,
    keys: signInDeps.keys,
    invitations,
    emailChange: passwordDeps,
  });
  registerPlatformReads(app, options.pool, { settings, translations });
  registerHealthRoutes(app, options);
  return app;
}

/** The media worker (T-301b), when this server has a bucket and an interval. */
function startMedia(app: FastifyInstance, options: AppOptions): void {
  if (options.storage === undefined || options.mediaIntervalMs === undefined) return;
  const worker = startMediaWorker({
    pool: options.pool,
    store: options.storage,
    intervalMs: options.mediaIntervalMs,
    log: (level, fields) => app.log[level](fields),
  });
  app.addHook("onClose", worker.stop);
}

type PlayDoorDeps = Readonly<{
  pool: Pool;
  keys: AuthKeys;
  settings: SettingsService;
  ranking: Ranking;
  firstBonus: FirstBonusCache;
  codeKeys: Readonly<{ codeKey: QuestCodeKey; stepKey: StepCodeKey; revealKey: RevealCodeKey }>;
  storage: ObjectStore | undefined;
}>;

/**
 * The player's play doors beside the scan: operator awards, submissions, help tickets, votes and quizzes, meet, games,
 * the App Review demo's code picker (T-710b) and NFC taps.
 */
function registerPlayDoors(app: FastifyInstance, config: AppConfig, deps: PlayDoorDeps): void {
  const { pool, keys, settings, ranking, firstBonus, storage } = deps;
  registerOperatorAwardRoutes(app, { pool, keys });
  registerSubmissionPlayerRoutes(app, { pool, ranking, storage });
  registerTicketRoutes(app, { pool, settings, keys, storage });
  registerPhotoRoutes(app, { pool, storage });
  registerImageReadRoutes(app, { pool, storage });
  registerPhotoWallPlayerRoutes(app, { pool, storage });
  registerPlayRoutes(app, { pool, ranking, settings, firstBonus });
  registerMeetRoutes(app, { pool, ranking, settings, keys });
  registerGameRoutes(app, { pool, ranking, keys });
  const tagKey = createTagCodeKey(config.qrSecret);
  const origin = config.auth.dashboardOrigin;
  registerReviewDemoPlayerRoutes(app, { ...deps.codeKeys, pool, keys, origin });
  registerNfcRoutes(app, {
    pool,
    tagKey,
    ticketKey: createTicketKey(config.qrSecret),
    keys,
    settings,
    dashboardOrigin: origin,
    ranking,
  });
}

/** The public reads of platform data: the configuration, the legal texts and help articles, and the shipped texts. */
function registerPlatformReads(
  app: FastifyInstance,
  pool: Pool,
  services: Readonly<{ settings: SettingsService; translations: TranslationService }>,
): void {
  registerConfigRoutes(app, services.settings);
  registerLegalRoutes(app, { pool });
  registerTranslationRoutes(app, services.translations);
}

/** Liveness (the release it runs) and readiness (the database answers), both public and never cached. */
function registerHealthRoutes(app: FastifyInstance, options: AppOptions): void {
  app.get("/healthz", { config: { access: "public" } }, async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return { status: "ok", release: options.config.releaseSha };
  });

  app.get("/readyz", { config: { access: "public" } }, async (_request, reply) => {
    reply.header("cache-control", "no-store");
    const database = await databaseReady(options.pool);
    return reply.code(database ? 200 : 503).send({
      status: database ? "ok" : "unavailable",
      checks: { database: database ? "ok" : "down" },
    });
  });
}
