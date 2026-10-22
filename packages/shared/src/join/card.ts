import type { MessageKey } from "#src/i18n/messages";

/**
 * What the join card tells a player before they join (FR-121, PD-17): what the event's organizer receives about them.
 * The version is sent back with the join and kept on the enrollment, so a change here bumps it and the app shows the
 * new card before joining. 0.2 (T-212, ADR-148): an event with join fields also receives the answers given on the card.
 */
export type JoinCard = Readonly<{
  version: string;
  title: MessageKey;
  receives: readonly MessageKey[];
}>;

const VERSION = "0.2";
const RECEIVES: readonly MessageKey[] = [
  "joinCard.username",
  "joinCard.progress",
  "joinCard.handovers",
];

/** The join card in force now; `withAnswers` when the event asks join fields (FR-129, FR-131). */
export function joinCard(withAnswers = false): JoinCard {
  return {
    version: VERSION,
    title: "joinCard.title",
    receives: withAnswers ? [...RECEIVES, "joinCard.answers"] : RECEIVES,
  };
}
