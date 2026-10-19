export type AuthConfig = Readonly<{
  /** Key material for code hashes and throttle keys; at least 32 characters. */
  secret: string;
  /** The one origin of the dashboard, which proxies /v1. State-changing cookie requests must come from it. */
  dashboardOrigin: string;
  /** The dedicated Gmail account that sends sign-in codes. */
  smtpUser: string;
  smtpAppPassword: string;
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
  /** How many proxies sit in front of the API; the client address is read that many hops from the right. */
  trustProxyHops: number;
  auth: AuthConfig;
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
    smtpUser: required(env, "SMTP_USER"),
    smtpAppPassword: required(env, "SMTP_APP_PASSWORD"),
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
    trustProxyHops: whole(env, "TRUST_PROXY_HOPS", "1", 0, 10),
    auth: authConfig(env),
  };
}
