import type { EventTerms, Language, MessageKey } from "@questify/shared";
import { playText, type PlayPaid } from "#src/event/amount.ts";
import type { Voted } from "#src/event/plays.ts";
import { streakBonusLine } from "#src/streaks/event-streak.ts";

type Translate = (key: MessageKey, params?: Readonly<Record<string, string | number>>) => string;

/** A thank-you and then what the play paid, or "Already recorded" for a replay that paid nothing. */
const thenPaid =
  (thanks: MessageKey) =>
  (t: Translate, terms: EventTerms, language: Language, answer: PlayPaid): string =>
    `${t(thanks)} ${playText(t, terms, language, answer)}`;

/** What a vote says under its options (FR-207). */
export const voteSaid = thenPaid("play.vote.recorded");

/** What a survey says once sent (FR-214). */
export const surveySaid = thenPaid("play.survey.thanks");

/** What a share says once paid (FR-220). */
export const shareSaid = thenPaid("play.share.thanks");

/**
 * What a live poll says after a vote: its thanks, then the points; a 0-point poll can still pay a streak bonus
 * (T-405b), whose line shows on its own. A replay that paid nothing says "Already recorded" instead.
 */
export function pollSaid(
  t: Translate,
  terms: EventTerms,
  language: Language,
  answer: Voted,
): string {
  const paid =
    answer.points > 0 || answer.replayed
      ? playText(t, terms, language, answer)
      : answer.streakBonus === null
        ? null
        : streakBonusLine(t, answer.streakBonus);
  return paid === null ? t("poll.thanks") : `${t("poll.thanks")} ${paid}`;
}
