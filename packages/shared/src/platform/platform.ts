import { z } from "zod";

/**
 * The console's platform pages (T-709): the health view (FR-1783), the platform numbers (FR-1419) and the admin
 * accounts with their sessions (FR-1785). The database doors (migration 0117) answer counts and flags only; the health
 * facts are turned into six tiles here, so the API and the tests read one set of rules. No secret, token, message
 * text or player contact is in any of these shapes.
 */

/** A health count read through `LIMIT 10001` stops at this value: the page shows "10,000+". */
export const HEALTH_COUNT_CAP = 10_001;

/**
 * The numbers that turn a fact into a warning or a down state. Constants until the console has tuning numbers
 * (T-703); a threshold changed here changes the tiles and nothing stored.
 */
export const HEALTH_LIMITS = {
  /** The database door answered slower than this: a warning. */
  databaseSlowMs: 1500,
  /** The oldest waiting push, in seconds: a warning at 10 minutes, down at an hour. */
  queueWarnSeconds: 600,
  queueDownSeconds: 3600,
  /** The oldest waiting alert email or notice: a warning at 15 minutes. */
  mailWarnSeconds: 900,
  /** Invitation messages delivered in the last 7 days: judged from this many attempts, so a handful never alarms. */
  deliveryMinAttempts: 20,
  deliveryWarnPercent: 90,
  deliveryDownPercent: 50,
} as const;

const count = z.number().int().min(0);
const seconds = count.nullable();
const textSchema = z.strictObject({ ar: z.string().nullable(), en: z.string().nullable() });
const queue = z.strictObject({
  queued: count,
  oldestSeconds: seconds,
  stuck: count,
  failedDay: count,
});

/** What `console_health()` answers (migration 0117). */
export const healthFactsSchema = z.strictObject({
  events: z.strictObject({
    live: count,
    scheduled: count,
    suspended: count,
    overdue: count,
    busiest: z
      .array(
        z.strictObject({ id: z.uuid(), name: textSchema, organizer: z.string(), entries: count }),
      )
      .max(5),
  }),
  push: queue,
  alerts: queue,
  fanOut: z.strictObject({ waiting: count, failing: count, oldestSeconds: seconds }),
  souvenirs: z.strictObject({ waiting: count, failing: count, stuck: count, held: count }),
  invitations: z.strictObject({
    sending: count,
    stuck: count,
    sentWeek: count,
    failedWeek: count,
    unknownWeek: count,
  }),
  holds: z.array(
    z.strictObject({
      channel: z.enum(["push", "sms", "email"]),
      until: z.string(),
      code: z.string(),
    }),
  ),
});
export type HealthFacts = z.infer<typeof healthFactsSchema>;

/** What this server has set up, from its configuration: yes or no, never a key, a sender or an address. */
export type Transports = Readonly<{
  sms: boolean;
  promoSms: boolean;
  emailBackup: boolean;
  alertEmail: boolean;
  pushIos: boolean;
  pushAndroid: boolean;
}>;

export const HEALTH_TILES = ["database", "events", "push", "sms", "email", "background"] as const;
export type HealthTileKey = (typeof HEALTH_TILES)[number];

export const HEALTH_STATES = ["ok", "warning", "down"] as const;
export type HealthState = (typeof HEALTH_STATES)[number];

/** Each fact's name: the console shows `console.health.fact.<name>`. */
export const HEALTH_FACT_KEYS = [
  "databaseMs",
  "eventsLive",
  "eventsScheduled",
  "eventsSuspended",
  "eventsOverdue",
  "queued",
  "oldest",
  "stuck",
  "failedDay",
  "iosSetUp",
  "androidSetUp",
  "deliveredPercent",
  "sentWeek",
  "failedWeek",
  "unknownWeek",
  "smsSetUp",
  "promoSetUp",
  "emailBackupSetUp",
  "alertEmailSetUp",
  "paused",
  "pausedCode",
  "fanOutWaiting",
  "fanOutFailing",
  "fanOutOldest",
  "souvenirWaiting",
  "souvenirFailing",
  "souvenirStuck",
  "souvenirHeld",
  "invitationsSending",
  "invitationsStuck",
] as const;
export type HealthFactKey = (typeof HEALTH_FACT_KEYS)[number];

