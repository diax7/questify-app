/**
 * The mini-games' random generator (T-305, ADR-212): mulberry32 on 32-bit integers only (`Math.imul`, `>>> 0`), so
 * Node on the server and Hermes in the release app draw the same sequence from the same seed. No floats, no
 * `Math.random`. The database's seed is a signed `integer`; the generator starts from `seed >>> 0`.
 */
export type Prng = {
  /** The next 32-bit unsigned integer. */
  next(): number;
  /** An integer in `[0, bound)`, without modulo bias; `bound` is an integer from 1 to 2^32. */
  below(bound: number): number;
};

const RANGE = 0x1_0000_0000;

export function prng(seed: number): Prng {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return (mixed ^ (mixed >>> 14)) >>> 0;
  };
  const below = (bound: number): number => {
    if (!Number.isInteger(bound) || bound < 1 || bound > RANGE) {
      throw new RangeError(`prng.below needs an integer from 1 to 2^32, got ${bound}`);
    }
    const limit = RANGE - (RANGE % bound);
    let drawn = next();
    while (drawn >= limit) {
      drawn = next();
    }
    return drawn % bound;
  };
  return { next, below };
}

/** Shuffles `items` in place with Fisher–Yates on the generator. */
export function shuffle<T>(items: T[], random: Prng): T[] {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const other = random.below(index + 1);
    const held = items[index] as T;
    items[index] = items[other] as T;
    items[other] = held;
  }
  return items;
}
