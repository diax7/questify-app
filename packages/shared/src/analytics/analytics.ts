import { z } from "zod";

/**
 * The event's analytics (T-607, FR-1201 to FR-1205, FR-1625): three answers the team reads, each only counts. No
 * player, name or time of one person appears in any of them, and there is no time-spent or heatmap figure (FR-1203).
 */

/** The panels the dashboard asks for, one request each. */
export const ANALYTICS_PANELS = ["participation", "quests", "economy"] as const;
export type AnalyticsPanel = (typeof ANALYTICS_PANELS)[number];

/** How players joined, in the order the page lists them; `other` holds the enrollments older than the join source. */
export const JOIN_SOURCES = [
  "code",
  "qr",
  "link",
  "public_list",
  "invite",
  "operator",
  "rehearsal",
  "other",
] as const;
export type JoinSource = (typeof JOIN_SOURCES)[number];

const count = z.number().int().min(0);
const text = z.strictObject({ ar: z.string().nullable(), en: z.string().nullable() });

/** `GET …/events/{id}/analytics/participation`: joined, active, activation, returning, players over time, join source. */
export const participationSchema = z.strictObject({
  joined: count,
  active: count,
  /** Active players as a whole percent of joined players; null when nobody joined (FR-1625). */
  activation: z.number().int().min(0).max(100).nullable(),
  returning: count,
  /** The figures include rehearsal accounts, which are erased at go-live (T-211). */
  rehearsal: z.boolean(),
  unit: z.enum(["hour", "day", "week"]),
  /** The running count of joined players, `at` in the event's own time zone. */
  series: z.array(
    z.strictObject({ at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u), joined: count }),
  ),
  sources: z.strictObject({
    code: count,
    qr: count,
    link: count,
    public_list: count,
    invite: count,
    operator: count,
    rehearsal: count,
    other: count,
  }),
});
export type Participation = z.infer<typeof participationSchema>;

/** `GET …/events/{id}/analytics/quests`: every visible quest's players who completed it, by category. */
export const questsAnalyticsSchema = z.strictObject({
  joined: count,
  categories: z.array(
    z.strictObject({
      id: z.uuid(),
      name: text,
      inOrder: z.boolean(),
      quests: z.array(
        z.strictObject({
          id: z.uuid(),
          title: text,
          /** Players who completed the quest at least once. */
          done: count,
          /** Whether the quest takes part in its category's order (a flash quest or a live poll does not). */
          step: z.boolean(),
          skipped: z.boolean(),
        }),
      ),
    }),
  ),
});
export type QuestsAnalytics = z.infer<typeof questsAnalyticsSchema>;

/** `GET …/events/{id}/analytics/economy`: points earned and spent, unclaimed reservations, each reward's redemptions. */
export const economySchema = z.strictObject({
  earned: count,
  spent: count,
  unclaimed: count,
  rewards: z.array(
    z.strictObject({
      id: z.uuid(),
      name: text,
      price: count,
      redeemed: count,
      unclaimed: count,
      stockLeft: z.number().int(),
      removed: z.boolean(),
    }),
  ),
});
export type Economy = z.infer<typeof economySchema>;

/** The schema that checks each panel's answer. */
export const ANALYTICS_SCHEMAS = {
  participation: participationSchema,
  quests: questsAnalyticsSchema,
  economy: economySchema,
} as const satisfies Record<AnalyticsPanel, z.ZodType>;