/** Why a tile is not OK: the console shows `console.health.reason.<name>`. */
export const HEALTH_REASONS = [
  "slow",
  "overdue",
  "oldest",
  "stuck",
  "failing",
  "notSetUp",
  "paused",
  "lowDelivery",
] as const;
export type HealthReason = (typeof HEALTH_REASONS)[number];

const FACT_KINDS = ["count", "seconds", "percent", "millis", "time", "text", "setup"] as const;

/** One figure: `count` (capped at 10,001), `seconds`, `percent`, `millis`, `time` (ISO), `text` or `setup` (1 or 0). */
export const healthFactSchema = z.strictObject({
  key: z.enum(HEALTH_FACT_KEYS),
  kind: z.enum(FACT_KINDS),
  value: z.number().or(z.string()).nullable(),
});
export type HealthFact = z.infer<typeof healthFactSchema>;

export const healthTileSchema = z.strictObject({
  key: z.enum(HEALTH_TILES),
  state: z.enum(HEALTH_STATES),
  reasons: z.array(z.enum(HEALTH_REASONS)),
  figure: healthFactSchema,
  facts: z.array(healthFactSchema),
});
export type HealthTile = z.infer<typeof healthTileSchema>;

/** `GET /v1/admin/health`. */
export const healthViewSchema = z.strictObject({
  at: z.string(),
  tiles: z.array(healthTileSchema).length(HEALTH_TILES.length),
  busiest: healthFactsSchema.shape.events.shape.busiest,
});
export type HealthView = z.infer<typeof healthViewSchema>;

const fact = (
  key: HealthFactKey,
  kind: HealthFact["kind"],
  value: HealthFact["value"],
): HealthFact => ({
  key,
  kind,
  value,
});
const setup = (key: HealthFactKey, on: boolean): HealthFact => fact(key, "setup", on ? 1 : 0);

const RANK: Readonly<Record<HealthState, number>> = { ok: 0, warning: 1, down: 2 };

type Verdict = Readonly<{ state: HealthState; reasons: HealthReason[] }>;

/** The worst of several verdicts, with each reason once. */
function worst(verdicts: readonly Verdict[]): Verdict {
  let state: HealthState = "ok";
  const reasons: HealthReason[] = [];
  for (const verdict of verdicts) {
    if (RANK[verdict.state] > RANK[state]) {
      state = verdict.state;
    }
    for (const reason of verdict.reasons) {
      if (verdict.state !== "ok" && !reasons.includes(reason)) {
        reasons.push(reason);
      }
    }
  }
  return { state, reasons };
}

const verdict = (state: HealthState, reason: HealthReason): Verdict => ({
  state,
  reasons: [reason],
});
const OK: Verdict = Object.freeze({ state: "ok", reasons: [] });

/** A queue by its oldest waiting item and its leases that ran out: stuck is down, a long wait a warning. */
function judgeQueue(
  queueFacts: Readonly<{ oldestSeconds: number | null; stuck: number }>,
  warnAfter: number,
  downAfter: number,
): Verdict {
  if (queueFacts.stuck > 0) {
    return verdict("down", "stuck");
  }
  const oldest = queueFacts.oldestSeconds ?? 0;
  if (oldest > downAfter) {
    return verdict("down", "oldest");
  }
  return oldest > warnAfter ? verdict("warning", "oldest") : OK;
}

const paused = (facts: HealthFacts, channel: "push" | "sms" | "email") =>
  facts.holds.find((hold) => hold.channel === channel);

const isoOf = (value: string): string => new Date(value).toISOString();

/** The facts of a paused channel: until when, and the provider's code for the refusal. */
const holdFacts = (hold: HealthFacts["holds"][number] | undefined): HealthFact[] =>
  hold === undefined
    ? []
    : [fact("paused", "time", isoOf(hold.until)), fact("pausedCode", "text", hold.code)];

