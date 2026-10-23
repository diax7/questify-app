import type { Goal } from "#src/event/home-api.ts";

/**
 * The line under the goal's name: sold out first, then "you have enough" once nothing is left, else what is left.
 * Null once the event has ended with points still to earn: no more can be earned, so nothing to count down.
 */
export function goalMessage(
  goal: Goal,
  ended: boolean,
): "goal.soldOut" | "goal.ready" | "goal.left" | null {
  if (goal.soldOut) {
    return "goal.soldOut";
  }
  if (goal.left <= 0) {
    return "goal.ready";
  }
  return ended ? null : "goal.left";
}
