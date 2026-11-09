import type { Pool, PoolClient } from "pg";
import {
  MAX_EVENT_INTERESTS,
  VENUE_RADIUS,
  isTimeZone,
  templateViewOf,
  toInstant,
  type TemplateView,
} from "@questify/shared";
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
import {
  NOT_EMPTY,
  UNKNOWN_TEMPLATE,
  fillFromTemplate,
  readTemplates,
  templateExists,
  type TemplateLog,
} from "#src/events/templates";
import type { OrganizerContext, OrganizerPrincipal } from "#src/organizers/store";
import { teamSeat } from "#src/organizers/store";

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
  /** A city from the seeded list (T-403); null clears it. A virtual event has none. */
  cityId?: string | null | undefined;
  /** Up to 3 interests from the catalog (T-407); they decide who "For you" shows the event to. */
  interests?: readonly string[] | undefined;
  /** A template to start the new event from (T-601b); absent starts it blank. */
  template?: string | undefined;
}>;

export type InvalidField =
  | "name"
  | "timezone"
  | "startsAt"
  | "endsAt"
  | "joinMethods"
  | "cityId"
  | "interests"
  | "template";

type Invalid = Readonly<{ kind: "invalid"; field: InvalidField }>;
type Missing = Readonly<{ kind: "not_found" }>;

export type CreateResult =
  | Readonly<{ kind: "created"; event: EventRecord }>
  | Invalid
  | Readonly<{ kind: "scope_limited" }>;
/** A duplicate is a create that can also miss its source. */
export type DuplicateResult = CreateResult | Missing;
export type UpdateResult =
  | Readonly<{ kind: "updated"; event: EventRecord }>
  | Invalid
  | Missing
  | Readonly<{ kind: "times_locked" }>
  /** The event is live, ended or archived: its city stays (migration 0065). */
  | Readonly<{ kind: "city_locked" }>;
export type RemoveResult =
  | Readonly<{ kind: "deleted" }>
  | Missing
  | Readonly<{ kind: "not_draft" }>
  /** Rehearsal accounts joined it: their data goes with an erase first (T-211). */
  | Readonly<{ kind: "rehearsal_data" }>
  /** A souvenir rule names it (T-402b): its drafts are deleted first, a frozen promise keeps the event. */
  | Readonly<{ kind: "souvenir_data" }>;
export type EndResult = Readonly<{ kind: "ended" }> | Missing | Readonly<{ kind: "not_live" }>;
/** Starting an existing draft from a template: the event as it is now, or why not. */
export type StartResult =
  | Readonly<{ kind: "started"; event: EventRecord }>
  | Invalid
  | Missing
  | Readonly<{ kind: "not_empty" }>;

export type Actor = OrganizerContext & Readonly<{ organizer: OrganizerPrincipal }>;

export type Events = Readonly<{
  list: (actor: Actor) => Promise<EventRecord[]>;
  get: (actor: Actor, id: string) => Promise<EventRecord | undefined>;
  create: (actor: Actor, input: EventInput, caller: Caller) => Promise<CreateResult>;
  /** A new draft with the source's setup (T-601); `input` carries the new name and times. */
  duplicate: (
    actor: Actor,
    sourceId: string,
    input: EventInput,
    caller: Caller,
  ) => Promise<DuplicateResult>;
  update: (actor: Actor, id: string, input: EventInput, caller: Caller) => Promise<UpdateResult>;
  remove: (actor: Actor, id: string, caller: Caller) => Promise<RemoveResult>;
  endEarly: (actor: Actor, id: string, caller: Caller) => Promise<EndResult>;
  /** The templates the picker offers (T-601b), as the picker shows them. */
  templates: (actor: Actor) => Promise<TemplateView[]>;
  /** Fills an empty draft from a template (T-601b); the wizard's "Start from". */
  startFromTemplate: (
    actor: Actor,
    id: string,
    template: string,
    caller: Caller,
  ) => Promise<StartResult>;
}>;

export type EventsDeps = Readonly<{ pool: Pool; joinCodes?: () => string; log: TemplateLog }>;

const DEFAULTS = {
  kind: "physical",
  access: "public",
  joinMethods: ["code", "qr", "link"],
  timezone: "Asia/Riyadh",
  dayStartHour: 4,
} as const;
const TIMES_LOCKED = "QE409";
const BAD_ZONE = "QE422";
const CITY_LOCKED = "CY409";