function pushTile(facts: HealthFacts, transports: Transports): HealthTile {
  const { push } = facts;
  const hold = paused(facts, "push");
  const verdicts = [
    judgeQueue(push, HEALTH_LIMITS.queueWarnSeconds, HEALTH_LIMITS.queueDownSeconds),
    transports.pushIos && transports.pushAndroid ? OK : verdict("warning", "notSetUp"),
    hold === undefined ? OK : verdict("down", "paused"),
  ];
  return {
    key: "push",
    ...worst(verdicts),
    figure: fact("queued", "count", push.queued),
    facts: [
      fact("oldest", "seconds", push.oldestSeconds),
      fact("stuck", "count", push.stuck),
      fact("failedDay", "count", push.failedDay),
      setup("iosSetUp", transports.pushIos),
      setup("androidSetUp", transports.pushAndroid),
      ...holdFacts(hold),
    ],
  };
}

/** The share of invitation messages delivered in the last 7 days, once there are enough to judge. */
export function deliveredPercent(facts: HealthFacts): number | null {
  const { sentWeek, failedWeek, unknownWeek } = facts.invitations;
  const attempts = sentWeek + failedWeek + unknownWeek;
  return attempts === 0 ? null : Math.floor((sentWeek * 100) / attempts);
}

function smsTile(facts: HealthFacts, transports: Transports): HealthTile {
  const { sentWeek, failedWeek, unknownWeek } = facts.invitations;
  const attempts = sentWeek + failedWeek + unknownWeek;
  const percent = deliveredPercent(facts);
  const hold = paused(facts, "sms");
  const verdicts: Verdict[] = [
    transports.sms ? OK : verdict("warning", "notSetUp"),
    hold === undefined ? OK : verdict("down", "paused"),
  ];
  if (percent !== null && attempts >= HEALTH_LIMITS.deliveryMinAttempts) {
    if (percent < HEALTH_LIMITS.deliveryDownPercent) {
      verdicts.push(verdict("down", "lowDelivery"));
    } else if (percent < HEALTH_LIMITS.deliveryWarnPercent) {
      verdicts.push(verdict("warning", "lowDelivery"));
    }
  }
  return {
    key: "sms",
    ...worst(verdicts),
    figure: fact("deliveredPercent", "percent", percent),
    facts: [
      fact("sentWeek", "count", sentWeek),
      fact("failedWeek", "count", failedWeek),
      fact("unknownWeek", "count", unknownWeek),
      setup("smsSetUp", transports.sms),
      setup("promoSetUp", transports.promoSms),
      ...holdFacts(hold),
    ],
  };
}

function emailTile(facts: HealthFacts, transports: Transports): HealthTile {
  const { alerts } = facts;
  const hold = paused(facts, "email");
  const verdicts = [
    judgeQueue(alerts, HEALTH_LIMITS.mailWarnSeconds, HEALTH_LIMITS.queueDownSeconds),
    transports.alertEmail ? OK : verdict("warning", "notSetUp"),
    hold === undefined ? OK : verdict("down", "paused"),
  ];
  return {
    key: "email",
    ...worst(verdicts),
    figure: fact("queued", "count", alerts.queued),
    facts: [
      fact("oldest", "seconds", alerts.oldestSeconds),
      fact("stuck", "count", alerts.stuck),
      fact("failedDay", "count", alerts.failedDay),
      setup("alertEmailSetUp", transports.alertEmail),
      setup("emailBackupSetUp", transports.emailBackup),
      ...holdFacts(hold),
    ],
  };
}

