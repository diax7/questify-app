import { levelReached, type LevelUp } from "#src/completions/complete";
import type { OrganizerContext } from "#src/organizers/store";
import { run, type Bilingual, type Done, type PlayDeps } from "#src/plays/run";

export type VoteView = Readonly<{
  options: readonly Readonly<{ id: string; text: Bilingual }>[];
  /** The option this player chose, or null before they vote. */
  mine: string | null;
}>;

type OptionRow = { option_id: string; text_ar: string | null; text_en: string | null };

const optionOf = (row: OptionRow) => ({
  id: row.option_id,
  text: { ar: row.text_ar, en: row.text_en },
});

/** A vote quest's options and the player's own choice (FR-207); not found unless they may play it. */
export async function readVote(
  deps: PlayDeps,
  playerId: string,
  questId: string,
): Promise<Done<VoteView>> {
  const read = await run(deps, { playerId }, async (client) => {
    const { rows } = await client.query<OptionRow & { mine: boolean }>(
      "SELECT * FROM member_vote($1)",
      [questId],
    );
    return rows;
  });
  if (read.kind !== "done") {
    return read;
  }
  if (read.value.length === 0) {
    return { kind: "not_found" };
  }
  return {
    kind: "done",
    value: {
      options: read.value.map(optionOf),
      mine: read.value.find((row) => row.mine)?.option_id ?? null,
    },
  };
}

export type Voted = Readonly<{
  completionId: string;
  points: number;
  score: number;
  balance: number;
  replayed: boolean;
  levelUp: LevelUp | null;
}>;

type VotedRow = {
  completion_id: string;
  points: string;
  score: string;
  balance: string;
  replayed: boolean;
};

/** The player votes (FR-207): one vote, paid as a completion by `vote_quest` (migration 0041). */
export function castVote(
  deps: PlayDeps,
  request: Readonly<{
    playerId: string;
    questId: string;
    optionId: string;
    idempotencyKey: string;
  }>,
): Promise<Done<Voted>> {
  return run(deps, { playerId: request.playerId }, async (client) => {
    const { rows } = await client.query<VotedRow>("SELECT * FROM vote_quest($1, $2, $3)", [
      request.questId,
      request.optionId,
      request.idempotencyKey,
    ]);
    const row = rows[0] as VotedRow;
    return {
      completionId: row.completion_id,
      points: Number(row.points),
      score: Number(row.score),
      balance: Number(row.balance),
      replayed: row.replayed,
      levelUp: await levelReached(client, row.completion_id),
    };
  });
}

export type VoteCounts = Readonly<{
  options: readonly Readonly<{ id: string; text: Bilingual; votes: number }>[];
  total: number;
}>;

/** Each option's votes, for the event's owners and editors (ADR-195). */
export function voteCounts(
  deps: PlayDeps,
  context: OrganizerContext,
  request: Readonly<{ eventId: string; questId: string }>,
): Promise<Done<VoteCounts>> {
  const seat = { organizerId: context.organizerId, staffUserId: context.staffUserId };
  return run(deps, seat, async (client) => {
    const { rows } = await client.query<OptionRow & { votes: string }>(
      "SELECT * FROM quest_vote_counts($1, $2)",
      [request.eventId, request.questId],
    );
    const options = rows.map((row) => ({ ...optionOf(row), votes: Number(row.votes) }));
    return { options, total: options.reduce((sum, option) => sum + option.votes, 0) };
  });
}
