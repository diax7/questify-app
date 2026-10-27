import { z } from "zod";
import { itemSchema } from "#src/players/items";

const bilingual = z.object({ ar: z.string(), en: z.string() });
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * The recap's rank (ADR-339, the passport's rule ADR-276): `final` with the place once results are revealed,
 * `pending` until then, `unranked` when the member has no place.
 */
export const recapRankSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("final"), value: z.number().int().positive() }),
  z.object({ state: z.literal("pending"), value: z.null() }),
  z.object({ state: z.literal("unranked"), value: z.null() }),
]);
export type RecapRank = z.infer<typeof recapRankSchema>;

/**
 * `GET /v1/events/{id}/recap` (T-410, FR-752): only what the player already sees. No username, character, score,
 * balance, player count, join code, link or id other than the event's own. The app shows up to 3 souvenirs and "+N".
 */
export const eventRecapSchema = z.object({
  event: z.object({ id: z.uuid(), name: bilingual, date: localDate, city: bilingual.nullable() }),
  rank: recapRankSchema,
  /** Distinct quests completed at least once, removals excluded; 0 shows "Thanks for joining". */
  questsDone: z.number().int().nonnegative(),
  /** The souvenirs this event gave the player, in earned order; empty leaves that part out. */
  souvenirs: z.array(itemSchema),
});
export type EventRecap = z.infer<typeof eventRecapSchema>;
