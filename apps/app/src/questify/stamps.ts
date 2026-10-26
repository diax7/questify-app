import type { Language, MessageKey, OwnEvent } from "@questify/shared";

/** What a stamp or a history row says about the event's result (FR-709): never a rank while the event runs. */
export type StampState =
  | Readonly<{ kind: "upcoming" }>
  | Readonly<{ kind: "live" }>
  | Readonly<{ kind: "pending" }>
  | Readonly<{ kind: "final"; rank: number }>
  | Readonly<{ kind: "unranked" }>;

/**
 * The server's `rankState` `live` also covers an event that has not started, so a draft or scheduled one reads
 * "upcoming" instead of "live now"; `final` without a rank cannot happen but reads as not ranked.
 */
export function stampState(
  event: Pick<OwnEvent, "rankState" | "rank" | "eventStatus">,
): StampState {
  switch (event.rankState) {
    case "live":
      return event.eventStatus === "draft" || event.eventStatus === "scheduled"
        ? { kind: "upcoming" }
        : { kind: "live" };
    case "pending":
      return { kind: "pending" };
    case "final":
      return event.rank === null ? { kind: "unranked" } : { kind: "final", rank: event.rank };
    case "unranked":
      return { kind: "unranked" };
  }
}

/** The text key and values that say a state in words. */
export function stateText(
  state: StampState,
): Readonly<{ key: MessageKey; params?: Readonly<Record<string, number>> }> {
  switch (state.kind) {
    case "upcoming":
      return { key: "passport.upcoming" };
    case "live":
      return { key: "passport.live" };
    case "pending":
      return { key: "passport.rankPending" };
    case "final":
      return { key: "passport.rank", params: { rank: state.rank } };
    case "unranked":
      return { key: "passport.unranked" };
  }
}

/** The first letter of the event's name in the screen's language: the emblem until events have logos (T-602). */
export function emblemOf(name: Readonly<{ ar: string; en: string }>, language: Language): string {
  const text = (name[language] || name[language === "ar" ? "en" : "ar"]).trim();
  return Array.from(text)[0]?.toLocaleUpperCase() ?? "?";
}

const DAY_MS = 86_400_000;
const SAUDI_OFFSET_MS = 3 * 3_600_000;

/** The Saudi calendar day (no daylight saving) an instant falls on, as a day count. */
const saudiDay = (instant: number): number => Math.floor((instant + SAUDI_OFFSET_MS) / DAY_MS);

export type EndsIn = Readonly<{
  key:
    | "questifyQuests.endsToday"
    | "questifyQuests.endsInOne"
    | "questifyQuests.endsInTwo"
    | "questifyQuests.endsInFew"
    | "questifyQuests.endsInMany";
  days: number;
}>;

/**
 * "Ends today" or "Ends in N days", counted in Saudi calendar days, with Arabic's one, two, few (3 to 10) and many
 * forms. Null once the end has passed (the list stops offering the quest at `endsAt`).
 */
export function endsIn(endsAt: string, now: Date): EndsIn | null {
  const end = Date.parse(endsAt);
  if (Number.isNaN(end) || end <= now.getTime()) return null;
  const days = saudiDay(end) - saudiDay(now.getTime());
  if (days <= 0) return { key: "questifyQuests.endsToday", days: 0 };
  if (days === 1) return { key: "questifyQuests.endsInOne", days };
  if (days === 2) return { key: "questifyQuests.endsInTwo", days };
  return { key: days <= 10 ? "questifyQuests.endsInFew" : "questifyQuests.endsInMany", days };
}

/** A quest's progress for the bar: the server counts past the target, the screen never shows more than done. */
export const clampedProgress = (progress: number, target: number): number =>
  Math.min(Math.max(progress, 0), target);
