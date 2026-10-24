import type { CommunityLock } from "#src/community/lock-note";

type Text = Readonly<{ ar: string | null; en: string | null }>;

/** A reward of the shop as the goal reads it (`shop_rewards`, in shop order). */
export type GoalReward = Readonly<{
  id: string;
  name: Text;
  price: number;
  stockLeft: number;
  perPlayerLimit: number | null;
  heldByMe: number;
  closesAt: Date | null;
  /** The community goal locking it (T-306c), or null. */
  communityLock: CommunityLock | null;
}>;

/** Home's goal (FR-803): the pinned reward, or the next one the player can reach (FR-1616). */
export type Goal = Readonly<{
  rewardId: string;
  name: Text;
  price: number;
  /** Points still to earn; 0 means the player can redeem it now. */
  left: number;
  pinned: boolean;
  soldOut: boolean;
  /** A pinned reward a community goal still locks (CTO 8): the card shows this note instead of the points to go. */
  communityLock: CommunityLock | null;
}>;

const goalOf = (reward: GoalReward, balance: number, pinned: boolean): Goal => ({
  rewardId: reward.id,
  name: reward.name,
  price: reward.price,
  left: Math.max(reward.price - balance, 0),
  pinned,
  soldOut: reward.stockLeft <= 0,
  communityLock: reward.communityLock,
});

/** Still open to this player: not past its closing time and not at their limit (stock aside). */
const stillOpen = (reward: GoalReward, now: Date): boolean =>
  (reward.closesAt === null || reward.closesAt > now) &&
  (reward.perPlayerLimit === null || reward.heldByMe < reward.perPlayerLimit);

/** Still within reach later: in stock, still open to this player, and not locked by a community goal (T-306c). */
const reachable = (reward: GoalReward, now: Date): boolean =>
  reward.stockLeft > 0 && stillOpen(reward, now) && reward.communityLock === null;

/**
 * The goal (FR-803, FR-1616, ADR-161): the pinned reward while it is in the shop, not closed and under the player's
 * limit, whatever its stock (a sold-out pin says so) or community lock (it carries the lock's note); otherwise the
 * cheapest reachable reward the player cannot yet afford, never a community-locked one, the first in shop order on a
 * tie; otherwise none.
 */
export function pickGoal(
  rewards: readonly GoalReward[],
  pinnedId: string | null,
  balance: number,
  now: Date,
): Goal | null {
  const pinned = rewards.find((reward) => reward.id === pinnedId && stillOpen(reward, now));
  if (pinned !== undefined) {
    return goalOf(pinned, balance, true);
  }
  const next = rewards
    .filter((reward) => reward.price > balance && reachable(reward, now))
    .reduce<GoalReward | undefined>(
      (best, reward) => (best === undefined || reward.price < best.price ? reward : best),
      undefined,
    );
  return next === undefined ? null : goalOf(next, balance, false);
}