/** A city id the seeded list does not hold (the event's foreign key, migration 0065). */
const unknownCity = (error: unknown): boolean => {
  const pg = error as { code?: string; constraint?: string };
  return pg.code === "23503" && pg.constraint === "event_city_id_fkey";
};

/** An interest id the catalog does not hold, or a list the trigger refuses (migration 0070). */
const unknownInterest = (error: unknown): boolean => (error as { code?: string }).code === "EI422";

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

/** A time sent, read in the zone, else the stored one; undefined when neither is a time. */
function instantFrom(
  sent: string | undefined,
  stored: Date | null | undefined,
  timezone: string,
): Date | undefined {
  return sent === undefined ? (stored ?? undefined) : instantOf(sent, timezone);
}

/** The start and end after this input: the ones sent, read in the zone, else the stored ones; the end after the start. */
function timesOf(
  current: EventRecord | undefined,
  input: EventInput,
  timezone: string,
): Readonly<{ startsAt: Date; endsAt: Date }> | Invalid {
  const startsAt = instantFrom(input.startsAt, current?.startsAt, timezone);
  if (startsAt === undefined) {
    return { kind: "invalid", field: "startsAt" };
  }
  const endsAt = instantFrom(input.endsAt, current?.endsAt, timezone);
  if (endsAt === undefined || endsAt <= startsAt) {
    return { kind: "invalid", field: "endsAt" };
  }
  return { startsAt, endsAt };
}

/**
 * The event's fields after this input, from what is stored (or the defaults for a new event), checked as one whole.
 * Times sent are read in the zone sent with them, else the stored zone; a zone changed without times keeps the
 * instants, so the wall-clock times move with it.
 */
export function merge(current: EventRecord | undefined, input: EventInput): EventFields | Invalid {
  const name = textOf(input.name, current?.name);
  if (name.ar === null && name.en === null) {
    return { kind: "invalid", field: "name" };
  }
  const when = whenOf(current, input);
  if ("kind" in when) {
    return when;
  }
  const reach = reachOf(current, input);
  if ("field" in reach) {
    return reach;
  }
  const venue = textOf(input.venue, current?.venue);
  const place = placeOf(current, input);
  return {
    nameAr: name.ar,
    nameEn: name.en,
    kind: reach.kind,
    venueAr: venue.ar,
    venueEn: venue.en,
    access: reach.access,
    joinMethods: reach.joinMethods,
    timezone: when.timezone,
    dayStartHour: place.dayStartHour,
    startsAt: when.startsAt,
    endsAt: when.endsAt,
    venuePin: place.venuePin,
    venueRadiusM: place.venueRadiusM,
    cityId: reach.cityId,
    interests: reach.interests,
  };
}

type Text = Readonly<{ ar: string | null; en: string | null }>;

/** A name or venue after this input: both languages sent (blank clears one), else the stored ones. */
function textOf(sent: EventInput["name"], stored: Text | undefined): Text {
  if (sent === undefined) {
    return { ar: stored?.ar ?? null, en: stored?.en ?? null };
  }
  return { ar: blankToNull(sent.ar), en: blankToNull(sent.en) };
}

/** The zone, then the times read in it, or the first refused, in that order. */
function whenOf(
  current: EventRecord | undefined,
  input: EventInput,
): Readonly<{ timezone: string; startsAt: Date; endsAt: Date }> | Invalid {
  const timezone = input.timezone ?? current?.timezone ?? DEFAULTS.timezone;
  if (!isTimeZone(timezone)) {
    return { kind: "invalid", field: "timezone" };
  }
  const times = timesOf(current, input, timezone);
  return "kind" in times ? times : { timezone, ...times };
}

type Reach = Pick<EventFields, "kind" | "cityId" | "interests" | "access" | "joinMethods">;

/**
 * Who the event reaches after this input, or the first refused, in this order: its kind and city (a virtual event has
 * none), its interests (at most 3, no repeats), then its access and join methods (at least one; the public list only
 * for a public event).
 */
