export type WebConfig = Readonly<{
  apiOrigin: string;
  /** The public host: event pages, sign-in, the dashboard (T-810d, ADR-723). */
  dashboardOrigin: string;
  /** The console's own host; it serves only the console, sign-in and the staff account page (ADR-722). */
  consoleOrigin: string;
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

/** Plain http only for a local run or the browser tests; every deployed host is https. */
const LOCAL_HOST = /^(localhost|[a-z0-9-]+\.localhost|127\.0\.0\.1)$/;

/**
 * A browser origin the web app is served on: https, or http on a local host; an origin only (no path).
 *
 * @throws Error naming the setting and the expected form.
 */
function browserOrigin(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new Error(
      `${name} is not set. Use the host the browser opens, such as https://questify.nafes.com for DASHBOARD_ORIGIN and https://console.questify.nafes.com for CONSOLE_ORIGIN.`,
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      `${name} "${value}" is not a URL. Use an origin such as https://questify.nafes.com.`,
    );
  }
  if (url.origin !== value) {
    throw new Error(`${name} "${value}" must be an origin only (no path or trailing slash).`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL_HOST.test(url.hostname))) {
    throw new Error(`${name} "${value}" must be https (http only for localhost or 127.0.0.1).`);
  }
  return value;
}

/**
 * The two browser origins (T-810d, ADR-723): both required, and different, so each page can be sent to its host.
 *
 * @throws Error naming the setting when one is missing, malformed, not https, or both are the same.
 */
function hostOrigins(env: Readonly<Record<string, string | undefined>>) {
  const dashboardOrigin = browserOrigin(env, "DASHBOARD_ORIGIN");
  const consoleOrigin = browserOrigin(env, "CONSOLE_ORIGIN");
  if (consoleOrigin === dashboardOrigin) {
    throw new Error(
      `CONSOLE_ORIGIN must be a different host from DASHBOARD_ORIGIN (both are "${consoleOrigin}").`,
    );
  }
  return { dashboardOrigin, consoleOrigin };
}

/**
 * The API must be reached over CranL's private network: plain http and a one-word host (the app's internal name),
 * or 127.0.0.1 / localhost for local runs. A public URL would pass every request through the edge a second time, so
 * the API would see the web server's address for every staff member and one person's failures would lock out all.
 */
const INTERNAL_ORIGIN = /^http:\/\/([a-z0-9-]+|127\.0\.0\.1)(:[0-9]{1,5})?$/;

/**
 * Reads the web app's settings.
 *
 * @throws Error naming the setting and the expected form when `API_ORIGIN` is missing or not an internal address, a
 *   host origin is missing or wrong, or a store link is not https on its store's host.
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
  const origins = hostOrigins(env);
  const appStoreUrl = storeLink(env, "APP_STORE_URL");
  const playStoreUrl = storeLink(env, "PLAY_STORE_URL");
  return {
    apiOrigin,
    ...origins,
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
