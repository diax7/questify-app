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
 * The shortest second, first and third step: the rank digit in the `label` text (an 18-point line) plus the step's 4-point
 * lower edge, each one apart so first still stands above second and second above third at the smallest podium.
 */
const STEP_FLOORS = [24, 26, 22] as const;
/** A step shorter than this cannot hold the `title` digit (a 32-point line and the 4-point edge): the podium uses `label`. */
const TITLE_STEP_MIN = 36;

export type PodiumMetrics = Readonly<{
  face: number;
  steps: readonly [number, number, number];
  /** The text of the rank digit on the steps, one for all three so they match: `label` once the shortest step is short. */
  rankText: "title" | "label";
}>;

/**
 * The parts of a podium of this height: the face's size, the height of the second, first and third step, and the text of
 * the rank digit on them. The tallest place (face, name, score if shown, step) never goes above the podium's height; the
 * face gives way before the steps drop under their floor, so a small podium keeps a digit that fits; with no score line
 * the steps are taller.
 */
export function podiumMetrics(height: number, withScore: boolean): PodiumMetrics {
  const [secondFloor, firstFloor, thirdFloor] = STEP_FLOORS;
  const lines = NAME_LINE + (withScore ? SCORE_LINE : 0) + FACE_PADDING;
  const face = clamp(Math.min(Math.round(height * 0.28), height - lines - firstFloor), 24, 44);
  const first = Math.max(firstFloor, height - face - lines);
  const steps: PodiumMetrics["steps"] = [
    Math.max(secondFloor, Math.round(first * 0.72)),
    first,
    Math.max(thirdFloor, Math.round(first * 0.52)),
  ];
  return { face, steps, rankText: steps[2] < TITLE_STEP_MIN ? "label" : "title" };
}
