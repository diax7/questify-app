import type { JoinOutcome } from "#src/join/join-api.ts";

/** A join that went through. */
export type Joined = Extract<JoinOutcome, { kind: "joined" }>;

/** Where a join that went through leaves the player; each is also the key of the text the join card shows. */
export type JoinedResult = "active" | "pending" | "waitlisted" | "already";

/** What a join that went through says: the waiting list and a request still waiting come before "already in". */
export const joinedResult = (outcome: Joined): JoinedResult =>
  outcome.waitlisted
    ? "waitlisted"
    : outcome.alreadyMember && outcome.status === "active"
      ? "already"
      : outcome.status;

/**
 * Whether the player is in the event now, and so may be shown the intro on the way in: joined, or already in. A request
 * waiting for approval and a place on the waiting list are not (the join card and the invitation both ask this).
 */
export const isInEvent = (result: string | undefined): boolean =>
  result === "active" || result === "already";
