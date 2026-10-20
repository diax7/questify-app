import { parseServiceAccountKey, type ServiceAccountKey } from "#src/auth/email/gmail";

export type AuthConfig = Readonly<{
  /** Key material for code hashes and throttle keys; at least 32 characters. */
  secret: string;
  /** The one origin of the dashboard, which proxies /v1. State-changing cookie requests must come from it. */
  dashboardOrigin: string;
  /** The Gmail API sender (ADR-112): a service account acting for a Workspace mailbox, sending from `from`. */
  gmail: Readonly<{ key: ServiceAccountKey; from: string; actAs: string | undefined }>;
  /** The backup email provider. Present only when both its key and its verified From address are set. */
  resend: Readonly<{ apiKey: string; from: string }> | undefined;
  /** An extra mailbox, besides the admin's own, that is told about every new admin sign-in. */
  securityAlertEmail: string | undefined;
}>;

export type AppConfig = Readonly<{
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  /** Lowest app version the server supports; older apps get 426. */
  minAppVersion: string;
  /** Git commit of the running build, shown by /healthz. */
  releaseSha: string;
  /** Connection string for the API's own database role (not the owner). */
  databaseUrl: string;
  /** Connections the API may hold at once. Raise it with the database's connection limit, not beyond it. */
  databasePoolSize: number;
  /** How many proxies sit in front of the API; the client address is read that many hops from the right. */
  trustProxyHops: number;
  auth: AuthConfig;
  /**
   * Key material for the codes printed in quest QRs; at least 32 characters. Its own secret, not AUTH_SECRET's: printed
   * codes live a whole event, and rotating it voids every one (RUNBOOK).
   */
  qrSecret: string;
  /**
   * The Msegat account for player sign-in SMS (ADR-103): its user name, API key and activated services sender. Required
   * in production; elsewhere, without it, every SMS is refused and the app offers email.
   */
  msegat: Readonly<{ userName: string; apiKey: string; sender: string }> | undefined;
  /**
   * The Redis that holds live rankings (ADR-118). Required in production; elsewhere, without it, rankings are read from
   * PostgreSQL (the same order, more database work).
   */
  redisUrl: string | undefined;
}>;

type Env = Readonly<Record<string, string | undefined>>;

const NODE_ENVS = ["development", "test", "production"] as const;
const MIN_SECRET_LENGTH = 32;

function required(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function optional(env: Env, name: string): string | undefined {
  const value = env[name];
  return value === undefined || value.trim() === "" ? undefined : value;
}

function whole(env: Env, name: string, fallback: string, min: number, max: number): number {
  const text = env[name] ?? fallback;
  const value = Number(text);
  if (!/^[0-9]+$/.test(text) || value < min || value > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}; got "${text}".`);
  }
  return value;
}

/** Production must say how many proxies stand in front, because a wrong guess makes everyone share one address. */
function proxyHops(env: Env, nodeEnv: string): number {
  if (nodeEnv === "production" && optional(env, "TRUST_PROXY_HOPS") === undefined) {
    throw new Error(
      "TRUST_PROXY_HOPS is required in production: the number of proxies that add to X-Forwarded-For in front of the API (1 on CranL: the edge; the web app's forwarder passes it through, ADR-113).",
    );
  }
  return whole(env, "TRUST_PROXY_HOPS", "1", 0, 10);
}

function origin(env: Env, name: string): string {
  const text = required(env, name);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${name} must be an origin like https://app.example.com; got "${text}".`);
  }
  if (url.origin !== text) {
    throw new Error(`${name} must be an origin only (no path or trailing slash); got "${text}".`);
  }
  return text;
}

const EMAIL_ADDRESS = /^[^\s@<>"]+@[^\s@<>"]+\.[a-z]{2,}$/i;

function emailAddress(env: Env, name: string): string {
  const text = required(env, name);
  if (!EMAIL_ADDRESS.test(text)) {
    throw new Error(`${name} must be one email address like questify@nafes.com; got "${text}".`);
  }
  return text;
}

