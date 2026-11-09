import { formatNumber, type EventTerms, type MessageKey } from "@questify/shared";
import { completedOutcome } from "#src/event/amount.ts";
import { spanText } from "#src/event/countdown.ts";
import { meetRefusalText } from "#src/event/meet.ts";
import type { CompletionAnswer, NotOpenReason, QuestLock } from "#src/event/quests-api.ts";
import type { useI18n } from "#src/i18n/provider.tsx";

type Translate = ReturnType<typeof useI18n>["t"];
type Language = "ar" | "en";

export const LOCK_TEXT: Readonly<Record<QuestLock, MessageKey>> = {
  community_locked: "questsTab.notOpen.communityLocked",
  category_not_started: "questsTab.notOpen.categoryNotStarted",
  category_locked: "questsTab.notOpen.categoryLocked",
  order_locked: "questsTab.notOpen.orderLocked",
};

const NOT_OPEN_TEXT: Readonly<Record<NotOpenReason, MessageKey>> = {
  event_not_live: "questsTab.notOpen.eventNotLive",
  hidden: "questsTab.notOpen.hidden",
  paused: "questsTab.notOpen.paused",
  not_started: "questsTab.notOpen.notStarted",
  ended: "questsTab.notOpen.ended",
  not_for_you: "questsTab.notOpen.notForYou",
  ...LOCK_TEXT,
};

const LOCATION_TEXT = {
  no_position: "location.unavailable",
  bad_position: "location.unavailable",
  stale: "location.stale",
  imprecise: "location.imprecise",
} as const;

/** The words for a refused check-in: the player's own distance for not_here, when the server gave it. */
function locationText(
  answer: Extract<CompletionAnswer, { kind: "location_refused" }>,
  t: Translate,
  language: Language,
): string {
  if (answer.reason === "not_here") {
    return answer.distanceM === null
      ? t("location.notHereYet")
      : t("location.notHere", { distance: formatNumber(answer.distanceM, language) });
  }
  return t(answer.reason === undefined ? "location.unavailable" : LOCATION_TEXT[answer.reason]);
}

function waitText(
  answer: Extract<CompletionAnswer, { kind: "wait" }>,
  t: Translate,
  language: Language,
): string {
  const span = answer.seconds === null ? null : spanText(answer.seconds * 1000, language);
  return span === null ? t("questsTab.waitSoon") : t("questsTab.wait", { span });
}

type Said<K extends CompletionAnswer["kind"]> = (
  answer: Extract<CompletionAnswer, { kind: K }>,
  t: Translate,
  language: Language,
  terms: EventTerms,
) => string | null;

/** The words for each answer kind; an answer with none (the sheet closes or sign-in shows) is null. */
const SAID: Readonly<{ [K in CompletionAnswer["kind"]]: Said<K> }> = {
  completed: (answer, t, language, terms) => completedOutcome(answer, t, language, terms),
  wrong_code: (answer, t, language) => answer.problem?.[language] ?? t("questsTab.failed"),
  location_refused: locationText,
  location_off: (_answer, t) => t("location.off"),
  meet_refused: (answer, t) => meetRefusalText(answer, t),
  not_open: (answer, t) =>
    answer.reason === undefined ? t("questsTab.notLive") : t(NOT_OPEN_TEXT[answer.reason]),
  limit: (_answer, t) => t("questsTab.limit"),
  wait: waitText,
  network: (_answer, t) => t("join.network"),
  failed: (_answer, t) => t("questsTab.failed"),
  reload: () => null,
  signed_out: () => null,
};

export function outcomeText(
  answer: CompletionAnswer,
  t: Translate,
  language: Language,
  terms: EventTerms,
): string | null {
  const said = SAID[answer.kind] as Said<CompletionAnswer["kind"]>;
  return said(answer as never, t, language, terms);
}
