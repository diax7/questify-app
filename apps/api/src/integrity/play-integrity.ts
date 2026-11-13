import { GoogleTokenError, reasonOf, type GoogleTokenSource } from "#src/auth/google-token";

/**
 * Google Play Integrity on the server (T-812, ADR-833): the app's token is decoded by Google
 * (`POST /v1/{package}:decodeIntegrityToken`, scope `playintegrity`) and the verdict read here. Each call has a
 * timeout and one retry when Google does not answer; when it still does not, there is no verdict (rule 5: nothing is
 * recorded and the app asks again later).
 */

export const PLAY_INTEGRITY_SCOPE = "https://www.googleapis.com/auth/playintegrity";
export const PLAY_INTEGRITY_URL = "https://playintegrity.googleapis.com";
/** A token older than this, or this far ahead of our clock, is not taken as fresh. */
const FRESH_MS = 10 * 60 * 1000;
const AHEAD_MS = 60 * 1000;

export type PlayReason = "token" | "package" | "nonce" | "stale" | "app" | "device";

export type PlayVerdict =
  | Readonly<{ kind: "verdict"; passed: boolean; reasons: readonly PlayReason[] }>
  /** Google could not be reached, timed out, or refused our account: no verdict, never a flag. */
  | Readonly<{ kind: "unavailable"; why: string }>;

export type PlayIntegrityOptions = Readonly<{
  tokens: GoogleTokenSource;
  packageName: string;
  /** Google's address; a test gives its local fake. */
  baseUrl?: string;
  timeoutMs: number;
  fetch?: typeof fetch;
  /** Milliseconds since 1970; replaced in tests. */
  now?: () => number;
}>;

export type PlayIntegrity = Readonly<{
  decide: (token: string, challenge: string) => Promise<PlayVerdict>;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const field = (value: unknown, name: string): unknown =>
  isRecord(value) ? value[name] : undefined;

/** Google echoes the nonce as given; a padded copy is the same nonce. */
const unpadded = (value: unknown): string | undefined =>
  typeof value === "string" ? value.replace(/=+$/, "") : undefined;

type Expected = Readonly<{ packageName: string; challenge: string; now: number }>;

/** Whether the request was made just now (by our clock, within the window). */
function fresh(request: unknown, now: number): boolean {
  const at = Number(field(request, "timestampMillis"));
  return Number.isFinite(at) && at >= now - FRESH_MS && at <= now + AHEAD_MS;
}

/** Whether the request names our challenge, as the classic `nonce` or the standard `requestHash`. */
function ours(request: unknown, challenge: string): boolean {
  const echoed = [unpadded(field(request, "nonce")), unpadded(field(request, "requestHash"))];
  return echoed.includes(unpadded(challenge));
}

function meetsDevice(device: unknown): boolean {
  const verdicts = field(device, "deviceRecognitionVerdict");
  return Array.isArray(verdicts) && verdicts.includes("MEETS_DEVICE_INTEGRITY");
}

/** The reasons a decoded payload fails, each once; none means it passed. */
export function payloadReasons(payload: unknown, expected: Expected): readonly PlayReason[] {
  const request = field(payload, "requestDetails");
  const app = field(payload, "appIntegrity");
  const checks: ReadonlyArray<readonly [PlayReason, boolean]> = [
    ["package", field(request, "requestPackageName") === expected.packageName],
    ["nonce", ours(request, expected.challenge)],
    ["stale", fresh(request, expected.now)],
    ["app", field(app, "appRecognitionVerdict") === "PLAY_RECOGNIZED"],
    ["package", field(app, "packageName") === expected.packageName],
    ["device", meetsDevice(field(payload, "deviceIntegrity"))],
  ];
  return [...new Set(checks.filter(([, holds]) => !holds).map(([reason]) => reason))];
}

type Attempt =
  | Readonly<{ kind: "answer"; payload: unknown }>
  | Readonly<{ kind: "bad_token" }>
  | Readonly<{ kind: "retry"; why: string; stale?: string }>
  | Readonly<{ kind: "stop"; why: string }>;

/** An access token, or the attempt's end when Google's token endpoint failed. */
async function accessToken(options: PlayIntegrityOptions): Promise<string | Attempt> {
  try {
    return await options.tokens.get();
  } catch (error) {
    const failure = error instanceof GoogleTokenError ? error.failure : "unreachable";
    return failure === "unreachable"
      ? { kind: "retry", why: "token_unreachable" }
      : { kind: "stop", why: `token_${failure}` };
  }
}

/** Google's answer as an attempt: a payload, a bad token (400), or a status worth retrying or not. */
async function answerOf(response: Response, access: string): Promise<Attempt> {
  const body: unknown = await response.json().catch(() => undefined);
  if (response.ok) {
    const payload = field(body, "tokenPayloadExternal");
    // A 200 without the decoded payload is Google misbehaving, not a failed check: no verdict.
    return isRecord(payload) && isRecord(field(payload, "requestDetails"))
      ? { kind: "answer", payload }
      : { kind: "stop", why: "200_malformed" };
  }
  if (response.status === 400) return { kind: "bad_token" };
  const why = `${response.status}_${reasonOf(field(field(body, "error"), "status"))}`;
  if (response.status === 401) return { kind: "retry", why, stale: access };
  const busy = response.status >= 500 || response.status === 429;
  return busy ? { kind: "retry", why } : { kind: "stop", why };
}

async function attempt(options: PlayIntegrityOptions, token: string): Promise<Attempt> {
  const access = await accessToken(options);
  if (typeof access !== "string") return access;
  const url = `${options.baseUrl ?? PLAY_INTEGRITY_URL}/v1/${options.packageName}:decodeIntegrityToken`;
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, {
      method: "POST",
      headers: { authorization: `Bearer ${access}`, "content-type": "application/json" },
      body: JSON.stringify({ integrity_token: token }),
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch {
    return { kind: "retry", why: "unreachable" };
  }
  return answerOf(response, access);
}

/** The verdict an attempt settles on, or undefined to ask once more. */
function settled(result: Attempt, expected: Expected): PlayVerdict | undefined {
  if (result.kind === "answer") {
    const reasons = payloadReasons(result.payload, expected);
    return { kind: "verdict", passed: reasons.length === 0, reasons };
  }
  if (result.kind === "bad_token") return { kind: "verdict", passed: false, reasons: ["token"] };
  return result.kind === "stop" ? { kind: "unavailable", why: result.why } : undefined;
}

/** The Play Integrity decoder. `decide` never throws: every failure is a verdict or `unavailable`. */
export function createPlayIntegrity(options: PlayIntegrityOptions): PlayIntegrity {
  const now = options.now ?? Date.now;
  return {
    decide: async (token, challenge) => {
      let last = "unreachable";
      for (let round = 0; round < 2; round += 1) {
        const result = await attempt(options, token);
        const verdict = settled(result, {
          packageName: options.packageName,
          challenge,
          now: now(),
        });
        if (verdict !== undefined) return verdict;
        if (result.kind === "retry") {
          if (result.stale !== undefined) options.tokens.drop(result.stale);
          last = result.why;
        }
      }
      return { kind: "unavailable", why: last };
    },
  };
}
