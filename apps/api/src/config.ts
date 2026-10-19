export type AppConfig = Readonly<{
  nodeEnv: "development" | "test" | "production";
  host: string;
  port: number;
  /** Lowest app version the server supports; older apps get 426. */
  minAppVersion: string;
  /** Git commit of the running build, shown by /healthz. */
  releaseSha: string;
}>;

type Env = Readonly<Record<string, string | undefined>>;

const NODE_ENVS = ["development", "test", "production"] as const;

/**
 * Reads and checks the settings from environment variables (12-factor).
 *
 * @throws Error naming the variable when a value is not valid.
 */
export function loadConfig(env: Env): AppConfig {
  const nodeEnv = env["NODE_ENV"] ?? "development";
  if (!NODE_ENVS.includes(nodeEnv as (typeof NODE_ENVS)[number])) {
    throw new Error(`NODE_ENV must be one of ${NODE_ENVS.join(", ")}; got "${nodeEnv}".`);
  }

  const portText = env["PORT"] ?? "3000";
  const port = Number(portText);
  if (!/^[0-9]+$/.test(portText) || port < 1 || port > 65535) {
    throw new Error(`PORT must be a whole number from 1 to 65535; got "${portText}".`);
  }

  const minAppVersion = env["MIN_APP_VERSION"] ?? "1.0.0";
  if (!/^[0-9]+(\.[0-9]+){1,2}$/.test(minAppVersion)) {
    throw new Error(`MIN_APP_VERSION must look like 1.2.3; got "${minAppVersion}".`);
  }

  return {
    nodeEnv: nodeEnv as AppConfig["nodeEnv"],
    host: env["HOST"] ?? "0.0.0.0",
    port,
    minAppVersion,
    releaseSha: env["RELEASE_SHA"] ?? "dev",
  };
}
