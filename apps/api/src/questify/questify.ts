import {
  decodeCursor,
  encodeCursor,
  type Achievement,
  type City,
  type OwnEvent,
  type QuestifyQuests,
  type QuestifySync,
  type RankState,
} from "@questify/shared";
import type { PoolClient } from "pg";
import { z } from "zod";
import { invalidRequest, unauthenticated } from "#src/auth/http-errors";

/**
 * Runs the sync evaluator (ADR-274, ADR-278): the tiers earned, the Questify quests paid and the highest level reached
 * by this call; empty on a replay.
 */
export async function syncQuestify(client: PoolClient): Promise<QuestifySync> {
  try {
    const { rows } = await client.query<{ result: QuestifySync }>(
      "SELECT questify_sync() AS result",
    );
    // Stryker disable next-line all: questify_sync always answers an object or raises
    return rows[0]?.result ?? { achievements: [], quests: [], levelUp: null };
  } catch (error) {
    if ((error as { code?: string }).code === "PI401") throw unauthenticated();
    throw error;
  }
}

/** The caller's five achievements with live progress; an inactive caller has none (401). */
export async function readAchievements(client: PoolClient): Promise<Achievement[]> {
  const { rows } = await client.query<{ list: Achievement[] | null }>(
    "SELECT own_achievements() AS list",
  );
  const list = rows[0]?.list;
  if (list === null || list === undefined) throw unauthenticated();
  return list;
}

/** The caller's Questify quests: always-on, then each campaign running now (T-403b); an inactive caller has none. */
export async function readQuestifyQuests(client: PoolClient): Promise<QuestifyQuests> {
  const { rows } = await client.query<{ list: QuestifyQuests | null }>(
    "SELECT own_questify_quests() AS list",
  );
  const list = rows[0]?.list;
  if (list === null || list === undefined) throw unauthenticated();
  return list;
}

/** The seeded cities, in their order (ADR-277). */
export async function readCities(client: PoolClient): Promise<City[]> {
  const { rows } = await client.query<{ list: City[] }>("SELECT city_list() AS list");
  // Stryker disable next-line all: city_list always answers an array
  return rows[0]?.list ?? [];
}

const positionSchema = z.strictObject({ at: z.iso.datetime({ offset: true }), id: z.uuid() });

type EventRow = {
  event_id: string;
  name: OwnEvent["name"];
  local_date: string;
  starts_at: Date | null;
  ends_at: Date | null;
  timezone: string;
  city: OwnEvent["city"];
  event_status: OwnEvent["eventStatus"];
  member_status: OwnEvent["memberStatus"];
  score: string;
  played: boolean;
  rank: number | null;
  rank_state: RankState;
  is_public: boolean;
  sort_at: string;
};

const toEvent = (row: EventRow): OwnEvent => ({
  eventId: row.event_id,
  name: row.name,
  date: row.local_date,
  startsAt: row.starts_at?.toISOString() ?? null,
  endsAt: row.ends_at?.toISOString() ?? null,
  timezone: row.timezone,
  city: row.city,
  eventStatus: row.event_status,
  memberStatus: row.member_status,
  score: Number(row.score),
  played: row.played,
  rank: row.rank,
  rankState: row.rank_state,
  isPublic: row.is_public,
});

function positionOf(cursor: string | undefined): z.infer<typeof positionSchema> | undefined {
  if (cursor === undefined) return undefined;
  let decoded: unknown;
  try {
    decoded = decodeCursor(cursor);
  } catch {
    throw invalidRequest();
  }
  const result = positionSchema.safeParse(decoded);
  if (!result.success) throw invalidRequest();
  return result.data;
}

/**
 * The caller's memberships, newest event start first (cut 1): `played` keeps the Event Passport's played events, else
 * the whole history. The cursor carries the start time with its microseconds, so equal starts page by event id.
 */
export async function readEvents(
  client: PoolClient,
  query: Readonly<{ played: boolean; cursor?: string | undefined; limit: number }>,
): Promise<{ events: OwnEvent[]; nextCursor: string | null }> {
  const before = positionOf(query.cursor);
  const { rows } = await client.query<EventRow>(
    `SELECT event_id, name, local_date, starts_at, ends_at, timezone, city, event_status, member_status, score, played,
            rank, rank_state, is_public, to_char(sort_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_at
     FROM own_events($1, $2, $3, $4)`,
    [query.played, before?.at ?? null, before?.id ?? null, query.limit + 1],
  );
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    events: page.map(toEvent),
    nextCursor:
      rows.length > query.limit && last !== undefined
        ? encodeCursor({ at: last.sort_at, id: last.event_id })
        : null,
  };
}