function backgroundTile(facts: HealthFacts): HealthTile {
  const { fanOut, souvenirs, invitations } = facts;
  const verdicts = [
    souvenirs.stuck + invitations.stuck > 0 ? verdict("down", "stuck") : OK,
    fanOut.failing + souvenirs.failing > 0 ? verdict("warning", "failing") : OK,
    (fanOut.oldestSeconds ?? 0) > HEALTH_LIMITS.mailWarnSeconds ? verdict("warning", "oldest") : OK,
  ];
  return {
    key: "background",
    ...worst(verdicts),
    figure: fact("fanOutWaiting", "count", fanOut.waiting),
    facts: [
      fact("fanOutFailing", "count", fanOut.failing),
      fact("fanOutOldest", "seconds", fanOut.oldestSeconds),
      fact("souvenirWaiting", "count", souvenirs.waiting),
      fact("souvenirFailing", "count", souvenirs.failing),
      fact("souvenirStuck", "count", souvenirs.stuck),
      fact("souvenirHeld", "count", souvenirs.held),
      fact("invitationsSending", "count", invitations.sending),
      fact("invitationsStuck", "count", invitations.stuck),
    ],
  };
}

/**
 * The six tiles of the health view from the door's facts, this server's set-up and how long the door took to answer.
 * A tile is `down` when work is stuck (a lease that ran out and was not taken again), a channel is paused after the
 * provider refused the account, or the oldest waiting item is older than an hour; a `warning` is something late,
 * failing or not set up. Nothing here changes anything: it only reads.
 */
export function evaluateHealth(
  facts: HealthFacts,
  transports: Transports,
  databaseMs: number,
  at: Date,
): HealthView {
  const { events } = facts;
  const database: HealthTile = {
    key: "database",
    ...worst([databaseMs > HEALTH_LIMITS.databaseSlowMs ? verdict("warning", "slow") : OK]),
    figure: fact("databaseMs", "millis", databaseMs),
    facts: [],
  };
  const eventsTile: HealthTile = {
    key: "events",
    ...worst([events.overdue > 0 ? verdict("warning", "overdue") : OK]),
    figure: fact("eventsLive", "count", events.live),
    facts: [
      fact("eventsScheduled", "count", events.scheduled),
      fact("eventsSuspended", "count", events.suspended),
      fact("eventsOverdue", "count", events.overdue),
    ],
  };
  return {
    at: at.toISOString(),
    tiles: [
      database,
      eventsTile,
      pushTile(facts, transports),
      smsTile(facts, transports),
      emailTile(facts, transports),
      backgroundTile(facts),
    ],
    busiest: events.busiest,
  };
}

const nonNegative = count;

/** `GET /v1/admin/numbers`: counts only. */
export const platformNumbersSchema = z.strictObject({
  organizers: z.strictObject({ active: nonNegative, pending: nonNegative, paused: nonNegative }),
  events: z.strictObject({
    draft: nonNegative,
    scheduled: nonNegative,
    live: nonNegative,
    ended: nonNegative,
    archived: nonNegative,
    suspended: nonNegative,
  }),
  players: z.strictObject({ active: nonNegative, banned: nonNegative, joinedWeek: nonNegative }),
  staff: z.strictObject({ accounts: nonNegative, admins: nonNegative }),
  activity: z.strictObject({ playersInLiveEvents: nonNegative, entriesHour: nonNegative }),
});
export type PlatformNumbers = z.infer<typeof platformNumbersSchema>;

/** A platform admin account and how many sessions it has open. */
export const adminAccountSchema = z.strictObject({
  id: z.uuid(),
  email: z.string(),
  status: z.enum(["active", "disabled"]),
  createdAt: z.string(),
  sessions: count,
  lastSeenAt: z.string().nullable(),
});
export type AdminAccount = z.infer<typeof adminAccountSchema>;

/** `GET /v1/admin/admins`. */
export const adminAccountsSchema = z.strictObject({ admins: z.array(adminAccountSchema) });

/** One open session; `current` is the session that asked. */
export const adminSessionSchema = z.strictObject({
  id: z.uuid(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  userAgent: z.string().nullable(),
  ip: z.string().nullable(),
  current: z.boolean(),
});
export type AdminSession = z.infer<typeof adminSessionSchema>;

/** `GET /v1/admin/admins/:staffUserId/sessions`. */
export const adminSessionsSchema = z.strictObject({ sessions: z.array(adminSessionSchema) });
