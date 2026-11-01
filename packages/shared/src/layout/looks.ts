import { z } from "zod";
import type { ConfigIssue, Validation } from "#src/config/validate";

/**
 * How an event draws its ranking, its Quests tab and its Rewards shop (T-611, FR-1832, FR-1833). They are display choices,
 * stored in `event.config.layout.looks` beside the arrangement and the Home content (ADR-391, ADR-395, ADR-396). A look
 * changes how the same data is drawn; it never turns a feature on (the event's switches win) and never changes a point.
 */

export const RANKING_LAYOUTS = ["list", "podium"] as const;
export type RankingLayout = (typeof RANKING_LAYOUTS)[number];

/** `rank_only` sends the place and the player, never a score (the server leaves the scores out of the answer). */
export const RANKING_SCORES = ["shown", "rank_only"] as const;
export type RankingScores = (typeof RANKING_SCORES)[number];

/** The Quests tab and the Rewards shop: stacked cards, or two cards a row. */
export const CARD_LAYOUTS = ["list", "grid"] as const;
export type CardLayout = (typeof CARD_LAYOUTS)[number];

export type EventLooks = Readonly<{
  ranking: Readonly<{ layout: RankingLayout; scores: RankingScores }>;
  quests: CardLayout;
  shop: CardLayout;
}>;

/** What every event looked like before looks existed, so an event with none stored is drawn exactly as it was. */
export const DEFAULT_LOOKS: EventLooks = {
  ranking: { layout: "list", scores: "shown" },
  quests: "list",
  shop: "list",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The allowed value a stored one names, or the fallback for a value this build does not know (a newer server, F-282). */
function known<T extends string>(stored: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.find((candidate) => candidate === stored) ?? fallback;
}

/** A missing value is the old behaviour (scores shown); a value that is there but not understood hides them. */
const scoresOf = (stored: unknown): RankingScores =>
  stored === undefined || stored === "shown" ? "shown" : "rank_only";

/**
 * Reads the looks an event stored, whatever they hold. A missing look is the default; an unknown layout is the default
 * layout; a scores value that is present but not understood is "rank only", the side that gives nothing away.
 */
export function readLooks(stored: unknown): EventLooks {
  const source = isRecord(stored) ? stored : {};
  const ranking = isRecord(source["ranking"]) ? source["ranking"] : {};
  return {
    ranking: {
      layout: known(ranking["layout"], RANKING_LAYOUTS, DEFAULT_LOOKS.ranking.layout),
      scores: scoresOf(ranking["scores"]),
    },
    quests: known(source["quests"], CARD_LAYOUTS, DEFAULT_LOOKS.quests),
    shop: known(source["shop"], CARD_LAYOUTS, DEFAULT_LOOKS.shop),
  };
}

const request = z.strictObject({
  ranking: z.strictObject({ layout: z.enum(RANKING_LAYOUTS), scores: z.enum(RANKING_SCORES) }),
  quests: z.enum(CARD_LAYOUTS),
  shop: z.enum(CARD_LAYOUTS),
});

/** Checks the looks an organizer saves: every choice named, each one of the allowed values, nothing else. */
export function checkLooks(input: unknown): Validation<EventLooks> {
  const parsed = request.safeParse(input);
  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }
  const issues: ConfigIssue[] = parsed.error.issues.map((issue) => ({
    path: ["looks", ...issue.path.map(String)].join("."),
    message: issue.message,
  }));
  return { ok: false, issues };
}

/** Whether two sets of looks draw the same. */
export const sameLooks = (a: EventLooks, b: EventLooks): boolean =>
  a.ranking.layout === b.ranking.layout &&
  a.ranking.scores === b.ranking.scores &&
  a.quests === b.quests &&
  a.shop === b.shop;

/** Whether the ranking shows no scores: anything but an explicit "shown" counts as hiding them. */
export const scoresHidden = (looks: EventLooks): boolean => looks.ranking.scores !== "shown";
