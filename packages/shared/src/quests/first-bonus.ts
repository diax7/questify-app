/**
 * The first-N bonus on a quest (T-313, FR-1840, ADR-262): X extra points for the first N players who complete it. The
 * builder, the API and the database (migration 0062's CHECKs) hold the same limits.
 */
export const FIRST_BONUS_LIMITS = {
  points: { min: 1, max: 100_000 },
  slots: { min: 1, max: 1000 },
} as const;

/**
 * What the quest save may say about the bonus: set it (points and slots), stop it (N becomes the number given, so
 * "bonuses left" reads 0), or switch it off (null). Left out, the bonus stays as it is.
 */
export type FirstBonusInput =
  | Readonly<{ points: number; slots: number }>
  | Readonly<{ stop: true }>
  | null;

const within = (value: number, range: Readonly<{ min: number; max: number }>): boolean =>
  Number.isInteger(value) && value >= range.min && value <= range.max;

/** The field a bonus input gets wrong (points first), or null when it is acceptable. */
export function firstBonusProblem(input: FirstBonusInput): "points" | "slots" | null {
  if (input === null || "stop" in input) {
    return null;
  }
  if (!within(input.points, FIRST_BONUS_LIMITS.points)) {
    return "points";
  }
  return within(input.slots, FIRST_BONUS_LIMITS.slots) ? null : "slots";
}
