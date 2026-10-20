import { createHash } from "node:crypto";
import { normalizePassword } from "#src/auth/normalize";

/** True when the password appears in a known breach. Throws `BreachCheckUnavailable` when no answer came in time. */
export type BreachCheck = (password: string) => Promise<boolean>;

export class BreachCheckUnavailable extends Error {
  override readonly name = "BreachCheckUnavailable";
}

const RANGE_URL = "https://api.pwnedpasswords.com/range/";
/** The whole check, retry included, finishes within this (T-020). */
const DEADLINE_MS = 3000;
/** A retry starts only when at least this much of the deadline is left. */
const RETRY_FLOOR_MS = 1000;

type Options = Readonly<{
  fetch?: typeof fetch;
  /** Milliseconds since some fixed point; replaced in tests. */
  now?: () => number;
  deadlineMs?: number;
}>;

/** Network errors, rate limits and server errors may pass; anything else will not. */
const isRetryable = (outcome: Response | Error): boolean =>
  outcome instanceof Error || outcome.status === 429 || outcome.status >= 500;

/**
 * Checks a password against Have I Been Pwned's Pwned Passwords with k-anonymity: only the first five hex characters
 * of its SHA-1 leave the server, and `Add-Padding` hides how many suffixes came back (ASVS V6.2.12). One overall
 * deadline; one retry on a network error, a 429 or a 5xx when time is left; otherwise it fails closed by throwing
 * (rule 5: timeout, safe retry, fallback). Padding rows have a count of 0 and never match.
 */
export function createBreachCheck(options: Options = {}): BreachCheck {
  const call = options.fetch ?? fetch;
  const now = options.now ?? (() => performance.now());
  const deadlineMs = options.deadlineMs ?? DEADLINE_MS;

  return async (password) => {
    const digest = createHash("sha1")
      .update(normalizePassword(password))
      .digest("hex")
      .toUpperCase();
    const prefix = digest.slice(0, 5);
    const suffix = digest.slice(5);
    const signal = AbortSignal.timeout(deadlineMs);
    const started = now();

    const attempt = async (): Promise<Response | Error> => {
      try {
        return await call(`${RANGE_URL}${prefix}`, {
          headers: { "add-padding": "true", "user-agent": "Questify-API" },
          signal,
        });
      } catch (error) {
        return error instanceof Error ? error : new Error(String(error));
      }
    };

    let outcome = await attempt();
    if (isRetryable(outcome) && deadlineMs - (now() - started) >= RETRY_FLOOR_MS) {
      // Stryker disable all: resource hygiene only; no answer changes
      if (!(outcome instanceof Error)) {
        // Frees the first answer's connection now rather than when it is garbage collected.
        await outcome.body?.cancel().catch(() => undefined);
      }
      // Stryker restore all
      outcome = await attempt();
    }
    if (outcome instanceof Error || !outcome.ok) {
      const reason = outcome instanceof Error ? outcome.name : `status ${outcome.status}`;
      throw new BreachCheckUnavailable(`The breached-password check did not answer (${reason}).`);
    }
    let body: string;
    try {
      body = await outcome.text();
    } catch (error) {
      throw new BreachCheckUnavailable("The breached-password check did not answer (body).", {
        cause: error,
      });
    }
    return body.split("\n").some((line) => {
      const [hashSuffix, count] = line.split(":");
      return hashSuffix === suffix && Number(count) > 0;
    });
  };
}
