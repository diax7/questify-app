import type { Pool, PoolClient } from "pg";
import { VENUE_RADIUS, isTimeZone, toInstant } from "@questify/shared";
import { recordAudit } from "#src/audit/record";
import type { Caller } from "#src/auth/sign-in";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import {
  deleteDraft,
  insertEvent,
  listEvents,
  newJoinCode,
  readEvent,
  updateEvent,
  type EventAccess,
  type EventFields,
  type EventKind,
  type EventRecord,
  type JoinMethod,
  type VenuePin,
} from "#src/events/store";
import type { OrganizerContext, OrganizerPrincipal } from "#src/organizers/store";

/** What the dashboard sends: times as the event's wall clock (`YYYY-MM-DDTHH:mm`), read in its zone. */
export type EventInput = Readonly<{
  name?: Readonly<{ ar?: string | undefined; en?: string | undefined }> | undefined;
  kind?: EventKind | undefined;
  venue?: Readonly<{ ar?: string | undefined; en?: string | undefined }> | undefined;
  access?: EventAccess | undefined;
  joinMethods?: readonly JoinMethod[] | undefined;
  timezone?: string | undefined;
  dayStartHour?: number | undefined;
  startsAt?: string | undefined;
  endsAt?: string | undefined;
  /** The venue's pin (T-303b); null clears it. */
  venuePin?: VenuePin | null | undefined;
  venueRadiusM?: number | undefined;
}>;

export type InvalidField = "name" | "timezone" | "startsAt" | "endsAt" | "joinMethods";

type Invalid = Readonly<{ kind: "invalid"; field: InvalidField }>;
type Missing = Readonly<{ kind: "not_found" }>;

export type CreateResult =
  | Readonly<{ kind: "created"; event: EventRecord }>
  | Invalid
  | Readonly<{ kind: "scope_limited" }>;
export type UpdateResult =
  | Readonly<{ kind: "updated"; event: EventRecord }>
  | Invalid
  | Missing
  | Readonly<{ kind: "times_locked" }>;
export type RemoveResult =
  | Readonly<{ kind: "deleted" }>
  | Missing
  | Readonly<{ kind: "not_draft" }>
  /** Rehearsal accounts joined it: their data goes with an erase first (T-211). */
  | Readonly<{ kind: "rehearsal_data" }>
  /** A souvenir rule names it (T-402b): its drafts are deleted first, a frozen promise keeps the event. */
  | Readonly<{ kind: "souvenir_data" }>;
export type EndResult = Readonly<{ kind: "ended" }> | Missing | Readonly<{ kind: "not_live" }>;

export type Actor = OrganizerContext & Readonly<{ organizer: OrganizerPrincipal }>;

export type Events = Readonly<{
  list: (actor: Actor) => Promise<EventRecord[]>;
  get: (actor: Actor, id: string) => Promise<EventRecord | undefined>;
  create: (actor: Actor, input: EventInput, caller: Caller) => Promise<CreateResult>;
  update: (actor: Actor, id: string, input: EventInput, caller: Caller) => Promise<UpdateResult>;
  remove: (actor: Actor, id: string, caller: Caller) => Promise<RemoveResult>;
  endEarly: (actor: Actor, id: string, caller: Caller) => Promise<EndResult>;
}>;

export type EventsDeps = Readonly<{ pool: Pool; joinCodes?: () => string }>;

const DEFAULTS = {
  kind: "physical",
  access: "public",
  joinMethods: ["code", "qr", "link"],
  timezone: "Asia/Riyadh",
  dayStartHour: 4,
} as const;
const TIMES_LOCKED = "QE409";
const BAD_ZONE = "QE422";

const blankToNull = (text: string | null | undefined): string | null => {
  const trimmed = text?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
};

/** Reads a wall-clock time in a zone; undefined when it is not one. */
function instantOf(local: string, timeZone: string): Date | undefined {
  try {
    return toInstant(local, timeZone);
  } catch {
    return undefined;
  }
}

/**
 * The event's fields after this input, from what is stored (or the defaults for a new event), checked as one whole.
 * Times sent are read in the zone sent with them, else the stored zone; a zone changed without times keeps the
 * instants, so the wall-clock times move with it.
 */
