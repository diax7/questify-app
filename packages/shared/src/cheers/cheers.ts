import type { MessageKey } from "#src/i18n/messages";

/**
 * The five fixed reactions (T-509, FR-1841, F-343), in the order they are shown. The same five names are the database's
 * (`cheers_reactions()` in migration 0090); a database test fails when the two lists differ.
 */
export const CHEER_REACTIONS = ["heart", "applause", "fire", "star", "party"] as const;
export type CheerReaction = (typeof CHEER_REACTIONS)[number];

/** Each reaction as the emoji every phone and TV draws; no free text exists anywhere in Cheers. */
export const CHEER_EMOJI: Readonly<Record<CheerReaction, string>> = {
  heart: "❤️",
  applause: "👏",
  fire: "🔥",
  star: "⭐",
  party: "🎉",
};

/** Each reaction's name, for a screen reader and a tooltip. */
export const CHEER_NAME_KEYS: Readonly<Record<CheerReaction, MessageKey>> = {
  heart: "cheers.reaction.heart",
  applause: "cheers.reaction.applause",
  fire: "cheers.reaction.fire",
  star: "cheers.reaction.star",
  party: "cheers.reaction.party",
};

/** The lengths an owner picks for a moment, in minutes; the database accepts any whole number from 1 to 30. */
export const CHEER_MOMENT_MINUTES = [1, 2, 5, 10, 15, 30] as const;
export type CheerMomentMinutes = (typeof CHEER_MOMENT_MINUTES)[number];
export const CHEER_MOMENT_DEFAULT_MINUTES = 5;

/** Each length's label, one key per length: Arabic says one, two and 3 to 10 minutes in three different forms. */
export const CHEER_MINUTES_KEYS: Readonly<Record<CheerMomentMinutes, MessageKey>> = {
  1: "cheers.minutesOption.m1",
  2: "cheers.minutesOption.m2",
  5: "cheers.minutesOption.m5",
  10: "cheers.minutesOption.m10",
  15: "cheers.minutesOption.m15",
  30: "cheers.minutesOption.m30",
};

/** Cheers one player may send in any 60 seconds; `cheers_per_minute()` in migration 0090 says the same. */
export const CHEERS_PER_MINUTE = 30;

/** A reaction name from untrusted text, or undefined. */
export const cheerReactionOf = (value: unknown): CheerReaction | undefined =>
  CHEER_REACTIONS.find((reaction) => reaction === value);
