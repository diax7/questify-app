import { z } from "zod";

/** Achievement tiers, lowest first (FR-707). */
export const ACHIEVEMENT_TIERS = ["bronze", "silver", "gold"] as const;
export const achievementTierSchema = z.enum(ACHIEVEMENT_TIERS);
export type AchievementTier = z.infer<typeof achievementTierSchema>;

const bilingual = z.object({ ar: z.string(), en: z.string() });

/** One of the caller's achievements: `tier` null is the silhouette (FR-708); `next` null once gold is earned. */
export const achievementSchema = z.object({
  id: z.string().min(1).max(64),
  name: bilingual,
  visualKey: z.string().min(1).max(40),
  tier: achievementTierSchema.nullable(),
  progress: z.number().int().nonnegative(),
  next: z.object({ tier: achievementTierSchema, target: z.number().int().positive() }).nullable(),
});
export type Achievement = z.infer<typeof achievementSchema>;
export const achievementsSchema = z.object({ achievements: z.array(achievementSchema) });

/** What one `POST /v1/me/questify/sync` wrote: every tier newly earned, in catalog then tier order. */
export const questifySyncSchema = z.object({
  achievements: z.array(z.object({ id: z.string().min(1).max(64), tier: achievementTierSchema })),
});
export type QuestifySync = z.infer<typeof questifySyncSchema>;

/** Another player's achievement: the tier only, never progress. */
export const publicAchievementSchema = z.object({
  id: z.string().min(1).max(64),
  tier: achievementTierSchema.nullable(),
});