function reachOf(current: EventRecord | undefined, input: EventInput): Reach | Invalid {
  const kindAndCity = cityOf(current, input);
  if (kindAndCity === undefined) {
    return { kind: "invalid", field: "cityId" };
  }
  const interests = interestsOf(current, input);
  if (interests === undefined) {
    return { kind: "invalid", field: "interests" };
  }
  const join = joinOf(current, input);
  return join === undefined
    ? { kind: "invalid", field: "joinMethods" }
    : { ...kindAndCity, interests, ...join };
}

/** What was sent, else what is stored, else the default. */
const valueOf = <T>(sent: T | undefined, stored: T | undefined, fallback: T): T =>
  sent ?? stored ?? fallback;

/** The kind and the city after this input; undefined when a virtual event would have a city. */
function cityOf(
  current: EventRecord | undefined,
  input: EventInput,
): Pick<EventFields, "kind" | "cityId"> | undefined {
  const kind = valueOf(input.kind, current?.kind, DEFAULTS.kind);
  const cityId = input.cityId === undefined ? (current?.cityId ?? null) : input.cityId;
  return kind === "virtual" && cityId !== null ? undefined : { kind, cityId };
}

/** The interests after this input; undefined when there are more than 3 or one repeats. */
function interestsOf(
  current: EventRecord | undefined,
  input: EventInput,
): readonly string[] | undefined {
  const interests = input.interests ?? current?.interests ?? [];
  return interests.length > MAX_EVENT_INTERESTS || new Set(interests).size !== interests.length
    ? undefined
    : interests;
}

/** The access and join methods after this input; undefined with no method, or the public list on a closed event. */
function joinOf(
  current: EventRecord | undefined,
  input: EventInput,
): Pick<EventFields, "access" | "joinMethods"> | undefined {
  const access = valueOf(input.access, current?.access, DEFAULTS.access);
  const joinMethods = [
    ...new Set(valueOf(input.joinMethods, current?.joinMethods, DEFAULTS.joinMethods)),
  ];
  if (joinMethods.length === 0 || (joinMethods.includes("public_list") && access !== "public")) {
    return undefined;
  }
  return { access, joinMethods };
}

