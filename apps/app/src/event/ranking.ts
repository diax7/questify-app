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

/** The podium's height bounds in points: below the lower the faces are too small to read, above the upper it wastes the screen. */
export const PODIUM_MIN = 96;
export const PODIUM_MAX = 168;
/** Without any row below it the podium may take the whole space, up to this. */
export const PODIUM_ALONE_MAX = 220;
/** The share of the space the podium takes while rows are listed below it. */
const PODIUM_SHARE = 0.3;

const clamp = (value: number, low: number, high: number): number =>
  Math.max(low, Math.min(high, value));

/**
 * How the podium layout divides the measured space (FR-1832): the podium's height, then one height for every row below it,
 * so the podium, the rows and their gaps always fit the screen with no scrolling. The rows shrink as on the list.
 */
export function podiumFit(
  available: number,
  rowSlots: number,
  gap: number,
): Readonly<{ podium: number; row: number }> {
  if (rowSlots <= 0) {
    return { podium: clamp(Math.floor(available), 0, PODIUM_ALONE_MAX), row: 0 };
  }
  const podium = clamp(Math.round(available * PODIUM_SHARE), PODIUM_MIN, PODIUM_MAX);
  return { podium, row: rowHeight(available - podium - gap, rowSlots, gap) };
}

/** The podium's three places in the order they stand: second, first, third (a missing place is undefined). */
export function podiumPlaces(top: readonly ShownRow[]): readonly (ShownRow | undefined)[] {
  return [top[1], top[0], top[2]];
}

const NAME_LINE = 18;
const SCORE_LINE = 18;
const FACE_PADDING = 8;

/**
 * The parts of a podium of this height: the face's size, and the height of the second, first and third step. The tallest
 * place (face, name, score if shown, step) never goes above the podium's height; with no score line the steps are taller.
 */
export function podiumMetrics(
  height: number,
  withScore: boolean,
): Readonly<{ face: number; steps: readonly [number, number, number] }> {
  const face = clamp(Math.round(height * 0.28), 24, 44);
  const above = face + NAME_LINE + (withScore ? SCORE_LINE : 0) + FACE_PADDING;
  const first = Math.max(20, height - above);
  return { face, steps: [Math.round(first * 0.72), first, Math.round(first * 0.52)] };
}
