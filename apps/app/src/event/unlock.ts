import { formatEventTime, formatNumber, type Language } from "@questify/shared";
import type { Bilingual } from "#src/i18n/text.ts";

// ================================================================ community unlocks (T-306c, ADR-228)

/**
 * What the server says about a quest, category or reward a community goal still locks: the goal and its numbers,
 * never the target. `scheduled` until the goal starts, `waiting` while it runs, `missed` once it ended short.
 */
export type CommunityLock = Readonly<{
  goalId: string;
  title: Bilingual;
  measure: "points" | "completions" | "players";
  threshold: number;
  state: "scheduled" | "waiting" | "missed";
  startsAt: string;
}>;

const MEASURES: readonly string[] = ["points", "completions", "players"];
const STATES: readonly string[] = ["scheduled", "waiting", "missed"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const textOf = (value: unknown): Bilingual => {
  const both = isRecord(value) ? value : {};
  return {
    ar: typeof both["ar"] === "string" ? both["ar"] : null,
    en: typeof both["en"] === "string" ? both["en"] : null,
  };
};

/** The note as sent, or null when there is none or it is not well formed (a newer state too: shown as "Locked"). */
export function lockNoteOf(value: unknown): CommunityLock | null {
  if (
    !isRecord(value) ||
    typeof value["goalId"] !== "string" ||
    typeof value["threshold"] !== "number" ||
    typeof value["startsAt"] !== "string" ||
    !MEASURES.includes(String(value["measure"])) ||
    !STATES.includes(String(value["state"]))
  ) {
    return null;
  }
  return {
    goalId: value["goalId"],
    title: textOf(value["title"]),
    measure: value["measure"] as CommunityLock["measure"],
    threshold: value["threshold"],
    state: value["state"] as CommunityLock["state"],
    startsAt: value["startsAt"],
  };
}

/** Whether two notes are the same lock: one step of one goal. */
export const sameLock = (a: CommunityLock | null, b: CommunityLock | null): boolean =>
  a !== null && b !== null && a.goalId === b.goalId && a.threshold === b.threshold;

type UnlockKey =
  | "community.unlock.points"
  | "community.unlock.completions"
  | "community.unlock.players"
  | "community.unlock.starts"
  | "community.unlock.missed";

/**
 * The line under a locked item: "Unlocks at 5,000 community points" (by the goal's measure) while it runs, "Unlocks
 * with a community goal that starts …" before it starts, "Not unlocked: the community goal was missed" after a miss.
 */
export function unlockLine(
  note: CommunityLock,
  language: Language,
  timeZone: string,
): Readonly<{ key: UnlockKey; values: Readonly<Record<string, string>> }> {
  if (note.state === "missed") {
    return { key: "community.unlock.missed", values: {} };
  }
  if (note.state === "scheduled") {
    return {
      key: "community.unlock.starts",
      values: { time: formatEventTime(new Date(note.startsAt), timeZone, language) },
    };
  }
  return {
    key: `community.unlock.${note.measure}`,
    values: { threshold: formatNumber(note.threshold, language) },
  };
}
