import type { RankRow, Ranking } from "#src/event/home-api.ts";

export type ShownRow = RankRow & Readonly<{ key: string }>;

/**
 * What the ranking shows (FR-601, FR-602): the top rows as given (up to 10, none invented), then the player's own row
 * as an 11th row only when they are ranked but not among them. A player without points gets no row.
 */
export function rankingRows(ranking: Ranking): readonly ShownRow[] {
  const top = ranking.rows.map((row) => ({ ...row, key: `${row.rank}:${row.username}` }));
  const me = ranking.me;
  if (me === null || ranking.rows.some((row) => row.isMe)) {
    return top;
  }
  return [...top, { ...me, isMe: true, key: `${me.rank}:${me.username}` }];
}

/** The tallest a row grows on a big phone; rows never scroll, so they shrink instead (FR-603). */
export const MAX_ROW_HEIGHT = 56;

/**
 * A row's height so that every slot fits the measured list with its gaps: `slots × height + gaps ≤ available`. No
 * lower bound, so the 11th row (the player's own) is never pushed off the screen.
 */
export function rowHeight(available: number, slots: number, gap: number): number {
  if (slots <= 0) {
    return 0;
  }
  const room = available - gap * (slots - 1);
  return Math.max(0, Math.min(MAX_ROW_HEIGHT, Math.floor(room / slots)));
}
