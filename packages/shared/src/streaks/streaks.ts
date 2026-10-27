import { z } from "zod";

/**
 * Streaks (T-405, ADR-295 to ADR-301). The event day streak counts a player's open event days in a row; its organizer
 * may pay a flat bonus from day 2. The Questify daily streak counts days with any play (04:00 to 04:00 Riyadh time) and
 * pays XP at milestones, each once ever. Nothing here is sold and nothing is left to chance (ADR-300).
 */

/** The highest event streak bonus (the table's CHECK). */
export const STREAK_BONUS_MAX = 100000;
/** At most six closed weekdays, so every week keeps an open day; at most 366 closed dates. */
export const CLOSED_WEEKDAYS_MAX = 6;
export const CLOSED_DAYS_MAX = 366;

const count = z.number().int().nonnegative();
const bonusPoints = z.number().int().min(1).max(STREAK_BONUS_MAX);
/** An ISO weekday: 1 is Monday, 7 is Sunday. */
const weekday = z.number().int().min(1).max(7);
/** A calendar day in the event's own zone. */
const day = z.iso.date();

/** `PUT …/events/{eventId}/streak`: the whole settings, always (a missing field is not "unchanged"). */
export const streakSettingsBodySchema = z.strictObject({
  enabled: z.boolean(),
  /** Points paid with each day's first quest from streak day 2; null pays none. */
  bonusPoints: bonusPoints.nullable(),
  closedWeekdays: z
    .array(weekday)
    .max(CLOSED_WEEKDAYS_MAX)
    .refine((days) => new Set(days).size === days.length, "each weekday once"),
  closedDays: z.array(day).max(CLOSED_DAYS_MAX),
});
export type StreakSettingsBody = z.infer<typeof streakSettingsBodySchema>;

/** The event's streak for its owners and editors, with whether it is multi-day and its day now. */
export const streakSettingsSchema = z.object({
  enabled: z.boolean(),
  bonusPoints: bonusPoints.nullable(),
  closedWeekdays: z.array(weekday),
  closedDays: z.array(day),
  multiDay: z.boolean(),
  today: day,
});
export type StreakSettings = z.infer<typeof streakSettingsSchema>;

/** The fields a 422 `invalid_streak` can name. */
export const STREAK_FIELDS = ["enabled", "bonusPoints", "closedWeekdays", "closedDays"] as const;
export type StreakField = (typeof STREAK_FIELDS)[number];
export const invalidStreakSchema = z.object({ field: z.enum(STREAK_FIELDS) });

/** Why a 409 `streak_conflict` refused the settings; `day_started` names the first started day it would change. */
export const STREAK_CONFLICTS = ["single_day", "day_started", "results_final", "archived"] as const;
export type StreakConflictReason = (typeof STREAK_CONFLICTS)[number];
export const streakConflictSchema = z.object({
  reason: z.enum(STREAK_CONFLICTS),
  day: day.optional(),
});
export type StreakConflict = z.infer<typeof streakConflictSchema>;

/** The event streak on event Home (null while it is off): today counted, today closed, the bonus. */
export const eventStreakSchema = z.object({
  days: count,
  playedToday: z.boolean(),
  closedToday: z.boolean(),
  bonusPoints: bonusPoints.nullable(),
});
export type EventStreak = z.infer<typeof eventStreakSchema>;

/** The streak bonus one completion paid (the completion answers' `streakBonus`), with the streak day it was for. */
export const streakBonusSchema = z.object({ points: bonusPoints, days: z.number().int().min(2) });
export type StreakBonus = z.infer<typeof streakBonusSchema>;

const milestone = z.object({ days: z.number().int().min(2), xp: z.number().int().positive() });

/**
 * The Questify daily streak (`GET /v1/me`, null while the platform switch is off): its length, whether today is
 * counted, and the next milestone not yet paid.
 */
export const dailyStreakSchema = z.object({
  days: count,
  today: z.boolean(),
  next: milestone.nullable(),
});
export type DailyStreak = z.infer<typeof dailyStreakSchema>;

/** The daily streak in a sync answer, with the milestones this sync paid. */
export const syncDailyStreakSchema = dailyStreakSchema.extend({ rewards: z.array(milestone) });
export type SyncDailyStreak = z.infer<typeof syncDailyStreakSchema>;
