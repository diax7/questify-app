import { z } from "zod";

const bilingual = z.object({ ar: z.string(), en: z.string() });
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * Where a played event's rank stands (FR-709): `live` until the event ends, `pending` until results are revealed,
 * then `final` with the rank or `unranked` (no place: zero points, the team, or not active at confirmation).
 */
export const RANK_STATES = ["live", "pending", "final", "unranked"] as const;
export type RankState = (typeof RANK_STATES)[number];

/** One of the caller's memberships: a passport stamp when `played`, a history row either way (owner only). */
export const ownEventSchema = z.object({
  eventId: z.uuid(),
  name: bilingual,
  date: localDate,
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  timezone: z.string(),
  city: bilingual.nullable(),
  eventStatus: z.enum(["draft", "scheduled", "live", "ended", "archived"]),
  memberStatus: z.enum(["active", "left", "removed", "banned"]),
  score: z.number().int().nonnegative(),
  played: z.boolean(),
  rank: z.number().int().positive().nullable(),
  rankState: z.enum(RANK_STATES),
  /** Eligible for the public passport now: played, public, not a workplace event, ended or archived (ADR-276). */
  isPublic: z.boolean(),
});
export type OwnEvent = z.infer<typeof ownEventSchema>;
export const ownEventsSchema = z.object({
  events: z.array(ownEventSchema),
  nextCursor: z.string().nullable(),
});

/** A stamp another player sees: no event id, score, status or count of hidden stamps. */
export const publicStampSchema = z.object({
  name: bilingual,
  date: localDate,
  city: bilingual.nullable(),
  rank: z.number().int().positive().nullable(),
});
export type PublicStamp = z.infer<typeof publicStampSchema>;

/** The seeded city list the dashboard picks an event's city from (ADR-277). */
export const citySchema = z.object({ id: z.string().min(1).max(40), name: bilingual });
export type City = z.infer<typeof citySchema>;
export const citiesSchema = z.object({ cities: z.array(citySchema) });
