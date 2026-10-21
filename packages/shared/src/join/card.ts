import type { MessageKey } from "#src/i18n/messages";

/**
 * What the join card tells a player before they join (FR-121, PD-17): what the event's organizer receives about them.
 * The version is sent back with the join and kept on the enrollment, so a change here (join answers arrive with T-212)
 * bumps it and the app shows the new card before joining.
 */
export type JoinCard = Readonly<{
  version: string;
  title: MessageKey;
  receives: readonly MessageKey[];
}>;

const JOIN_CARD: JoinCard = {
  version: "0.1",
  title: "joinCard.title",
  receives: ["joinCard.username", "joinCard.progress", "joinCard.handovers"],
};

/** The join card in force now. */
export function joinCard(): JoinCard {
  return JOIN_CARD;
}
