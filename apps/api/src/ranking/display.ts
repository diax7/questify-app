import type { Equipment, NameDisplay } from "@questify/shared";
import type { RankingView } from "#src/ranking/ranking";

/** A ranking row without its score: the place and the public profile details only (FR-120, FR-1832). */
type PlaceRow = Readonly<{
  rank: number;
  username: string | null;
  fullName: string | null;
  avatar: string | null;
  equipment: Equipment | null;
  hidden: boolean;
  isMe: boolean;
}>;

/**
 * What `GET /v1/events/:id/ranking` answers. `scores` says whether the scores are in it: with the event on "rank only"
 * (FR-1832) the answer holds places and players and no score at all, so no client can show or leak one.
 */
export type PlayerRanking =
  | (RankingView & Readonly<{ scores: true }>)
  | Readonly<{
      rows: readonly PlaceRow[];
      me: Omit<NonNullable<RankingView["me"]>, "score"> | null;
      total: number;
      today: boolean;
      names: NameDisplay;
      scores: false;
    }>;

/**
 * The ranking as a player may read it. The scores are taken out here, on the server, built field by field so a field
 * added to a row later is not sent by accident.
 */
export function playerRanking(view: RankingView, hideScores: boolean): PlayerRanking {
  if (!hideScores) {
    return { ...view, scores: true };
  }
  return {
    rows: view.rows.map((row) => ({
      rank: row.rank,
      username: row.username,
      fullName: row.fullName,
      avatar: row.avatar,
      equipment: row.equipment,
      hidden: row.hidden,
      isMe: row.isMe,
    })),
    me:
      view.me === null
        ? null
        : {
            rank: view.me.rank,
            username: view.me.username,
            fullName: view.me.fullName,
            avatar: view.me.avatar,
            equipment: view.me.equipment,
          },
    total: view.total,
    today: view.today,
    names: view.names,
    scores: false,
  };
}
