import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { OrganizerContext } from "#src/organizers/store";
import type { SettingsService } from "#src/settings/service";

export type BoostDeps = Readonly<{ pool: Pool; settings: Pick<SettingsService, "forEvent"> }>;

/** The most boosts one event holds (migration 0055's limit_reached). */
export const MAX_BOOSTS = 100;
/** A boost lasts 1 to 1,440 minutes (FR-252, ADR-232). */
export const BOOST_MINUTES = { min: 1, max: 1440 } as const;

/**
 * A boost as the dashboard sends it: the category it doubles, its start (absent or null: now; up to a minute ago is
 * taken as now) and how many minutes it lasts. The database checks the window against the event's.
 */
export const boostBody = z.strictObject({
  categoryId: z.uuid(),
  startsAt: z.iso.datetime({ offset: true }).nullable().optional(),
  minutes: z.number().int().min(BOOST_MINUTES.min).max(BOOST_MINUTES.max),
});

export type BoostBody = z.infer<typeof boostBody>;

type Bilingual = Readonly<{ ar: string | null; en: string | null }>;

/** A boost for its event's team: its category, window, kind, whether it may still change, and what it paid. */
export type BoostView = Readonly<{
  id: string;
  categoryId: string;
  category: Bilingual;
  multiplier: number;
  startsAt: string;
  endsAt: string;
  /** Saved during the rehearsal before the event's start: rehearsal accounts only, removed at go-live. */
  rehearsal: boolean;
  /** Edit and Delete stay open until a minute before the start, and never once an entry names it. */
  editable: boolean;
  /** How many quest payments it doubled. */
  paid: number;
}>;

/** A boost's window after Stop; `replayed` when it had already ended. */
export type BoostStop = Readonly<{ startsAt: string; endsAt: string; replayed: boolean }>;

/** Why a boost call was refused (migration 0055); each maps to one HTTP answer in the routes. */
export type BoostRefusal =
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "invalid"; issues: readonly string[] }>
  | Readonly<{
      kind: "boost_overlap" | "boost_started" | "event_ended" | "not_started" | "feature_off";
    }>
  | Readonly<{ kind: "limit_reached"; limit: number }>;

export type BoostDone<T> = Readonly<{ kind: "done"; value: T }> | BoostRefusal;

type PgError = Readonly<{ code?: string; detail?: string }>;

const BO409: ReadonlySet<string> = new Set([
  "boost_overlap",
  "boost_started",
  "event_ended",
  "not_started",
]);

/** The SQLSTATEs of migration 0055's boost doors as refusals; undefined for anything else. */
export function boostRefusalOf(pg: PgError): BoostRefusal | undefined {
  switch (pg.code) {
    case "AN404":
    case "BN404":
      return { kind: "not_found" };
    case "BO422":
      return { kind: "invalid", issues: [pg.detail ?? "boost"] };
    case "BO409":
      if (pg.detail === "limit_reached") {
        return { kind: "limit_reached", limit: MAX_BOOSTS };
      }
      return BO409.has(pg.detail ?? "") ? ({ kind: pg.detail } as BoostRefusal) : undefined;
    default:
      return undefined;
  }
}

/** Runs one call in the team member's seat; a refusal the database raises becomes its result. */
async function asTeam<T>(
  deps: Pick<BoostDeps, "pool">,
  context: OrganizerContext,
  work: (client: PoolClient) => Promise<T>,
): Promise<BoostDone<T>> {
  const seat = { organizerId: context.organizerId, staffUserId: context.staffUserId };
  try {
    const value = await withConnection(deps.pool, (client) =>
      withRequestContext(client, seat, () => work(client)),
    );
    return { kind: "done", value };
  } catch (error) {
    const refusal = boostRefusalOf(error as PgError);
    if (refusal === undefined) {
      throw error;
    }
    return refusal;
  }
}