export function merge(current: EventRecord | undefined, input: EventInput): EventFields | Invalid {
  const nameAr = input.name === undefined ? (current?.name.ar ?? null) : blankToNull(input.name.ar);
  const nameEn = input.name === undefined ? (current?.name.en ?? null) : blankToNull(input.name.en);
  if (nameAr === null && nameEn === null) {
    return { kind: "invalid", field: "name" };
  }
  const timezone = input.timezone ?? current?.timezone ?? DEFAULTS.timezone;
  if (!isTimeZone(timezone)) {
    return { kind: "invalid", field: "timezone" };
  }
  const startsAt =
    input.startsAt === undefined
      ? (current?.startsAt ?? undefined)
      : instantOf(input.startsAt, timezone);
  if (startsAt === undefined || startsAt === null) {
    return { kind: "invalid", field: "startsAt" };
  }
  const endsAt =
    input.endsAt === undefined ? (current?.endsAt ?? undefined) : instantOf(input.endsAt, timezone);
  if (endsAt === undefined || endsAt === null || endsAt <= startsAt) {
    return { kind: "invalid", field: "endsAt" };
  }
  const access = input.access ?? current?.access ?? DEFAULTS.access;
  const joinMethods = [
    ...new Set(input.joinMethods ?? current?.joinMethods ?? DEFAULTS.joinMethods),
  ];
  if (joinMethods.length === 0 || (joinMethods.includes("public_list") && access !== "public")) {
    return { kind: "invalid", field: "joinMethods" };
  }
  return {
    nameAr,
    nameEn,
    kind: input.kind ?? current?.kind ?? DEFAULTS.kind,
    venueAr: input.venue === undefined ? (current?.venue.ar ?? null) : blankToNull(input.venue.ar),
    venueEn: input.venue === undefined ? (current?.venue.en ?? null) : blankToNull(input.venue.en),
    access,
    joinMethods,
    timezone,
    dayStartHour: input.dayStartHour ?? current?.dayStartHour ?? DEFAULTS.dayStartHour,
    startsAt,
    endsAt,
    venuePin: input.venuePin === undefined ? (current?.venuePin ?? null) : input.venuePin,
    venueRadiusM: input.venueRadiusM ?? current?.venueRadiusM ?? VENUE_RADIUS.default,
  };
}

const isInvalid = (value: EventFields | Invalid): value is Invalid =>
  "kind" in value && value.kind === "invalid";

/** What an audit entry keeps of an event: no personal data, only what the event is. */
const auditView = (event: EventRecord) => ({
  nameAr: event.name.ar,
  nameEn: event.name.en,
  kind: event.kind,
  venueAr: event.venue.ar,
  venueEn: event.venue.en,
  access: event.access,
  joinMethods: event.joinMethods,
  timezone: event.timezone,
  dayStartHour: event.dayStartHour,
  startsAt: event.startsAt?.toISOString() ?? null,
  endsAt: event.endsAt?.toISOString() ?? null,
  venuePin: event.venuePin,
  venueRadiusM: event.venueRadiusM,
});

/** Only the fields that changed, before and after, so an entry reads as the change it records. */
function changes(before: EventRecord, after: EventRecord) {
  const a: Record<string, unknown> = auditView(before);
  const b: Record<string, unknown> = auditView(after);
  const keys = Object.keys(b).filter((key) => JSON.stringify(a[key]) !== JSON.stringify(b[key]));
  return {
    before: Object.fromEntries(keys.map((key) => [key, a[key]])),
    after: Object.fromEntries(keys.map((key) => [key, b[key]])),
  };
}

const inContext = <T>(deps: EventsDeps, actor: Actor, work: (client: PoolClient) => Promise<T>) =>
  withConnection(deps.pool, (client) =>
    withRequestContext(
      client,
      { organizerId: actor.organizerId, staffUserId: actor.staffUserId },
      () => work(client),
    ),
  );

const audit = (
  client: PoolClient,
  actor: Actor,
  entry: { action: string; eventId: string; before?: object; after?: object },
  caller: Caller,
) =>
  recordAudit(client, {
    actor: { type: "staff", id: actor.staffUserId },
    action: entry.action,
    target: { type: "event", id: entry.eventId },
    organizerId: actor.organizerId,
    eventId: entry.eventId,
    before: entry.before as Record<string, unknown> | undefined,
    after: entry.after as Record<string, unknown> | undefined,
    requestId: caller.requestId,
  });

async function create(
  deps: EventsDeps,
  actor: Actor,
  input: EventInput,
  caller: Caller,
): Promise<CreateResult> {
  // A limited editor's new event would fall outside their own limit; the database refuses it too (migration 0008).
  if (actor.organizer.eventScope !== null) {
    return { kind: "scope_limited" };
  }
  const fields = merge(undefined, input);
  if (isInvalid(fields)) {
    return fields;
  }
  const event = await inContext(deps, actor, async (client) => {
    const made = await insertEvent(
      client,
      actor.organizerId,
      fields,
      deps.joinCodes ?? newJoinCode,
    );
    await audit(
      client,
      actor,
      { action: "event.create", eventId: made.id, after: auditView(made) },
      caller,
    );
    return made;
  });
  return { kind: "created", event };
}

