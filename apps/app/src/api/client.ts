import type { Language, LocalizedText } from "@questify/shared";

/** What one call to the API came to. HTTP errors are answers, not exceptions: the screens show `message`. */
export type ApiResult =
  | Readonly<{ kind: "ok"; status: number; body: unknown; headers: Headers }>
  | Readonly<{
      kind: "error";
      status: number;
      code: string;
      message: LocalizedText | null;
      details: Readonly<Record<string, unknown>>;
      headers: Headers;
    }>
  | Readonly<{ kind: "network" }>;

export type ApiRequest = Readonly<{
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
  /** The access token, for the player's own routes. */
  accessToken?: string;
  headers?: Readonly<Record<string, string>>;
}>;

export type ClientDeps = Readonly<{
  baseUrl: string;
  /** The app's install id (X-Device-Id): it lets the API hold limits per install. */
  deviceId: () => Promise<string>;
  language: () => Language;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}>;

export type Client = Readonly<{ request: (request: ApiRequest) => Promise<ApiResult> }>;

const DEV_API = "https://questify-api-staging-3ez01s.cranl.net";

/**
 * The API's base URL. In development it defaults to staging; a release build must name its API, over https, or the
 * app stops at start: a forgotten setting must never send real players to staging (MASVS-NETWORK).
 *
 * @throws Error naming `EXPO_PUBLIC_API_URL` and what it must be.
 */
export function apiBaseUrl(configured: string | undefined, development: boolean): string {
  if (configured === undefined || configured === "") {
    if (development) {
      return DEV_API;
    }
    throw new Error(
      "EXPO_PUBLIC_API_URL is not set: a release build must name its API (an https origin).",
    );
  }
  // Checked by pattern, not `URL`: React Native's `URL` accepts anything and never throws.
  const url = /^(https?):\/\/([A-Za-z0-9.-]+(?::[0-9]{1,5})?)(?:\/\S*)?$/.exec(configured.trim());
  if (url === null) {
    throw new Error(`EXPO_PUBLIC_API_URL "${configured}" is not a URL.`);
  }
  if (url[1] !== "https" && !development) {
    throw new Error(`EXPO_PUBLIC_API_URL must be https in a release build, not "${configured}".`);
  }
  return `${url[1]}://${(url[2] ?? "").toLowerCase()}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isLocalized = (value: unknown): value is LocalizedText =>
  isRecord(value) && typeof value["ar"] === "string" && typeof value["en"] === "string";

function errorOf(status: number, body: unknown, headers: Headers): ApiResult {
  const code = isRecord(body) && typeof body["code"] === "string" ? body["code"] : "unknown_error";
  return {
    kind: "error",
    status,
    code,
    message: isRecord(body) && isLocalized(body["message"]) ? body["message"] : null,
    details: isRecord(body) && isRecord(body["details"]) ? body["details"] : {},
    headers,
  };
}

/** The body as JSON; an unreadable body is undefined, a body cut off by the timeout is a network failure. */
async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  try {
    return await response.json();
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    return undefined;
  }
}

/** Calls the API with a timeout, the install id and the language; never throws for an HTTP or network failure. */
export function createClient(deps: ClientDeps): Client {
  return {
    request: async (request) => {
      let deviceId: string;
      try {
        deviceId = await deps.deviceId();
      } catch {
        // The install id could not be read (local storage failed): no request, the same answer as no network.
        return { kind: "network" };
      }
      const headers: Record<string, string> = {
        accept: "application/json",
        "accept-language": deps.language(),
        "x-device-id": deviceId,
        ...request.headers,
      };
      if (request.body !== undefined) {
        headers["content-type"] = "application/json";
      }
      if (request.accessToken !== undefined) {
        headers["authorization"] = `Bearer ${request.accessToken}`;
      }
      // A timer of our own (React Native's AbortSignal has no `timeout` helper), over the headers and the body.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 15_000);
      let response: Response;
      let body: unknown;
      try {
        response = await (deps.fetchImpl ?? fetch)(`${deps.baseUrl}${request.path}`, {
          method: request.method,
          headers,
          // Stryker disable next-line ConditionalExpression: equivalent: JSON.stringify(undefined) is undefined, no body either way
          ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
          signal: controller.signal,
        });
        // Stryker disable next-line ConditionalExpression: equivalent: an empty 204 fails to parse and reads as undefined anyway
        body = response.status === 204 ? undefined : await readJson(response, controller.signal);
      } catch {
        return { kind: "network" };
      } finally {
        clearTimeout(timer);
      }
      return response.ok
        ? { kind: "ok", status: response.status, body, headers: response.headers }
        : errorOf(response.status, body, response.headers);
    },
  };
}
