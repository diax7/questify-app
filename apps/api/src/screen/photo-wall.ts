import type { Pool, PoolClient } from "pg";
import {
  bigScreenOff,
  invalidPhotoWall,
  notEnrolled,
  notFound,
  photoOnly,
} from "#src/auth/http-errors";
import { withConnection } from "#src/db/connection";
import { withRequestContext, type RequestContext } from "#src/db/context";
import type { HttpError } from "#src/http-error";
import type { ObjectStore } from "#src/storage/client";
import { stableWallUrl } from "#src/storage/signed";

/** The photo wall's dependencies: the pool, and the photo bucket when this server has one (none: an empty wall). */
export type PhotoWallDeps = Readonly<{ pool: Pool; storage?: ObjectStore | undefined }>;

/** One photo as a reader gets it: a stable short URL (plan section 7, M2), never the bucket key. */
export type WallPhoto = Readonly<{ mediaId: string; url: string; expiresAt: string }>;

type PgError = Readonly<{ code?: string; detail?: string }>;

/** Migration 0195's refusals as HTTP answers; undefined for anything else. */
const REFUSALS: Readonly<Record<string, (pg: PgError) => HttpError>> = {
  AN404: () => notFound(),
  PW404: () => notFound(),
  AM403: () => notEnrolled(),
  BS403: () => bigScreenOff(),
  PW422: (pg) =>
    pg.detail === "not_photo" ? photoOnly() : invalidPhotoWall({ field: pg.detail ?? "picks" }),
};

async function run<T>(
  pool: Pool,
  context: RequestContext,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  try {
    return await withConnection(pool, (client) =>
      withRequestContext(client, context, () => work(client)),
    );
  } catch (error) {
    const pg = error as PgError;
    const refusal = pg.code === undefined ? undefined : REFUSALS[pg.code];
    throw refusal === undefined ? error : refusal(pg);
  }
}

/**
 * Signs each key a seat-checked reader returned and drops the key: a photo that cannot be signed (or every photo, with
 * no bucket) is left out, so the screen and the app show only what they can load.
 */
export async function signWall<T extends Readonly<{ key: string }>>(
  storage: ObjectStore | undefined,
  rows: readonly T[],
  now: () => number = Date.now,
): Promise<Array<Omit<T, "key"> & { url: string; expiresAt: string }>> {
  const signed = await Promise.all(
    rows.map(async (row) => {
      const read = await stableWallUrl(storage, row.key, now);
      if (read === null) return null;
      const { key: _key, ...rest } = row;
      return { ...rest, url: read.url, expiresAt: read.expiresAt.toISOString() };
    }),
  );
  return signed.filter((row) => row !== null);
}

/** The screen's photo scene after the database read: each photo signed, no key left (plan section 4). */
export async function signedScene(
  storage: ObjectStore | undefined,
  answer: Readonly<Record<string, unknown>>,
  now: () => number = Date.now,
): Promise<Readonly<Record<string, unknown>>> {
  const photos = answer["photos"];
  if (!Array.isArray(photos)) return answer;
  return {
    ...answer,
    photos: await signWall(storage, photos as { mediaId: string; key: string }[], now),
  };
}

/** A photo the app's wall shows: its URL and its owner's username (for Block), never a full name (M5). */
export type MemberWallPhoto = WallPhoto & Readonly<{ username: string | null }>;

/**
 * The event's photo wall for an active member while it runs (FR-637): the picked, eligible photos without the players
 * the reader blocked. With no bucket the list is empty.
 *
 * @throws HttpError not_found while the wall is off, not_enrolled for anyone not an active member.
 */
export function memberWall(
  deps: PhotoWallDeps,
  playerId: string,
  eventId: string,
): Promise<readonly MemberWallPhoto[]> {
  return run(deps.pool, { playerId }, async (client) => {
    const { rows } = await client.query<{
      media_id: string;
      photo_key: string;
      username: string | null;
    }>("SELECT * FROM member_photo_wall($1)", [eventId]);
    return signWall(
      deps.storage,
      rows.map((row) => ({ mediaId: row.media_id, key: row.photo_key, username: row.username })),
    );
  });
}

/** Whether the wall runs for the member now (Home and the send form ask); always false with no bucket. */
export async function wallOn(
  deps: PhotoWallDeps,
  client: PoolClient,
  eventId: string,
): Promise<boolean> {
  if (deps.storage === undefined) return false;
  const { rows } = await client.query<{ on: boolean }>("SELECT member_photo_wall_on($1) AS on", [
    eventId,
  ]);
  return rows[0]?.on === true;
}