async function update(
  deps: EventsDeps,
  actor: Actor,
  id: string,
  input: EventInput,
  caller: Caller,
): Promise<UpdateResult> {
  try {
    return await inContext(deps, actor, async (client) => {
      const current = await readEvent(client, actor.organizerId, id, true);
      if (current === undefined) {
        return { kind: "not_found" } as const;
      }
      const fields = merge(current, input);
      if (isInvalid(fields)) {
        return fields;
      }
      const updated = await updateEvent(client, actor.organizerId, id, fields);
      // Stryker disable all: unreachable: the row is locked in this transaction
      if (updated === undefined) {
        throw new Error(`Event ${id} was locked but not updated; nothing was changed.`);
      }
      // Stryker restore all
      const diff = changes(current, updated);
      if (Object.keys(diff.after).length > 0) {
        await audit(client, actor, { action: "event.update", eventId: id, ...diff }, caller);
      }
      return { kind: "updated", event: updated } as const;
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === TIMES_LOCKED) {
      return { kind: "times_locked" };
    }
    // A zone this runtime knows but the database does not; merge refuses the zones neither knows.
    // Stryker disable all: reachable only with a database older than the runtime's zone data
    if (code === BAD_ZONE) {
      return { kind: "invalid", field: "timezone" };
    }
    // Stryker restore all
    throw error;
  }
}

async function remove(
  deps: EventsDeps,
  actor: Actor,
  id: string,
  caller: Caller,
): Promise<RemoveResult> {
  try {
    return await removeDraft(deps, actor, id, caller);
  } catch (error) {
    // souvenir_rule's event reference has no cascade (migration 0064): the delete rolls back whole.
    const pg = error as { code?: string; table?: string };
    if (pg.code === "23503" && pg.table === "souvenir_rule") {
      return { kind: "souvenir_data" };
    }
    throw error;
  }
}

function removeDraft(
  deps: EventsDeps,
  actor: Actor,
  id: string,
  caller: Caller,
): Promise<RemoveResult> {
  return inContext(deps, actor, async (client) => {
    // Locked until the delete: nothing can activate the event in between.
    const current = await readEvent(client, actor.organizerId, id, true);
    if (current === undefined) {
      return { kind: "not_found" } as const;
    }
    if (current.status !== "draft") {
      return { kind: "not_draft" } as const;
    }
    const rehearsed = await client.query(
      "SELECT 1 FROM enrollment WHERE event_id = $1 AND joined_via = 'rehearsal' LIMIT 1",
      [id],
    );
    if (rehearsed.rowCount === 1) {
      return { kind: "rehearsal_data" } as const;
    }
    // Written first: the audit rules need the event to exist (migration 0006).
    await audit(
      client,
      actor,
      { action: "event.delete", eventId: id, before: auditView(current) },
      caller,
    );
    // Stryker disable all: unreachable: the locked row is a draft, and the policy deletes drafts
    if (!(await deleteDraft(client, actor.organizerId, id))) {
      throw new Error(`Event ${id} was locked as a draft but not deleted; nothing was changed.`);
    }
    // Stryker restore all
    return { kind: "deleted" } as const;
  });
}

async function endEarly(
  deps: EventsDeps,
  actor: Actor,
  id: string,
  caller: Caller,
): Promise<EndResult> {
  try {
    await inContext(deps, actor, (client) =>
      client.query("SELECT end_event_early($1, $2)", [id, caller.requestId ?? null]),
    );
    return { kind: "ended" };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "QE403") {
      return { kind: "not_found" };
    }
    if (code === TIMES_LOCKED) {
      return { kind: "not_live" };
    }
    throw error;
  }
}

/** The event builder (FR-1001–1003, FR-1017, FR-1608, FR-1714, FR-1728). */
export function createEvents(deps: EventsDeps): Events {
  return {
    list: (actor) => inContext(deps, actor, (client) => listEvents(client, actor.organizerId)),
    get: (actor, id) =>
      inContext(deps, actor, (client) => readEvent(client, actor.organizerId, id)),
    create: (actor, input, caller) => create(deps, actor, input, caller),
    update: (actor, id, input, caller) => update(deps, actor, id, input, caller),
    remove: (actor, id, caller) => remove(deps, actor, id, caller),
    endEarly: (actor, id, caller) => endEarly(deps, actor, id, caller),
  };
}
