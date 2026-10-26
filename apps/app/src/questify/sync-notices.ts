import {
  ACHIEVEMENT_TIERS,
  type Achievement,
  type AchievementTier,
  type Language,
  type QuestifySync,
} from "@questify/shared";
import type { Translate } from "#src/i18n/words.ts";

/** Each achievement once, at the highest tier this sync wrote (a jump writes every tier passed). */
function highestTiers(
  written: QuestifySync["achievements"],
): ReadonlyArray<Readonly<{ id: string; tier: AchievementTier }>> {
  const best = new Map<string, AchievementTier>();
  for (const { id, tier } of written) {
    const known = best.get(id);
    if (known === undefined || ACHIEVEMENT_TIERS.indexOf(tier) > ACHIEVEMENT_TIERS.indexOf(known)) {
      best.set(id, tier);
    }
  }
  return [...best].map(([id, tier]) => ({ id, tier }));
}

/**
 * The light toasts one sync earns: a line for each achievement that moved up and each Questify quest paid. A name the
 * catalog cannot give (it did not load) still gets a plain line, so the player is told either way.
 */
export function syncNotices(
  sync: QuestifySync,
  catalog: readonly Achievement[] | null,
  t: Translate,
  language: Language,
): string[] {
  const achievements = highestTiers(sync.achievements).map(({ id, tier }) => {
    const name = catalog?.find((achievement) => achievement.id === id)?.name[language];
    return name === undefined
      ? t("sync.achievementGeneric")
      : t("sync.achievement", { name, tier: t(`achievements.tier.${tier}`) });
  });
  const quests = sync.quests.map((quest) =>
    t("sync.quest", { title: quest.title[language], xp: quest.xp }),
  );
  return [...achievements, ...quests];
}

/** Whether a sync wrote anything: only then do the screens read their data again. */
export const wroteSomething = (sync: QuestifySync): boolean =>
  sync.achievements.length > 0 || sync.quests.length > 0 || sync.levelUp !== null;
