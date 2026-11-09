import type { Achievement, Language } from "@questify/shared";
import type { Translate } from "#src/i18n/words.ts";

/** The words of one achievement tile: its name, tier, progress line and the single label a screen reader gets. */
export type TileText = Readonly<{
  name: string;
  tierName: string | null;
  nextText: string | null;
  label: string;
  /** The player's own gold badge says there is no tier above it. */
  topTier: boolean;
}>;

/** The progress line, shown only on the player's own profile and only while a next tier exists. */
function nextTextOf(achievement: Achievement, withProgress: boolean, t: Translate): string | null {
  const { next } = achievement;
  return withProgress && next !== null
    ? t("achievements.next", {
        tier: t(`achievements.tier.${next.tier}`),
        progress: Math.min(achievement.progress, next.target),
        target: next.target,
      })
    : null;
}

/**
 * The words of one tile for the given language. `withProgress` is true only on the player's own profile: it adds the
 * progress line toward the next tier and lets the top-tier mark show; another player's tile never carries either.
 */
export function tileTextOf(
  achievement: Achievement,
  withProgress: boolean,
  language: Language,
  t: Translate,
): TileText {
  const name = achievement.name[language];
  const { tier, next } = achievement;
  const tierName = tier === null ? null : t(`achievements.tier.${tier}`);
  const nextText = nextTextOf(achievement, withProgress, t);
  const badgeLabel =
    tierName === null
      ? t("achievements.locked", { name })
      : t("achievements.badge", { name, tier: tierName });
  // The label replaces the tile's children for a screen reader, so the progress line is part of it.
  const label = nextText === null ? badgeLabel : `${badgeLabel}. ${nextText}`;
  return {
    name,
    tierName,
    nextText,
    label,
    topTier: withProgress && tier === "gold" && next === null,
  };
}