/** Whether the wall runs, in its own transaction, for Home (T-504b): no read at all on a server without a bucket. */
export function memberWallOn(
  pool: Pool,
  photos: boolean,
  playerId: string,
  eventId: string,
): Promise<boolean> {
  if (!photos) return Promise.resolve(false);
  return withConnection(pool, (client) =>
    withRequestContext(client, { playerId }, async () => {
      const { rows } = await client.query<{ on: boolean }>(
        "SELECT member_photo_wall_on($1) AS on",
        [eventId],
      );
      return rows[0]?.on === true;
    }),
  );
}

/**
 * The player allows or withdraws one of their own photo submissions on screen (M6); off takes it off the wall at once.
 *
 * @throws HttpError not_found for anything but the caller's own submission of this event, photo_only for a text one.
 */
export function setOnScreen(
  deps: PhotoWallDeps,
  playerId: string,
  change: Readonly<{ eventId: string; submissionId: string; onScreen: boolean }>,
): Promise<boolean> {
  return run(deps.pool, { playerId }, async (client) => {
    const { rows } = await client.query<{ r: boolean }>(
      "SELECT own_photo_on_screen($1, $2, $3) AS r",
      [change.eventId, change.submissionId, change.onScreen],
    );
    return rows[0]?.r === true;
  });
}

/** A photo the team sees in the picker: its quest's title and its place on the wall when picked. */
export type TeamWallPhoto = Readonly<{
  submissionId: string;
  url: string;
  expiresAt: string;
  questTitle: Readonly<{ ar: string | null; en: string | null }>;
  position: number | null;
}>;

type TeamRow = {
  submission_id: string;
  photo_key: string;
  quest_title_ar: string | null;
  quest_title_en: string | null;
  wall_position: number | null;
};

const teamRows = (storage: ObjectStore | undefined, rows: readonly TeamRow[]) =>
  signWall(
    storage,
    rows.map((row) => ({
      submissionId: row.submission_id,
      key: row.photo_key,
      questTitle: { ar: row.quest_title_ar, en: row.quest_title_en },
      position: row.wall_position,
    })),
  );

export type TeamWall = Readonly<{
  picked: readonly TeamWallPhoto[];
  candidates: readonly TeamWallPhoto[];
  cursor: string | null;
}>;

/** How many candidates one page of the picker shows. */
export const CANDIDATE_PAGE = 48;

/**
 * The team's picker (FR-636): the current pick in order and a page of eligible photos, newest first.
 *
 * @throws HttpError not_found for another organizer's event or one outside the member's scope.
 */
export function readTeamWall(
  deps: PhotoWallDeps,
  seat: RequestContext,
  eventId: string,
  cursor: string | null,
): Promise<TeamWall> {
  return run(deps.pool, seat, async (client) => {
    const picked = await client.query<TeamRow>("SELECT * FROM event_photo_wall($1)", [eventId]);
    const page = await client.query<TeamRow>("SELECT * FROM event_wall_candidates($1, $2, $3)", [
      eventId,
      cursor,
      CANDIDATE_PAGE,
    ]);
    const last = page.rows.at(-1);
    return {
      picked: await teamRows(deps.storage, picked.rows),
      candidates: await teamRows(deps.storage, page.rows),
      cursor: page.rows.length === CANDIDATE_PAGE && last !== undefined ? last.submission_id : null,
    };
  });
}

/**
 * Saves the pick in order, replacing the last (audited `photo_wall.update`, ids only).
 *
 * @throws HttpError invalid_photo_wall for more than 20, a repeat or a photo that cannot go on screen, big_screen_off
 *   while the add-on is not active, not_found for another organizer's event.
 */
export function saveTeamWall(
  deps: PhotoWallDeps,
  seat: RequestContext,
  change: Readonly<{ eventId: string; submissionIds: readonly string[]; requestId: string }>,
): Promise<number> {
  return run(deps.pool, seat, async (client) => {
    const { rows } = await client.query<{ n: number }>("SELECT set_photo_wall($1, $2, $3) AS n", [
      change.eventId,
      change.submissionIds,
      change.requestId,
    ]);
    return rows[0]?.n ?? 0;
  });
}
