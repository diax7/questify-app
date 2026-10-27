import type { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  CLOSED_DAYS_MAX,
  CLOSED_WEEKDAYS_MAX,
  STREAK_BONUS_MAX,
  STREAK_CONFLICTS,
  STREAK_FIELDS,
  dailyStreakSchema,
  eventStreakSchema,
  invalidStreakSchema,
  streakBonusSchema,
  streakConflictSchema,
  streakSettingsBodySchema,
  streakSettingsSchema,
  syncDailyStreakSchema,
} from "#src/streaks/streaks";

const accepts = (schema: z.ZodType, value: unknown) => schema.safeParse(value).success;
const body = {
  enabled: true,
  bonusPoints: 25,
  closedWeekdays: [5],
  closedDays: ["2026-11-02"],
};
const days = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
  );

describe("streakSettingsBodySchema", () => {
  it("takes the whole settings: on or off, a bonus or none, closed weekdays and dates", () => {
    expect(streakSettingsBodySchema.parse(body)).toEqual(body);
    const none = { enabled: false, bonusPoints: null, closedWeekdays: [], closedDays: [] };
    expect(streakSettingsBodySchema.parse(none)).toEqual(none);
  });

  it("bounds the bonus to whole points from 1 to 100,000", () => {
    expect(STREAK_BONUS_MAX).toBe(100000);
    for (const bonusPoints of [1, STREAK_BONUS_MAX])
      expect(accepts(streakSettingsBodySchema, { ...body, bonusPoints })).toBe(true);
    for (const bonusPoints of [0, -1, STREAK_BONUS_MAX + 1, 2.5, "5", undefined])
      expect(accepts(streakSettingsBodySchema, { ...body, bonusPoints }), String(bonusPoints)).toBe(
        false,
      );
  });

  it("takes ISO weekdays 1 to 7, each once, at most six", () => {
    expect(CLOSED_WEEKDAYS_MAX).toBe(6);
    expect(accepts(streakSettingsBodySchema, { ...body, closedWeekdays: [1, 2, 3, 4, 5, 6] })).toBe(
      true,
    );
    expect(accepts(streakSettingsBodySchema, { ...body, closedWeekdays: [7] })).toBe(true);
    for (const closedWeekdays of [[0], [8], [1.5], [3, 3], [1, 2, 3, 4, 5, 6, 7], ["1"]])
      expect(
        accepts(streakSettingsBodySchema, { ...body, closedWeekdays }),
        JSON.stringify(closedWeekdays),
      ).toBe(false);
  });

  it("takes calendar dates, at most 366", () => {
    expect(CLOSED_DAYS_MAX).toBe(366);
    expect(accepts(streakSettingsBodySchema, { ...body, closedDays: days(366) })).toBe(true);
    expect(accepts(streakSettingsBodySchema, { ...body, closedDays: days(367) })).toBe(false);
    for (const closedDays of [["2026-13-01"], ["2026-11-2"], ["2026-11-02T00:00:00Z"], [20261102]])
      expect(accepts(streakSettingsBodySchema, { ...body, closedDays }), String(closedDays)).toBe(
        false,
      );
  });

  it("refuses a missing field or an unknown one", () => {
    for (const key of Object.keys(body)) {
      const without: Record<string, unknown> = { ...body };
      delete without[key];
      expect(accepts(streakSettingsBodySchema, without), key).toBe(false);
    }
    expect(accepts(streakSettingsBodySchema, { ...body, freeze: true })).toBe(false);
  });
});

describe("the streak reads", () => {
  it("keeps the settings with the event's multi-day flag and its day now", () => {
    const settings = { ...body, multiDay: true, today: "2026-10-27" };
    expect(streakSettingsSchema.parse(settings)).toEqual(settings);
    expect(accepts(streakSettingsSchema, { ...settings, today: "today" })).toBe(false);
  });

  it("keeps the player's event streak and a completion's bonus from day 2", () => {
    const home = { days: 4, playedToday: false, closedToday: true, bonusPoints: null };
    expect(eventStreakSchema.parse(home)).toEqual(home);
    expect(accepts(eventStreakSchema, { ...home, days: -1 })).toBe(false);
    expect(streakBonusSchema.parse({ points: 5, days: 2 })).toEqual({ points: 5, days: 2 });
    for (const bonus of [
      { points: 5, days: 1 },
      { points: 0, days: 2 },
    ])
      expect(accepts(streakBonusSchema, bonus)).toBe(false);
  });

  it("keeps the daily streak and the milestones a sync paid", () => {
    const daily = { days: 7, today: true, next: { days: 14, xp: 150 } };
    expect(dailyStreakSchema.parse(daily)).toEqual(daily);
    expect(dailyStreakSchema.parse({ ...daily, next: null })).toEqual({ ...daily, next: null });
    const synced = { ...daily, rewards: [{ days: 7, xp: 100 }] };
    expect(syncDailyStreakSchema.parse(synced)).toEqual(synced);
    expect(accepts(syncDailyStreakSchema, daily)).toBe(false);
    expect(accepts(dailyStreakSchema, { ...daily, today: "yes" })).toBe(false);
  });

  it("names the refusals' reasons and fields", () => {
    expect(STREAK_CONFLICTS).toEqual(["single_day", "day_started", "results_final", "archived"]);
    expect(streakConflictSchema.parse({ reason: "day_started", day: "2026-10-27" })).toEqual({
      reason: "day_started",
      day: "2026-10-27",
    });
    expect(accepts(streakConflictSchema, { reason: "frozen" })).toBe(false);
    expect(STREAK_FIELDS).toEqual(["enabled", "bonusPoints", "closedWeekdays", "closedDays"]);
    expect(accepts(invalidStreakSchema, { field: "closedDays" })).toBe(true);
    expect(accepts(invalidStreakSchema, { field: "streak" })).toBe(false);
  });
});
