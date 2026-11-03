import { z } from "zod";

/**
 * A sponsor's totals (T-608, FR-1306, FR-1626, ADR-393): visits, completions and redemptions of the items tagged to one
 * sponsor, counts only. A sponsor sees no player, so a count of one to four players is not shown (the floor), the same
 * rule in the dashboard's sponsor view and in the sponsor's spreadsheet.
 */

/** A count of players below this, other than none, is left out of anything made for a sponsor. */
export const MIN_GROUP_SIZE = 5;

const count = z.number().int().min(0);
const text = z.strictObject({ ar: z.string().nullable(), en: z.string().nullable() });
const named = { id: z.uuid(), name: text } as const;

/** What the database door answers: exact counts, which never leave the API. */
export const sponsorRawSchema = z.strictObject({
  sponsor: z.strictObject(named),
  visits: count,
  completions: count,
  redemptions: count,
  quests: z.array(z.strictObject({ id: z.uuid(), title: text, players: count })),
  categories: z.array(z.strictObject({ ...named, players: count })),
  rewards: z.array(z.strictObject({ ...named, redeemed: count })),
  /** The sponsor's active or stopped souvenirs and how many players earned each (T-507c). */
  souvenirs: z.array(z.strictObject({ ...named, earned: count })),
});
export type SponsorRaw = z.infer<typeof sponsorRawSchema>;

/** A count that may be left out: null stands for "fewer than {@link MIN_GROUP_SIZE}". */
const shown = count.nullable();

/** `GET …/events/{id}/analytics/sponsors/{sponsorId}`: the totals as the sponsor may see them. */
export const sponsorTotalsSchema = z.strictObject({
  sponsor: z.strictObject(named),
  visits: shown,
  completions: shown,
  redemptions: shown,
  quests: z.array(z.strictObject({ id: z.uuid(), title: text, players: shown })),
  categories: z.array(z.strictObject({ ...named, players: shown })),
  rewards: z.array(z.strictObject({ ...named, redeemed: shown })),
  souvenirs: z.array(z.strictObject({ ...named, earned: shown })),
});
export type SponsorTotals = z.infer<typeof sponsorTotalsSchema>;

/** A count as a sponsor may see it: none stays none, one to four is left out. */
export function groupCount(value: number): number | null {
  return value > 0 && value < MIN_GROUP_SIZE ? null : value;
}

/**
 * Counts that add up to a total shown beside them. When exactly one is left out, the total minus the rest would give
 * it back, so the smallest count still shown is left out with it.
 */
export function groupParts(values: readonly number[]): (number | null)[] {
  const parts = values.map(groupCount);
  const hidden = parts.filter((part) => part === null).length;
  if (hidden !== 1) return parts;
  const candidates = parts.filter((part): part is number => part !== null && part > 0);
  if (candidates.length === 0) return parts;
  const smallest = Math.min(...candidates);
  return parts.map((part) => (part === smallest ? null : part));
}

/** The totals with every count a sponsor may not see left out. */
export function sponsorTotals(raw: SponsorRaw): SponsorTotals {
  const redeemed = groupParts(raw.rewards.map((reward) => reward.redeemed));
  return {
    sponsor: raw.sponsor,
    visits: groupCount(raw.visits),
    completions: groupCount(raw.completions),
    redemptions: groupCount(raw.redemptions),
    quests: raw.quests.map((quest) => ({ ...quest, players: groupCount(quest.players) })),
    categories: raw.categories.map((category) => ({
      ...category,
      players: groupCount(category.players),
    })),
    rewards: raw.rewards.map((reward, index) => ({ ...reward, redeemed: redeemed[index] ?? null })),
    souvenirs: raw.souvenirs.map((souvenir) => ({
      ...souvenir,
      earned: groupCount(souvenir.earned),
    })),
  };
}
