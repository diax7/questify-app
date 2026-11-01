import type { PlayerPlace, PlayerResults } from "#src/results/results";

/** A revealed place as a player reads it on an event set to "rank only": the place, the player and the prize, no score. */
export type PlaceWithoutScore = Omit<PlayerPlace, "score">;

/** The revealed results with every score left out; the answer says so in `scores: false` (FR-1832). */
export type PlayerResultsWithoutScores = Omit<PlayerResults, "places"> &
  Readonly<{ places: readonly PlaceWithoutScore[]; scores: false }>;

/**
 * The revealed results as a player may read them. On an event set to "rank only" the final scores are taken out here, on
 * the server, field by field; otherwise the answer is unchanged apart from `scores: true`.
 */
export function playerResultsView(
  results: PlayerResults,
  hideScores: boolean,
): (PlayerResults & Readonly<{ scores: true }>) | PlayerResultsWithoutScores {
  if (!hideScores) {
    return { ...results, scores: true };
  }
  return {
    revealed: results.revealed,
    names: results.names,
    places: results.places.map((place) => ({
      rank: place.rank,
      player: place.player,
      prize: place.prize,
      mine: place.mine,
    })),
    me: results.me,
    scores: false,
  };
}
