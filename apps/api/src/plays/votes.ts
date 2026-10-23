import type { PollChoices, PollResults } from "@questify/shared";
import type { PoolClient } from "pg";
import type { OrganizerContext } from "#src/organizers/store";
import {
  paidOf,
  run,
  type Bilingual,
  type Done,
  type Paid,
  type PaidRow,
  type PlayDeps,
} from "#src/plays/run";

export type VoteView = Readonly<{
  options: readonly Readonly<{ id: string; text: Bilingual }>[];
  /** The options this player chose (several only on a live poll), none before they vote. */
  mine: readonly string[];
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
      mine: read.value.filter((row) => row.mine).map((row) => row.option_id),
    },
  };
}

export type Voted = Paid;

/**
 * The player votes (FR-207, FR-240): one vote of one option, or several on a live poll that takes several, paid once
 * as a completion by `vote_quest` (migration 0052).
 */
export function castVote(
  deps: PlayDeps,
  request: Readonly<{
    playerId: string;
    questId: string;
    optionIds: readonly string[];
    idempotencyKey: string;
  }>,
): Promise<Done<Voted>> {
  return run(deps, { playerId: request.playerId }, async (client) => {
    const { rows } = await client.query<PaidRow>("SELECT * FROM vote_quest($1, $2, $3)", [
      request.questId,
      request.optionIds,
      request.idempotencyKey,
    ]);
    return paidOf(client, rows);
  });
}

export type VoteCounts = Readonly<{
  options: readonly Readonly<{ id: string; text: Bilingual; votes: number }>[];
  /** Every option's votes added up: with several choices, more than the voters. */
  total: number;
  /** The players who voted; each option's share is out of these (T-306). */
  voters: number;
}>;

/** Each option's votes, for the event's owners and editors (ADR-195). */
export function voteCounts(
  deps: PlayDeps,
  context: OrganizerContext,
  request: Readonly<{ eventId: string; questId: string }>,
): Promise<Done<VoteCounts>> {
  const seat = { organizerId: context.organizerId, staffUserId: context.staffUserId };
  return run(deps, seat, async (client) => {
    const { rows } = await client.query<OptionRow & { votes: string; voters: string }>(
      "SELECT * FROM quest_vote_counts($1, $2)",
      [request.eventId, request.questId],
    );
    const options = rows.map((row) => ({ ...optionOf(row), votes: Number(row.votes) }));
    return {
      options,
      total: options.reduce((sum, option) => sum + option.votes, 0),
      voters: Number(rows[0]?.voters ?? 0),
    };
  });
}

/** A live poll as the player's sheet shows it (FR-239 to FR-242). */
export type PollView = Readonly<{
  options: readonly Readonly<{ id: string; text: Bilingual }>[];
  choices: PollChoices;
  results: PollResults;
  closesAt: string;
  closed: boolean;
  mine: readonly string[];
  /** Each option's votes and the players who voted, once the policy shows them; null until then. */
  counts: Readonly<{
    options: readonly Readonly<{ id: string; votes: number }>[];
    voters: number;
  }> | null;
  /** Why the counts are not shown yet: the policy that holds them back, or null when they are shown. */
  resultsWhen: PollResults | null;
  serverNow: string;
}>;

type PollRow = {
  choices: PollChoices;
  results: PollResults;
  closes_at: Date;
  closed: boolean;
  mine: string[];
  server_now: Date;
};

/** Whether the poll's policy shows its counts to this player now; `poll_results` holds the same rule (PR403). */
export function resultsShown(
  poll: Readonly<{ results: PollResults; closed: boolean; mine: readonly string[] }>,
): boolean {
  switch (poll.results) {
    case "after_vote":
      return poll.mine.length > 0;
    case "at_close":
      return poll.closed;
    case "never":
      return false;
  }
}

async function pollCounts(client: PoolClient, questId: string) {
  const { rows } = await client.query<{ option_id: string; votes: string; voters: string }>(
    "SELECT * FROM poll_results($1)",
    [questId],
  );
  return {
    options: rows.map((row) => ({ id: row.option_id, votes: Number(row.votes) })),
    voters: Number(rows[0]?.voters ?? 0),
  };
}

/** A live poll the player may see, with the counts its policy allows (one call for the sheet); not found otherwise. */
export async function readPoll(
  deps: PlayDeps,
  playerId: string,
  questId: string,
): Promise<Done<PollView>> {
  const read = await run(deps, { playerId }, async (client) => {
    const poll = (await client.query<PollRow>("SELECT * FROM member_poll($1)", [questId])).rows[0];
    if (poll === undefined) {
      return undefined;
    }
    const { rows } = await client.query<OptionRow>("SELECT * FROM member_vote($1)", [questId]);
    const counts = resultsShown(poll) ? await pollCounts(client, questId) : null;
    return { poll, options: rows.map(optionOf), counts };
  });
  if (read.kind !== "done") {
    return read;
  }
  if (read.value === undefined) {
    return { kind: "not_found" };
  }
  const { poll, options, counts } = read.value;
  return {
    kind: "done",
    value: {
      options,
      choices: poll.choices,
      results: poll.results,
      closesAt: poll.closes_at.toISOString(),
      closed: poll.closed,
      mine: poll.mine,
      counts,
      resultsWhen: counts === null ? poll.results : null,
      serverNow: poll.server_now.toISOString(),
    },
  };
}
