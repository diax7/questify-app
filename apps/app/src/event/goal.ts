import type { Goal } from "#src/event/home-api.ts";

/** The line under the goal's name: sold out first, then "redeem it now" once nothing is left, else what is left. */
export function goalMessage(goal: Goal): "goal.soldOut" | "goal.ready" | "goal.left" {
  if (goal.soldOut) {
    return "goal.soldOut";
  }
  return goal.left <= 0 ? "goal.ready" : "goal.left";
}
