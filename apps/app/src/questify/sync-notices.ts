import {
  ACHIEVEMENT_TIERS,
  type Achievement,
  type AchievementTier,
  type Language,
  type QuestifySync,
} from "@questify/shared";
import type { Translate } from "#src/i18n/words.ts";
import { streakNotices } from "#src/streaks/daily-streak.ts";

/**
 * Each achievement once, at the highest tier this sync wrote (a jump writes every tier passed), with the XP of all the
 * tiers written for it (T-404c, ADR-764).
 */
function highestTiers(
  written: QuestifySync["achievements"],
): ReadonlyArray<Readonly<{ id: string; tier: AchievementTier; xp: number }>> {
  const best = new Map<string, { tier: AchievementTier; xp: number }>();
  for (const { id, tier, xp } of written) {
    const known = best.get(id);
    if (known === undefined) {
      best.set(id, { tier, xp });
    } else {
      known.xp += xp;
      if (ACHIEVEMENT_TIERS.indexOf(tier) > ACHIEVEMENT_TIERS.indexOf(known.tier)) {
        known.tier = tier;
      }
    }
  }
  return [...best].map(([id, { tier, xp }]) => ({ id, tier, xp }));
}

/** One achievement's toast: its name and tier, and the XP it paid when it paid any. */
function achievementNotice(
  name: string | undefined,
  tier: AchievementTier,
  xp: number,
  t: Translate,
): string {
  if (name === undefined) {
    return xp > 0 ? t("sync.achievementGenericXp", { xp }) : t("sync.achievementGeneric");
  }
  const params = { name, tier: t(`achievements.tier.${tier}`) };
  return xp > 0 ? t("sync.achievementXp", { ...params, xp }) : t("sync.achievement", params);
}

/**
 * The light toasts one sync earns: a line for each achievement that moved up (with the XP it paid), each achievement item
 * given, each Questify quest paid, and one for each daily streak milestone paid (T-405b). A name the catalog cannot give
 * (it did not load) still gets a plain line, so the player is told either way.
 */
export function syncNotices(
  sync: QuestifySync,
  catalog: readonly Achievement[] | null,
  t: Translate,
  language: Language,
): string[] {
  const achievements = highestTiers(sync.achievements).map(({ id, tier, xp }) =>
    achievementNotice(
      catalog?.find((achievement) => achievement.id === id)?.name[language],
      tier,
      xp,
      t,
    ),
  );
  const items = sync.items.map(({ item }) => t("sync.item", { item: item.name[language] }));
  const quests = sync.quests.map((quest) =>
    t("sync.quest", { title: quest.title[language], xp: quest.xp }),
  );
  return [...achievements, ...items, ...quests, ...streakNotices(sync.dailyStreak, t, language)];
}

/** Whether a sync wrote anything: only then do the screens read their data again. */
export const wroteSomething = (sync: QuestifySync): boolean =>
  sync.achievements.length > 0 ||
  sync.quests.length > 0 ||
  sync.levelUp !== null ||
  sync.items.length > 0 ||
  (sync.dailyStreak?.rewards.length ?? 0) > 0;