/** The day's start hour and the venue's pin and radius: each sent, else stored, else the default. */
function placeOf(
  current: EventRecord | undefined,
  input: EventInput,
): Pick<EventFields, "dayStartHour" | "venuePin" | "venueRadiusM"> {
  return {
    dayStartHour: valueOf(input.dayStartHour, current?.dayStartHour, DEFAULTS.dayStartHour),
    venuePin: input.venuePin === undefined ? (current?.venuePin ?? null) : input.venuePin,
    venueRadiusM: valueOf(input.venueRadiusM, current?.venueRadiusM, VENUE_RADIUS.default),
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
  cityId: event.cityId,
  interests: event.interests,
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
    withRequestContext(client, teamSeat(actor), () => work(client)),
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
  try {
    return await inContext(deps, actor, async (client): Promise<CreateResult> => {
      // A template that is not there is refused before anything is written.
      if (input.template !== undefined && !(await templateExists(client, input.template))) {
        return { kind: "invalid", field: "template" };
      }
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
      if (input.template === undefined) {
        return { kind: "created", event: made };
      }
      await fillFromTemplate(client, actor.organizerId, made.id, input.template, caller.requestId);
      const filled = await readEvent(client, actor.organizerId, made.id);
      // Stryker disable next-line all: unreachable: the event was inserted in this transaction
      return { kind: "created", event: filled ?? made };
    });
  } catch (error) {
    if (unknownCity(error)) {
      return { kind: "invalid", field: "cityId" };
    }
    if (unknownInterest(error)) {
      return { kind: "invalid", field: "interests" };
    }
    if ((error as { code?: string }).code === UNKNOWN_TEMPLATE) {
      return { kind: "invalid", field: "template" };
    }
    throw error;
  }
}

/**
 * Fills an existing draft from a template (FR-1015): the wizard's "Start from". Only an empty draft takes one (T-601's rule),
 * so a template can never overwrite an organizer's work.
 */
async function startFromTemplate(
  deps: EventsDeps,
  actor: Actor,
  id: string,
  key: string,
  caller: Caller,
): Promise<StartResult> {
  try {
    return await inContext(deps, actor, async (client): Promise<StartResult> => {
      if ((await readEvent(client, actor.organizerId, id)) === undefined) {
        return { kind: "not_found" };
      }
      if (!(await templateExists(client, key))) {
        return { kind: "invalid", field: "template" };
      }
      await fillFromTemplate(client, actor.organizerId, id, key, caller.requestId);
      const filled = await readEvent(client, actor.organizerId, id);
      // Stryker disable next-line all: unreachable: the event was read in this transaction
      return filled === undefined ? { kind: "not_found" } : { kind: "started", event: filled };
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === NOT_EMPTY) {
      return { kind: "not_empty" };
    }
    if (code === UNKNOWN_TEMPLATE) {
      return { kind: "invalid", field: "template" };
    }
    if (code === "AN404") {
      return { kind: "not_found" };
    }
    throw error;
  }
}

/** A change to the source that committed after the copy's snapshot and before its lock: the copy is tried once more. */
const SERIALIZATION_FAILURE = "40001";

/**
 * A new draft that starts as a copy of another event of the same organizer (FR-1016): its settings, switches and words,
 * and everything `event_copy_setup` copies (migration 0092), never a player, a play row or a secret. The new name and
 * times come with the request; the rest of the event's fields are the source's, checked as one whole.
 */
async function duplicate(
  deps: EventsDeps,
  actor: Actor,
  sourceId: string,
  input: EventInput,
  caller: Caller,
): Promise<DuplicateResult> {
  // A limited editor's new event would fall outside their own limit, as for a create.
  if (actor.organizer.eventScope !== null) {
    return { kind: "scope_limited" };
  }
  try {
    return await copyOnce(deps, actor, sourceId, input, caller).catch((error: unknown) => {
      if ((error as { code?: unknown } | undefined)?.code !== SERIALIZATION_FAILURE) throw error;
      return copyOnce(deps, actor, sourceId, input, caller);
    });
  } catch (error) {
    if (unknownCity(error)) {
      return { kind: "invalid", field: "cityId" };
    }
    if (unknownInterest(error)) {
      return { kind: "invalid", field: "interests" };
    }
    throw error;
  }
}

/**
 * One try of a duplicate in one REPEATABLE READ transaction (ADR-739): every read of the source sees the same moment, so
 * a quest added to it meanwhile is wholly in the copy or wholly out of it. `event_copy_setup` refuses any other level.
 */
function copyOnce(
  deps: EventsDeps,
  actor: Actor,
  sourceId: string,
  input: EventInput,
  caller: Caller,
): Promise<DuplicateResult> {
  return withConnection(deps.pool, (client) =>
    withRequestContext(client, { ...teamSeat(actor), repeatableRead: true }, async () => {
      const source = await readEvent(client, actor.organizerId, sourceId);
      if (source === undefined) {
        return { kind: "not_found" } as const;
      }
      const fields = merge(source, input);
      if (isInvalid(fields)) {
        return fields;
      }
      const made = await insertEvent(
        client,
        actor.organizerId,
        fields,
        deps.joinCodes ?? newJoinCode,
      );
      await client.query("SELECT event_copy_setup($1, $2, $3)", [
        source.id,
        made.id,
        caller.requestId ?? null,
      ]);
      // Read again: the copy changed the event's switches and words.
      const copied = await readEvent(client, actor.organizerId, made.id);
      // Stryker disable next-line all: unreachable: the event was inserted in this transaction
      return { kind: "created", event: copied ?? made } as const;
    }),
  );
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
    if (code === CITY_LOCKED) {
      return { kind: "city_locked" };
    }
    if (unknownCity(error)) {
      return { kind: "invalid", field: "cityId" };
    }
    if (unknownInterest(error)) {
      return { kind: "invalid", field: "interests" };
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
    duplicate: (actor, sourceId, input, caller) => duplicate(deps, actor, sourceId, input, caller),
    update: (actor, id, input, caller) => update(deps, actor, id, input, caller),
    remove: (actor, id, caller) => remove(deps, actor, id, caller),
    endEarly: (actor, id, caller) => endEarly(deps, actor, id, caller),
    templates: async (actor) =>
      (await inContext(deps, actor, (client) => readTemplates(client, deps.log))).map(
        templateViewOf,
      ),
    startFromTemplate: (actor, id, template, caller) =>
      startFromTemplate(deps, actor, id, template, caller),
  };
}
