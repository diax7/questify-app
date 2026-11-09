import type { Pool, PoolClient } from "pg";
import { REGISTRIES } from "@questify/shared";
import { z } from "zod";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { OrganizerContext } from "#src/organizers/store";
import { platformOnFor } from "#src/settings/layers";
import { teamSeat } from "#src/organizers/store";

export type BoostDeps = Readonly<{ pool: Pool }>;

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
      kind:
        | "boost_overlap"
        | "boost_started"
        | "event_ended"
        | "not_started"
        | "feature_off"
        | "event_feature_off";
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

const REFUSAL_OF_CODE = new Map<string, (pg: PgError) => BoostRefusal | undefined>([
  ["AN404", () => ({ kind: "not_found" })],
  ["BN404", () => ({ kind: "not_found" })],
  ["BO422", (pg) => ({ kind: "invalid", issues: [pg.detail ?? "boost"] })],
  [
    "BO409",
    (pg) => {
      if (pg.detail === "limit_reached") {
        return { kind: "limit_reached", limit: MAX_BOOSTS };
      }
      return BO409.has(pg.detail ?? "") ? ({ kind: pg.detail } as BoostRefusal) : undefined;
    },
  ],
]);

/** The SQLSTATEs of migration 0055's boost doors as refusals; undefined for anything else. */
export function boostRefusalOf(pg: PgError): BoostRefusal | undefined {
  return pg.code === undefined ? undefined : REFUSAL_OF_CODE.get(pg.code)?.(pg);
}

/** Runs one call in the team member's seat; a refusal the database raises becomes its result. */
async function asTeam<T>(
  deps: Pick<BoostDeps, "pool">,
  context: OrganizerContext,
  work: (client: PoolClient) => Promise<T>,
): Promise<BoostDone<T>> {
  const seat = teamSeat(context);
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

/** Whether the event's own double-points switch is on (it is, until the organizer turns it off). */
async function eventBoostsOn(client: PoolClient, eventId: string): Promise<boolean> {
  const { rows } = await client.query<{ on: boolean }>(
    "SELECT coalesce((config -> 'features' ->> 'boosts')::boolean, true) AS on FROM event WHERE id = $1",
    [eventId],
  );
  return rows[0]?.on !== false;
}

/**
 * Saves a new boost (`boostId` null) or edits a scheduled one until a minute before its start (FR-252). Refused while
 * the platform switch as the organizer sees it (`feature_off`: the platform, or Questify's override for the organizer;
 * ADR-543) or the event's own switch (`event_feature_off`) is off. Off for the platform, running boosts still finish
 * (ADR-233, ADR-540). Audited by the database. Answers the saved boost.
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
  const target = { eventId: request.eventId, organizerId: context.organizerId };
  const switchedOn = await asTeam(deps, context, async (client) => ({
    platform: await platformOnFor(client, REGISTRIES, target, "boosts"),
    event: await eventBoostsOn(client, request.eventId),
  }));
  if (switchedOn.kind !== "done") {
    return switchedOn;
  }
  if (switchedOn.value.platform === false) {
    return { kind: "feature_off" };
  }
  if (!switchedOn.value.event) {
    return { kind: "event_feature_off" };
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
