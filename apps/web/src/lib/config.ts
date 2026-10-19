export type WebConfig = Readonly<{ apiOrigin: string }>;

/**
 * The API must be reached over CranL's private network: plain http and a one-word host (the app's internal name),
 * or 127.0.0.1 / localhost for local runs. A public URL would pass every request through the edge a second time, so
 * the API would see the web server's address for every staff member and one person's failures would lock out all.
 */
const INTERNAL_ORIGIN = /^http:\/\/([a-z0-9-]+|127\.0\.0\.1)(:[0-9]{1,5})?$/;

/**
 * Reads the web app's settings.
 *
 * @throws Error naming the setting and the expected form when `API_ORIGIN` is missing or not an internal address.
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
  return { apiOrigin };
}

let cached: WebConfig | undefined;

/** The settings of the running server, read once. */
export function webConfig(): WebConfig {
  cached ??= readWebConfig(process.env);
  return cached;
}