function authConfig(env: Env): AuthConfig {
  const secret = required(env, "AUTH_SECRET");
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`AUTH_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`);
  }
  const resendKey = optional(env, "RESEND_API_KEY");
  const resendFrom = optional(env, "RESEND_FROM");
  if ((resendKey === undefined) !== (resendFrom === undefined)) {
    throw new Error(
      "RESEND_API_KEY and RESEND_FROM go together: Resend only sends from an address on a verified domain.",
    );
  }
  return {
    secret,
    dashboardOrigin: origin(env, "DASHBOARD_ORIGIN"),
    gmail: {
      key: parseServiceAccountKey(required(env, "GMAIL_SERVICE_ACCOUNT_KEY")),
      from: emailAddress(env, "MAIL_FROM"),
      actAs:
        optional(env, "GMAIL_ACT_AS") === undefined ? undefined : emailAddress(env, "GMAIL_ACT_AS"),
    },
    resend:
      resendKey !== undefined && resendFrom !== undefined
        ? { apiKey: resendKey, from: resendFrom }
        : undefined,
    securityAlertEmail: optional(env, "SECURITY_ALERT_EMAIL"),
  };
}

/**
 * Reads and checks the settings from environment variables (12-factor).
 *
 * @throws Error naming the variable when a value is missing or not valid.
 */
export function loadConfig(env: Env): AppConfig {
  const nodeEnv = env["NODE_ENV"] ?? "development";
  if (!NODE_ENVS.includes(nodeEnv as (typeof NODE_ENVS)[number])) {
    throw new Error(`NODE_ENV must be one of ${NODE_ENVS.join(", ")}; got "${nodeEnv}".`);
  }

  const minAppVersion = env["MIN_APP_VERSION"] ?? "1.0.0";
  if (!/^[0-9]+(\.[0-9]+){1,2}$/.test(minAppVersion)) {
    throw new Error(`MIN_APP_VERSION must look like 1.2.3; got "${minAppVersion}".`);
  }

  return {
    nodeEnv: nodeEnv as AppConfig["nodeEnv"],
    host: env["HOST"] ?? "0.0.0.0",
    port: whole(env, "PORT", "3000", 1, 65_535),
    minAppVersion,
    releaseSha: env["RELEASE_SHA"] ?? "dev",
    databaseUrl: required(env, "DATABASE_URL"),
    databasePoolSize: whole(env, "DATABASE_POOL_SIZE", "10", 1, 200),
    trustProxyHops: proxyHops(env, nodeEnv),
    auth: authConfig(env),
    qrSecret: qrSecret(env),
    msegat: msegat(env, nodeEnv),
    redisUrl: redisUrl(env, nodeEnv),
  };
}

function redisUrl(env: Env, nodeEnv: string): string | undefined {
  const text = nodeEnv === "production" ? required(env, "REDIS_URL") : optional(env, "REDIS_URL");
  if (text === undefined) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error("REDIS_URL must be a URL like redis://host:6379 or rediss://host:6380.");
  }
  if (url.protocol !== "redis:" && url.protocol !== "rediss:") {
    throw new Error(`REDIS_URL must start with redis:// or rediss://; got "${url.protocol}".`);
  }
  return text;
}

const MSEGAT_NAMES = ["MSEGAT_USERNAME", "MSEGAT_API_KEY", "MSEGAT_SENDER"] as const;

/** All three or none; production needs them, since players sign in by phone first (FR-106). */
function msegat(env: Env, nodeEnv: string): AppConfig["msegat"] {
  const set = MSEGAT_NAMES.filter((name) => optional(env, name) !== undefined);
  if (set.length === 0 && nodeEnv !== "production") {
    return undefined;
  }
  if (set.length !== MSEGAT_NAMES.length) {
    throw new Error(
      `${MSEGAT_NAMES.join(", ")} are required together${nodeEnv === "production" ? " in production" : ""}: the Msegat user name, API key and activated services sender.`,
    );
  }
  return {
    userName: required(env, "MSEGAT_USERNAME"),
    apiKey: required(env, "MSEGAT_API_KEY"),
    sender: required(env, "MSEGAT_SENDER"),
  };
}

/** Required in every environment: a missing key must stop the server, never fall back to a known one. */
function qrSecret(env: Env): string {
  const secret = required(env, "QR_SECRET");
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`QR_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`);
  }
  return secret;
}
