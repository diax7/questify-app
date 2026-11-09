type PollSeat = Readonly<{ closed: boolean; mine: readonly string[] }>;

/** Whether the poll is closed (by the server or by the countdown reaching zero) and whether the player may still vote. */
export function pollPhase(
  view: PollSeat,
  left: number | null,
): Readonly<{ closed: boolean; voting: boolean }> {
  const closed = view.closed || left === 0;
  return { closed, voting: view.mine.length === 0 && !closed };
}

export type LastVote = Readonly<{ key: string; options: string }>;

/** The idempotency key for these choices: the last one again for the same choices, a fresh one otherwise. */
export function voteKey(
  last: LastVote | undefined,
  chosen: readonly string[],
  fresh: () => string,
): LastVote {
  const options = [...chosen].sort().join(",");
  return { key: last?.options === options ? last.key : fresh(), options };
}
