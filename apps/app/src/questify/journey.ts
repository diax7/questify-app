import {
  ITEM_KINDS,
  type AchievementReward,
  type AchievementTier,
  type Language,
  type LevelRewards,
  type ProfileItem,
} from "@questify/shared";
import type { Translate } from "#src/i18n/words.ts";
import type { QuestifyLevel } from "#src/questify/level.ts";

/** Where a level stands for the player: passed, the one they are on, or still ahead. */
export type StoneState = "reached" | "current" | "locked";

/** One stone of the level trail. */
export type Stone = Readonly<{
  level: number;
  xpFrom: number;
  /** Null for a level that gives nothing (level 1, the start). */
  item: ProfileItem | null;
  owned: boolean;
  state: StoneState;
}>;

/** The whole curve as stones, level 1 first, each marked from the player's own level. */
export function stonesOf(rewards: LevelRewards): readonly Stone[] {
  const mine = rewards.level.number;
  return rewards.levels.map((row) => ({
    level: row.level,
    xpFrom: row.xpFrom,
    item: row.item,
    owned: row.owned,
    state: row.level < mine ? "reached" : row.level === mine ? "current" : "locked",
  }));
}

/** The nearest level ahead that gives an item, or null at the top. */
export function nextReward(
  stones: readonly Stone[],
): Readonly<{ level: number; item: ProfileItem }> | null {
  const ahead = stones.find((stone) => stone.state === "locked" && stone.item !== null);
  return ahead?.item == null ? null : { level: ahead.level, item: ahead.item };
}

/** The level card's numbers in the shape the profile's level bar reads (`levelProgress`). */
export const levelOfRewards = (rewards: LevelRewards): QuestifyLevel => ({
  xp: rewards.level.xp,
  level: rewards.level.number,
  levelFrom: rewards.level.levelFrom,
  nextLevelAt: rewards.level.nextLevelAt,
  title: rewards.level.title,
});

const STONE_KEY = {
  reached: "journey.stoneReached",
  current: "journey.stoneCurrent",
  locked: "journey.stoneLocked",
} as const;

/** What a screen reader says for a stone: the level, the item and where the player stands. */
export function stoneLabel(t: Translate, language: Language, stone: Stone): string {
  if (stone.item === null) {
    return t("journey.stoneStart", { level: stone.level });
  }
  return t(STONE_KEY[stone.state], { level: stone.level, item: stone.item.name[language] });
}

/** Whether the player has the item, holds the tier and waits for the next sync to give it, or has not reached the tier. */
export type RewardState = "owned" | "soon" | "locked";

export const achievementState = (reward: AchievementReward): RewardState =>
  reward.owned ? "owned" : reward.earned ? "soon" : "locked";

const REACH_KEY = {
  bronze: "journey.reach.bronze",
  silver: "journey.reach.silver",
  gold: "journey.reach.gold",
} as const satisfies Record<AchievementTier, string>;

/** "Reach gold in Wanderer": what the player does to unlock the item. */
export const reachLine = (t: Translate, language: Language, reward: AchievementReward): string =>
  t(REACH_KEY[reward.tier], { name: reward.name[language] });

/** What a screen reader says for an achievement reward in each state. */
export function achievementLabel(
  t: Translate,
  language: Language,
  reward: AchievementReward,
): string {
  const params = { item: reward.item.name[language], name: reward.name[language] };
  const state = achievementState(reward);
  if (state === "owned") {
    return t("journey.achievementOwned", params);
  }
  return state === "soon"
    ? t("journey.achievementSoon", params)
    : t("journey.achievementLocked", { item: params.item, reach: reachLine(t, language, reward) });
}

/** The locker tab to open on: the kind a Journey item names in the route's `kind`, else the first tab, as it always was. */
export const lockerStartKind = (value: unknown): ProfileItem["kind"] =>
  ITEM_KINDS.find((kind) => kind === value) ?? "character";

/** The XP line under the bar: "1,400 of 2,000 XP"; at the top level there is no next number. */
export function xpLine(
  t: Translate,
  rewards: LevelRewards,
  format: (value: number) => string,
): string {
  const next = rewards.level.nextLevelAt;
  return next === null
    ? t("level.top")
    : t("journey.xpLine", { xp: format(rewards.level.xp), next: format(next) });
}
