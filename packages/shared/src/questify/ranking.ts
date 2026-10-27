import { z } from "zod";
import { equipmentSchema } from "#src/players/items";

/**
 * The Questify-wide ranking by XP (T-408, FR-611, ADR-322, ADR-323): a lifetime board and one board per Questify month
 * (a season, changing at 04:00 Riyadh time on the 1st). Only the username, avatar, equipment, XP and lifetime level of
 * a player are ever shown (FR-120); never an id, a contact or gems.
 */

export const QUESTIFY_RANKING_SCOPES = ["lifetime", "month"] as const;
export type QuestifyRankingScope = (typeof QUESTIFY_RANKING_SCOPES)[number];
export const questifyRankingQuerySchema = z.strictObject({
  scope: z.enum(QUESTIFY_RANKING_SCOPES).default("lifetime"),
});

/** A Questify month, `YYYY-MM`. */
export const questifyMonthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

const shownSchema = z.strictObject({
  rank: z.number().int().min(1),
  username: z.string().min(1).max(30),
  avatar: z.string().min(1).max(40),
  equipment: equipmentSchema,
  xp: z.number().int().min(1),
  level: z.number().int().min(1),
});
export const questifyRankingRowSchema = shownSchema.extend({ isMe: z.boolean() });
export type QuestifyRankingRow = z.infer<typeof questifyRankingRowSchema>;
export type QuestifyRankingMe = z.infer<typeof shownSchema>;

/**
 * `GET /v1/questify/ranking`: the top 10 and the caller's own place (null without XP on that board), in the 11-row
 * layout (ADR-052). `month` is the board's Questify month for the `month` scope, null for `lifetime`.
 */
export const questifyRankingSchema = z.strictObject({
  scope: z.enum(QUESTIFY_RANKING_SCOPES),
  month: questifyMonthSchema.nullable(),
  rows: z.array(questifyRankingRowSchema).max(10),
  me: shownSchema.nullable(),
});
export type QuestifyRanking = z.infer<typeof questifyRankingSchema>;

/** `GET /v1/admin/questify/seasons`: every month board and the current month, newest first, with its ranked count. */
export const questifySeasonsSchema = z.strictObject({
  seasons: z.array(
    z.strictObject({
      month: questifyMonthSchema,
      players: z.number().int().nonnegative(),
      current: z.boolean(),
    }),
  ),
});
export type QuestifySeasons = z.infer<typeof questifySeasonsSchema>;

/** `GET /v1/admin/questify/seasons/{month}`: a season's ranked count and its top 10, read with today's rule. */
export const questifySeasonSchema = z.strictObject({
  month: questifyMonthSchema,
  players: z.number().int().nonnegative(),
  rows: z.array(shownSchema).max(10),
});
export type QuestifySeason = z.infer<typeof questifySeasonSchema>;
