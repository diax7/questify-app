import type { Session } from "#src/api/session.ts";

type Requester = Pick<Session, "request">;

/** The live code a kiosk reads (`GET /v1/me/live-code`, T-309b), or why there is none now. */
export type LiveCodeAnswer =
  | Readonly<{ kind: "code"; code: string; changesInMs: number }>
  | Readonly<{ kind: "off" }>
  | Readonly<{ kind: "slowed"; waitMs: number }>
  | Readonly<{ kind: "network" | "signed_out" }>;

/** How long to wait after a 429 that names no wait. */
const SLOWED_MS = 10_000;
/** How long a failed fetch waits before it tries again. */
export const LIVE_RETRY_MS = 5000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Fetches the signed-in player's live code. Never cached: not in SecureStore, not past its window. */
export async function fetchLiveCode(session: Requester): Promise<LiveCodeAnswer> {
  const answer = await session.request({ method: "GET", path: "/v1/me/live-code" });
  if (answer.kind === "signed_out" || answer.kind === "network") {
    return { kind: answer.kind };
  }
  if (answer.kind === "error") {
    if (answer.code === "feature_off") {
      return { kind: "off" };
    }
    if (answer.code === "too_many_attempts") {
      const seconds = Number(answer.headers.get("retry-after"));
      return { kind: "slowed", waitMs: seconds > 0 ? seconds * 1000 : SLOWED_MS };
    }
    return { kind: "network" };
  }
  const body = isRecord(answer.body) ? answer.body : {};
  return typeof body["code"] === "string" && typeof body["changesInMs"] === "number"
    ? { kind: "code", code: body["code"], changesInMs: body["changesInMs"] }
    : { kind: "network" };
}

/**
 * When to fetch the next code: when this one changes, plus up to a second of jitter, timed from the answer and never by
 * the phone's clock. Two fetches a minute, well under the 6 a minute the API allows.
 */
export const nextLiveFetchMs = (changesInMs: number, random: number): number =>
  Math.max(changesInMs, 0) + Math.floor(Math.min(Math.max(random, 0), 1) * 1000);

/** How long a fetched code may stay on screen without a fresh one: until the door stops taking it, 15 s after it changed. */
export const liveCodeLifeMs = (changesInMs: number): number => Math.max(changesInMs, 0) + 15_000;
