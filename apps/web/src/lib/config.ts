export type WebConfig = Readonly<{
  apiOrigin: string;
  /**
   * The web app's own public origin, read under the API's name for it (`DASHBOARD_ORIGIN`, ADR-819) so the two never
   * drift: a write that carries the player cookie or reaches `/v1/auth/*` must send exactly this `Origin`.
   */
  webOrigin: string;
  /** `PLAYER_WEB_SESSION=on`: the forwarder's player cookie steps (ADR-818); off until P3's `/play` CSP ships. */
  playerWebSession: boolean;
  /** The app's store pages (T-010), unset until the app is published: the event page then shows no store buttons. */
  appStoreUrl?: string;
  playStoreUrl?: string;
}>;

const STORE_HOSTS = { APP_STORE_URL: "apps.apple.com", PLAY_STORE_URL: "play.google.com" } as const;

/**
 * An optional store link: unset is fine; anything else must be https on that store's own host.
 *
 * @throws Error naming the setting and the expected form.
 */
function storeLink(
  env: Readonly<Record<string, string | undefined>>,
  name: keyof typeof STORE_HOSTS,
) {
  const value = env[name];
  if (value === undefined || value === "") {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `${name} "${value}" is not a URL. Use the app's store page, https://${STORE_HOSTS[name]}/...`,
    );
  }
  if (url.protocol !== "https:" || url.hostname !== STORE_HOSTS[name]) {
    throw new Error(`${name} must be an https link on ${STORE_HOSTS[name]}, not "${value}".`);
  }
  return url.toString();
}

/**
 * The API must be reached over CranL's private network: plain http and a one-word host (the app's internal name),
 * or 127.0.0.1 / localhost for local runs. A public URL would pass every request through the edge a second time, so
 * the API would see the web server's address for every staff member and one person's failures would lock out all.
 */
const INTERNAL_ORIGIN = /^http:\/\/([a-z0-9-]+|127\.0\.0\.1)(:[0-9]{1,5})?$/;

/** A local run's own origin may be plain http; every other web origin is https. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

const parsedUrl = (value: string): URL | undefined => {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
};

/** An origin only (no path, no trailing slash), over https or on this machine. */
function isWebOrigin(value: string): boolean {
  const url = parsedUrl(value);
  if (url === undefined || url.origin !== value) {
    return false;
  }
  return url.protocol === "https:" || LOCAL_HOSTS.has(url.hostname);
}

/**
 * The web app's public origin (`DASHBOARD_ORIGIN`): required, an origin only, https except on this machine.
 *
 * @throws Error naming the setting and the expected form.
 */
function webOriginOf(env: Readonly<Record<string, string | undefined>>): string {
  const value = env["DASHBOARD_ORIGIN"];
  if (value === undefined || value === "") {
    throw new Error(
      "DASHBOARD_ORIGIN is not set. Use the web app's public origin, the same as the API's DASHBOARD_ORIGIN, such as https://questify.nafes.com.",
    );
  }
  if (!isWebOrigin(value)) {
    throw new Error(
      `DASHBOARD_ORIGIN "${value}" must be an https origin with no path or trailing slash (https://questify.nafes.com), or http://localhost:<port> on this machine.`,
    );
  }
  return value;
}

/**
 * `PLAYER_WEB_SESSION`: unset, empty or `off` keeps the player cookie steps off (the SECURITY.md ship gate); `on`
 * turns them on.
 *
 * @throws Error for any other value, so a typo never leaves the switch in a state nobody chose.
 */
function playerWebSessionOf(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env["PLAYER_WEB_SESSION"] ?? "";
  if (value === "on") {
    return true;
  }
  if (value === "" || value === "off") {
    return false;
  }
  throw new Error(`PLAYER_WEB_SESSION "${value}" must be "on" or "off" (unset is off).`);
}

/**
 * Reads the web app's settings.
 *
 * @throws Error naming the setting and the expected form when `API_ORIGIN` is missing or not an internal address, a
 *   store link is not https on its store's host, `DASHBOARD_ORIGIN` is missing or not an origin, or
 *   `PLAYER_WEB_SESSION` is neither `on` nor `off`.
 */
export function readWebConfig(env: Readonly<Record<string, string | undefined>>): WebConfig {
  const apiOrigin = env["API_ORIGIN"];
  if (apiOrigin === undefined || apiOrigin === "") {
    throw new Error(
      "API_ORIGIN is not set. Use the API's internal address on CranL, such as http://questify-api-staging-3ez01s:3000.",
    );
  }
  if (!INTERNAL_ORIGIN.test(apiOrigin)) {
    throw new Error(
      `API_ORIGIN "${apiOrigin}" must be an internal http address with a one-word host (http://questify-api-staging-3ez01s:3000) or http://127.0.0.1:<port>; never the public https URL.`,
    );
  }
  const appStoreUrl = storeLink(env, "APP_STORE_URL");
  const playStoreUrl = storeLink(env, "PLAY_STORE_URL");
  return {
    apiOrigin,
    webOrigin: webOriginOf(env),
    playerWebSession: playerWebSessionOf(env),
    ...(appStoreUrl === undefined ? {} : { appStoreUrl }),
    ...(playStoreUrl === undefined ? {} : { playStoreUrl }),
  };
}

let cached: WebConfig | undefined;

/** The settings of the running server, read once. */
export function webConfig(): WebConfig {
  cached ??= readWebConfig(process.env);
  return cached;
}
