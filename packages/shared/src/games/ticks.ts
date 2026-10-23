/**
 * The real-time games' fixed tick (ADR-216): 30 a second from the moment the board shows. Inputs keep their time in
 * whole milliseconds; these two integer-only functions map between the two, the same on Node and on release Hermes
 * (every value stays far below 2^31, so `Math.floor` of the division is exact).
 */
export const TICKS_PER_SECOND = 30;

/** The tick a time in milliseconds falls in. */
export const tickAt = (t: number): number => Math.floor((t * 3) / 100);

/** The first millisecond of tick `k`: `tickAt(tickStartMs(k)) === k`. */
export const tickStartMs = (k: number): number => Math.floor((k * 100 + 2) / 3);

/** The tick a round of this length ends on. */
export const endTickOf = (timeLimitSeconds: number): number => timeLimitSeconds * TICKS_PER_SECOND;
