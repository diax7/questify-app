import type { CheerReaction } from "@questify/shared";
import type { Session } from "#src/api/session.ts";

type Requester = Pick<Session, "request">;

/** What sending a cheer came to (`POST /v1/events/{id}/cheers`, T-509). */
export type CheerAnswer =
  | Readonly<{ kind: "sent" | "over" | "network" | "signed_out" }>
  | Readonly<{ kind: "slow"; seconds: number }>;

/** How long to wait after a 429 that names no wait. */
const SLOW_SECONDS = 10;

/**
 * Sends one cheer. `slow` is the per-minute limit with the seconds to wait; `over` means the moment ended or is gone (the
 * button goes with the next read of what is live); anything else is a lost connection.
 */
export async function sendCheer(
  session: Requester,
  eventId: string,
  reaction: CheerReaction,
): Promise<CheerAnswer> {
  const answer = await session.request({
    method: "POST",
    path: `/v1/events/${encodeURIComponent(eventId)}/cheers`,
    body: { reaction },
  });
  if (answer.kind === "ok") {
    return { kind: "sent" };
  }
  if (answer.kind !== "error") {
    return { kind: answer.kind };
  }
  if (answer.code === "too_many_attempts") {
    const seconds = Number(answer.headers.get("retry-after"));
    return { kind: "slow", seconds: seconds > 0 ? Math.ceil(seconds) : SLOW_SECONDS };
  }
  return { kind: answer.code === "cheers_not_live" || answer.status === 404 ? "over" : "network" };
}

/** The seconds a slowed player still waits at `now`, or 0 once the wait is over. */
export const secondsToWait = (slowUntil: number, now: number): number =>
  Math.max(0, Math.ceil((slowUntil - now) / 1000));

/** Whether the moment is still on by the phone's clock; the read of what is live corrects a skewed clock. */
export const momentIsOn = (endsAt: string, now: number): boolean => Date.parse(endsAt) > now;
