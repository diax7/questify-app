import { describe, expect, it } from "vitest";
import { prng, shuffle } from "#src/games/prng";

const draws = (seed: number, count: number) => {
  const random = prng(seed);
  return Array.from({ length: count }, () => random.next());
};

describe("the mini-game generator", () => {
  it("draws the same golden sequence on every engine", () => {
    expect(draws(0, 4)).toEqual(GOLDEN_ZERO);
    expect(draws(1, 4)).toEqual(GOLDEN_ONE);
    expect(draws(-123456789, 4)).toEqual(GOLDEN_NEGATIVE);
  });

  it("starts a negative seed from its unsigned twin, as the database's signed integer requires", () => {
    expect(draws(-1, 3)).toEqual(draws(0xffffffff, 3));
    expect(draws(-123456789, 3)).toEqual(draws(-123456789 >>> 0, 3));
  });

  it("draws unsigned 32-bit integers", () => {
    for (const value of draws(42, 1000)) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(2 ** 32);
    }
  });

  it("draws below a bound, covering every value", () => {
    const random = prng(7);
    const hits = new Set<number>();
    for (let index = 0; index < 600; index += 1) {
      const value = random.below(6);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(6);
      hits.add(value);
    }
    expect(hits.size).toBe(6);
    expect(prng(7).below(1)).toBe(0);
    expect(prng(3).below(2 ** 32)).toBe(draws(3, 1)[0]);
  });

  it("rejects the draws that would bias a bound and takes the next one", () => {
    const bound = 2 ** 31 + 1;
    const limit = 2 ** 32 - (2 ** 32 % bound);
    const seed = findSeed(([first, second]) => first >= limit && second < limit);
    const [, second] = draws(seed, 2) as [number, number];
    expect(prng(seed).below(bound)).toBe(second % bound);
  });

  it("refuses a bound that is not an integer from 1 to 2^32", () => {
    for (const bound of [0, -1, 1.5, 2 ** 32 + 1, Number.NaN]) {
      expect(() => prng(1).below(bound)).toThrow(RangeError);
    }
  });

  it("shuffles every item into a seed's fixed order", () => {
    const items = [0, 1, 2, 3, 4, 5, 6, 7];
    const once = shuffle([...items], prng(9));
    expect(shuffle([...items], prng(9))).toEqual(once);
    expect([...once].sort((a, b) => a - b)).toEqual(items);
    expect(once).not.toEqual(items);
    expect(shuffle([], prng(1))).toEqual([]);
    expect(shuffle([5], prng(1))).toEqual([5]);
  });
});

function findSeed(fits: (pair: [number, number]) => boolean): number {
  for (let seed = 0; seed < 100; seed += 1) {
    if (fits(draws(seed, 2) as [number, number])) {
      return seed;
    }
  }
  throw new Error("no seed in range");
}

const GOLDEN_ZERO = [1144304738, 1416247, 958946056, 627933444];
const GOLDEN_ONE = [2693262067, 11749833, 2265367787, 4213581821];
const GOLDEN_NEGATIVE = [4009657726, 1248681970, 3716657570, 187934601];
