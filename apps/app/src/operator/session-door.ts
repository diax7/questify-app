import {
  doorAnswerSchema,
  operatorSessionListSchema,
  type MessageKey,
  type OperatorSession,
} from "@questify/shared";
import type { AuthedResult, Session } from "#src/api/session.ts";

type Requester = Pick<Session, "request">;

/** A session the door can check players in to right now (an hour before the start until the end). */
export type DoorSession = OperatorSession;

export type DoorSessions =
  | Readonly<{ kind: "sessions"; sessions: readonly DoorSession[] }>
  | Readonly<{ kind: "removed" | "signed_out" | "network" }>;

function failed(answer: AuthedResult): "removed" | "signed_out" | "network" {
  if (answer.kind === "error" && answer.code === "not_operator") return "removed";
  return answer.kind === "signed_out" ? "signed_out" : "network";
}

/** The sessions the operator can check in to now; a removed operator gets `removed` (FR-905). */
export async function fetchDoorSessions(
  session: Requester,
  eventId: string,
): Promise<DoorSessions> {
  const answer = await session.request({
    method: "GET",
    path: `/v1/operator/events/${encodeURIComponent(eventId)}/sessions`,
  });
  if (answer.kind !== "ok") return { kind: failed(answer) };
  const parsed = operatorSessionListSchema.safeParse(answer.body);
  return parsed.success
    ? { kind: "sessions", sessions: parsed.data.sessions }
    : { kind: "network" };
}

/** The colour the door shows, and the words' key for what happened. */
export type DoorResult = Readonly<{
  color: "green" | "orange" | "red";
  message: MessageKey;
  username: string | null;
}>;

const OUTCOMES: Readonly<Record<string, Pick<DoorResult, "color" | "message">>> = {
  checked_in: { color: "green", message: "door.checkedIn" },
  already: { color: "orange", message: "door.already" },
  not_registered: { color: "red", message: "door.notRegistered" },
  too_early: { color: "red", message: "door.tooEarly" },
  ended: { color: "red", message: "door.ended" },
};

const INVALID_CODE_REASONS: readonly string[] = ["invalid_code", "old_code"];

function refusal(reason: string | undefined, username: string | null): DoorResult {
  const invalid = INVALID_CODE_REASONS.includes(reason ?? "");
  return { color: "red", message: invalid ? "door.invalid" : "door.refused", username };
}

/** What the door's answer means: a walk-in is green with its own words; any refusal is red. */
export function doorResultOf(body: unknown): DoorResult | null {
  const parsed = doorAnswerSchema.safeParse(body);
  if (!parsed.success) return null;
  const { result, reason, walkIn, player } = parsed.data;
  const username = player?.username ?? null;
  if (result === "refused") return refusal(reason, username);
  const outcome = OUTCOMES[result];
  if (outcome === undefined) return null;
  const arrivedUnregistered = result === "checked_in" && walkIn === true;
  return { ...outcome, message: arrivedUnregistered ? "door.walkIn" : outcome.message, username };
}

export type DoorCheckIn =
  | Readonly<{ kind: "result"; result: DoorResult }>
  | Readonly<{ kind: "removed" | "signed_out" | "network" }>;

/** Checks the scanned player in to the session. Each call is its own request: a repeat is answered `already`. */
export async function checkInPlayer(
  session: Requester,
  sessionId: string,
  code: string,
): Promise<DoorCheckIn> {
  const answer = await session.request({
    method: "POST",
    path: `/v1/operator/sessions/${encodeURIComponent(sessionId)}/check-in`,
    body: { code },
  });
  if (answer.kind !== "ok") return { kind: failed(answer) };
  const result = doorResultOf(answer.body);
  return result === null ? { kind: "network" } : { kind: "result", result };
}
