import { toInstant, toLocalInput, type MessageKey } from "@questify/shared";
import type { Bilingual, Goal } from "#src/lib/community.ts";

// ================================================================ the live finale on the dashboard (T-307b)

/** Where the event's results stand, as the Results page reads it. */
export type ResultsState = "not_ended" | "open" | "confirmed" | "revealed";

/** The finale as `GET …/finale` answers it. */
export type FinaleReading = Readonly<{
  /** Whether the big-screen add-on is active for the event. */
  enabled: boolean;
  endsAt: string | null;
  state: ResultsState;
  finale: Readonly<{
    startsAt: string;
    started: boolean;
    goalId: string | null;
    goalTitle: Bilingual | null;
  }> | null;
}>;

/** What the form holds: a wall-clock time in the event's zone and a goal id ("" for no last push). */
export type FinaleDraft = Readonly<{ startsAt: string; goalId: string }>;

const STATES: readonly string[] = ["not_ended", "open", "confirmed", "revealed"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const textOf = (value: unknown): Bilingual | null => {
  if (!isRecord(value)) {
    return null;
  }
  return {
    ar: typeof value["ar"] === "string" ? value["ar"] : null,
    en: typeof value["en"] === "string" ? value["en"] : null,
  };
};

function finaleOf(value: unknown): FinaleReading["finale"] {
  if (!isRecord(value) || typeof value["startsAt"] !== "string") {
    return null;
  }
  const goal = isRecord(value["goal"]) ? value["goal"] : null;
  return {
    startsAt: value["startsAt"],
    started: value["started"] === true,
    goalId: typeof value["goalId"] === "string" ? value["goalId"] : null,
    goalTitle: goal === null ? null : textOf(goal["title"]),
  };
}

/** The reading in an answer, or undefined when it is not one. */
export function finaleReadingOf(body: unknown): FinaleReading | undefined {
  if (!isRecord(body) || typeof body["state"] !== "string" || !STATES.includes(body["state"])) {
    return undefined;
  }
  return {
    enabled: body["enabled"] === true,
    endsAt: typeof body["endsAt"] === "string" ? body["endsAt"] : null,
    state: body["state"] as ResultsState,
    finale: finaleOf(body["finale"]),
  };
}

/** The form for a reading: the saved time and goal, or a time an hour from `now` with no last push. */
export function finaleDraftOf(reading: FinaleReading, timeZone: string, now: number): FinaleDraft {
  return {
    startsAt: toLocalInput(
      new Date(reading.finale === null ? now + 3_600_000 : Date.parse(reading.finale.startsAt)),
      timeZone,
    ),
    goalId: reading.finale?.goalId ?? "",
  };
}

/** The body for `PUT …/finale`, or undefined while the time is empty or not a real time in the zone. */
export function finaleBodyOf(
  draft: FinaleDraft,
  timeZone: string,
): Readonly<{ startsAt: string; goalId: string | null }> | undefined {
  try {
    const at = toInstant(draft.startsAt, timeZone);
    return { startsAt: at.toISOString(), goalId: draft.goalId === "" ? null : draft.goalId };
  } catch (error) {
    if (error instanceof RangeError) {
      return undefined;
    }
    throw error;
  }
}

/** The goals that can still be a last push: not final. The saved goal stays offered even when it ends up over. */
export function pushGoalsOf(goals: readonly Goal[], saved: string | null): readonly Goal[] {
  return goals.filter((goal) => goal.finalAt === null || goal.id === saved);
}

const INVALID_KEYS: Readonly<Record<string, MessageKey>> = {
  startsAt: "finale.invalid.startsAt",
  goal: "finale.invalid.goal",
  goal_done: "finale.invalid.goalDone",
  goal_window: "finale.invalid.goalWindow",
};

/** The line for an `invalid_finale` field, or the time's line for one this page does not know. */
export const invalidKeyOf = (field: string | undefined): MessageKey =>
  INVALID_KEYS[field ?? ""] ?? "finale.invalid.startsAt";

const RESULTS_KEYS: Readonly<Record<ResultsState, MessageKey>> = {
  not_ended: "finale.results.notEnded",
  open: "finale.results.open",
  confirmed: "finale.results.confirmed",
  revealed: "finale.results.revealed",
};

/** The line that says what to do next about the winners. */
export const resultsKeyOf = (state: ResultsState): MessageKey => RESULTS_KEYS[state];
