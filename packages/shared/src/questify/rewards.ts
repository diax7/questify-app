import { z } from "zod";
import { itemSchema } from "#src/players/items";
import { achievementTierSchema } from "#src/questify/achievements";

const bilingual = z.strictObject({ ar: z.string(), en: z.string() });

/** One level of the curve with its item (level 1 has none) and whether the caller owns it. */
export const levelRewardSchema = z.strictObject({
  level: z.number().int().positive(),
  xpFrom: z.number().int().nonnegative(),
  item: itemSchema.nullable(),
  owned: z.boolean(),
});
export type LevelReward = z.infer<typeof levelRewardSchema>;

/** An achievement that unlocks an item: the tier it takes, and whether the caller owns the item and holds the tier. */
export const achievementRewardSchema = z.strictObject({
  id: z.string().min(1).max(64),
  name: bilingual,
  visualKey: z.string(),
  tier: achievementTierSchema,
  item: itemSchema,
  owned: z.boolean(),
  earned: z.boolean(),
});
export type AchievementReward = z.infer<typeof achievementRewardSchema>;

/**
 * `GET /v1/me/rewards` (T-404c, ADR-767): the caller's level and its bar, the whole curve with each level's item, and the
 * achievement items. Strict, so a field added to the door never reaches a phone by accident. Nothing here has a price.
 */
export const levelRewardsSchema = z.strictObject({
  level: z.strictObject({
    number: z.number().int().positive(),
    title: bilingual,
    xp: z.number().int().nonnegative(),
    levelFrom: z.number().int().nonnegative(),
    nextLevelAt: z.number().int().positive().nullable(),
  }),
  levels: z.array(levelRewardSchema).max(100),
  achievements: z.array(achievementRewardSchema),
});
export type LevelRewards = z.infer<typeof levelRewardsSchema>;
