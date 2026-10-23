import { MEET_CODE_PREFIX, type MessageKey } from "@questify/shared";
import type { AuthedResult, Session } from "#src/api/session.ts";
import type { Position } from "#src/event/location.ts";
import { completionAnswer, type CompletionAnswer, type MeetReason } from "#src/event/quests-api.ts";

/** How often the shown code's state is read, slower after a 429, and how long one code lives (ADR-209). */
export const MEET_POLL = { everyMs: 2000, slowMs: 5000, codeMs: 60_000 } as const;

const MEET_TEXT: Readonly<Record<MeetReason, MessageKey>> = {
  already_met: "meet.refused.alreadyMet",
  daily_cap: "meet.refused.dailyCap",
  their_daily_cap: "meet.refused.theirDailyCap",
  done: "meet.refused.done",
  their_done: "meet.refused.theirDone",
  expired: "meet.refused.ended",
  used: "meet.refused.ended",
  self: "meet.refused.self",
  same_device: "meet.refused.sameDevice",
  not_in_event: "meet.refused.notInEvent",
  not_for_them: "meet.refused.notForThem",
  bad_code: "meet.refused.badCode",
  off: "meet.refused.off",
};

/** The words for a refused meeting; a reason this build does not know reads as a failed try. */
export function meetRefusalText(
  answer: Extract<CompletionAnswer, { kind: "meet_refused" }>,
  t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string,
): string {
  if (answer.reason === undefined) {
    return t("questsTab.failed");
  }
  return t(MEET_TEXT[answer.reason], {
    name: answer.name ?? "",
    count: answer.cap ?? 0,
  });
}

/** Whether a scanned text is a meet code, which the scanner sends to `POST /v1/meet` (FR-212). */
export const isMeetCode = (text: string): boolean => text.startsWith(MEET_CODE_PREFIX);

/** The event's meet switch answers `feature_off`: said as meet quests being off, not as location's. */
const meetAnswer = (answer: CompletionAnswer): CompletionAnswer =>
  answer.kind === "location_off"
    ? { kind: "meet_refused", reason: "off", name: null, cap: null }
    : answer;

/** The other player's public name and the quest, beside an ordinary completion's answer. */
export type MetAnswer = CompletionAnswer &
  Readonly<{ questId?: string; met?: Readonly<{ username: string; avatar: string }> }>;

/** The completion `POST /v1/meet` answers, with the quest it paid and whom the player met. */
export function metAnswerOf(answer: AuthedResult): MetAnswer {
  const parsed = meetAnswer(completionAnswer(answer));
  if (parsed.kind !== "completed" || answer.kind !== "ok") {
    return parsed;
  }
  const body = answer.body as Record<string, unknown>;
  const met = body["met"] as Record<string, unknown> | undefined;
  return {
    ...parsed,
    ...(typeof body["questId"] === "string" ? { questId: body["questId"] } : {}),
    ...(typeof met?.["username"] === "string" && typeof met["avatar"] === "string"
      ? { met: { username: met["username"], avatar: met["avatar"] } }
      : {}),
  };
}

/** Scans another player's meet code: both are paid, or the refusal says why. The key is the caller's (`keyFor`). */
export async function scanMeet(
  session: Pick<Session, "request">,
  code: string,
  key: string,
  position: Position | null,
): Promise<MetAnswer> {
  return metAnswerOf(
    await session.request({
      method: "POST",
      path: "/v1/meet",
      body: { code, ...(position === null ? {} : { position }) },
      headers: { "idempotency-key": key },
    }),
  );
}

/** A fresh code to show, or why none was given (the sheet's words for a quest refusal). */
export type PassAnswer =
  | Readonly<{ kind: "pass"; code: string; passId: string; expiresAt: string }>
  | Exclude<CompletionAnswer, { kind: "completed" }>;

export function passAnswerOf(answer: AuthedResult): PassAnswer {
  if (answer.kind === "ok") {
    const body = (answer.body ?? {}) as Record<string, unknown>;
    return typeof body["code"] === "string" &&
      typeof body["passId"] === "string" &&
      typeof body["expiresAt"] === "string"
      ? { kind: "pass", code: body["code"], passId: body["passId"], expiresAt: body["expiresAt"] }
      : { kind: "failed" };
  }
  const parsed = meetAnswer(completionAnswer(answer));
  return parsed.kind === "completed" ? { kind: "failed" } : parsed;
}

/** Asks for a fresh meet code for this quest (ADR-209); a new one ends the player's earlier one. */
export async function showMeetPass(
  session: Pick<Session, "request">,
  questId: string,
): Promise<PassAnswer> {
  return passAnswerOf(
    await session.request({
      method: "POST",
      path: `/v1/quests/${encodeURIComponent(questId)}/meet-pass`,
    }),
  );
}

/** What the shown code's poll says: open, expired, used with who met the player; `slow` after a 429. */
export type PassState =
  | Readonly<{ state: "open" | "expired" }>
  | Readonly<{ state: "used"; username: string; points: number }>
  | Readonly<{ state: "slow" }>
  | Readonly<{ state: "unknown" }>;

export function passStateOf(answer: AuthedResult): PassState {
  if (answer.kind === "error" && answer.status === 429) {
    return { state: "slow" };
  }
  if (answer.kind !== "ok") {
    return { state: "unknown" };
  }
  const body = (answer.body ?? {}) as Record<string, unknown>;
  const met = body["met"] as Record<string, unknown> | null | undefined;
  if (
    body["state"] === "used" &&
    typeof met?.["username"] === "string" &&
    typeof met["points"] === "number"
  ) {
    return { state: "used", username: met["username"], points: met["points"] };
  }
  return body["state"] === "open" || body["state"] === "expired"
    ? { state: body["state"] }
    : { state: "unknown" };
}

export async function readPassState(
  session: Pick<Session, "request">,
  passId: string,
): Promise<PassState> {
  return passStateOf(
    await session.request({ method: "GET", path: `/v1/meet-passes/${encodeURIComponent(passId)}` }),
  );
}

/** When to read the shown code's state next: every 2 s, every 5 s after a 429, never past the code's minute. */
export function nextPoll(state: PassState, shownAt: number, now: number): number | null {
  if (state.state === "used" || state.state === "expired" || now - shownAt >= MEET_POLL.codeMs) {
    return null;
  }
  return state.state === "slow" ? MEET_POLL.slowMs : MEET_POLL.everyMs;
}
