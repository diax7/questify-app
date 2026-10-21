export type WebConfig = Readonly<{
  apiOrigin: string;
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

/**
 * Reads the web app's settings.
 *
 * @throws Error naming the setting and the expected form when `API_ORIGIN` is missing or not an internal address, or
 *   a store link is not https on its store's host.
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