/** Whether the platform's `boosts` switch is on; off, no boost is saved and running ones finish (ADR-233). */
export async function boostsPlatformOn(
  settings: Pick<SettingsService, "forEvent">,
): Promise<boolean> {
  const config = await settings.forEvent(undefined);
  return config.kind === "ok" && config.config.features["boosts"]?.enabled !== false;
}

const iso = (value: unknown): string => new Date(String(value)).toISOString();

type BoostJson = Record<string, unknown>;

const viewOf = (row: BoostJson): BoostView => ({
  id: String(row["id"]),
  categoryId: String(row["categoryId"]),
  category: row["category"] as Bilingual,
  multiplier: Number(row["multiplier"]),
  startsAt: iso(row["startsAt"]),
  endsAt: iso(row["endsAt"]),
  rehearsal: row["rehearsal"] === true,
  editable: row["editable"] === true,
  paid: Number(row["paid"]),
});

async function readBoosts(client: PoolClient, eventId: string): Promise<BoostView[]> {
  const { rows } = await client.query<{ boosts: BoostJson[] }>(
    "SELECT event_boosts($1) AS boosts",
    [eventId],
  );
  return (rows[0]?.boosts ?? []).map(viewOf);
}

/** The event's boosts by start, for its owners and editors (`event_boosts`). */
export function listBoosts(
  deps: BoostDeps,
  context: OrganizerContext,
  eventId: string,
): Promise<BoostDone<BoostView[]>> {
  return asTeam(deps, context, (client) => readBoosts(client, eventId));
}

/**
 * Saves a new boost (`boostId` null) or edits a scheduled one until a minute before its start (FR-252). Refused while
 * the platform switch is off. Audited by the database. Answers the saved boost.
 */
export async function saveBoost(
  deps: BoostDeps,
  context: OrganizerContext,
  request: Readonly<{
    eventId: string;
    boostId: string | null;
    body: BoostBody;
    requestId: string;
  }>,
): Promise<BoostDone<BoostView>> {
  if (!(await boostsPlatformOn(deps.settings))) {
    return { kind: "feature_off" };
  }
  const result = await asTeam(deps, context, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      "SELECT save_boost($1, $2, $3, $4, $5, $6) AS id",
      [
        request.eventId,
        request.boostId,
        request.body.categoryId,
        request.body.startsAt ?? null,
        request.body.minutes,
        request.requestId,
      ],
    );
    return (await readBoosts(client, request.eventId)).find((boost) => boost.id === rows[0]?.id);
  });
  if (result.kind !== "done") {
    return result;
  }
  return result.value === undefined ? { kind: "not_found" } : { kind: "done", value: result.value };
}

/** Deletes a boost until a minute before its start, never once it paid. Audited by the database. */
export function deleteBoost(
  deps: BoostDeps,
  context: OrganizerContext,
  request: Readonly<{ eventId: string; boostId: string; requestId: string }>,
): Promise<BoostDone<null>> {
  return asTeam(deps, context, async (client) => {
    await client.query("SELECT delete_boost($1, $2, $3)", [
      request.eventId,
      request.boostId,
      request.requestId,
    ]);
    return null;
  });
}

/** Stops a running boost now; a stopped or ended one is answered as it is (`replayed`). Audited by the database. */
export function stopBoost(
  deps: BoostDeps,
  context: OrganizerContext,
  request: Readonly<{ eventId: string; boostId: string; requestId: string }>,
): Promise<BoostDone<BoostStop>> {
  return asTeam(deps, context, async (client) => {
    const { rows } = await client.query<{ starts_at: Date; ends_at: Date; replayed: boolean }>(
      "SELECT * FROM end_boost($1, $2, $3)",
      [request.eventId, request.boostId, request.requestId],
    );
    const row = rows[0] as { starts_at: Date; ends_at: Date; replayed: boolean };
    return {
      startsAt: row.starts_at.toISOString(),
      endsAt: row.ends_at.toISOString(),
      replayed: row.replayed,
    };
  });
}
