import type { Pool, PoolClient } from "pg";
import { recordAudit } from "#src/audit/record";
import { isPlausibleEmail, normalizeEmail } from "#src/auth/normalize";
import type { Caller } from "#src/auth/sign-in";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { Actor } from "#src/events/events";
import type { JoinFieldKind } from "@questify/shared";
import { normalizeSaudiMobile } from "#src/players/phone";
import { lockBuilderEvent, type BuilderEvent } from "#src/quests/store";

export type SetupDeps = Readonly<{ pool: Pool }>;

type Label = Readonly<{ ar?: string | undefined; en?: string | undefined }>;

export type FieldInput = Readonly<{
  id?: string | undefined;
  kind: JoinFieldKind;
  label?: Label | undefined;
  required: boolean;
}>;

export type FieldRecord = Readonly<{
  id: string;
  kind: JoinFieldKind;
  label: Readonly<{ ar: string | null; en: string | null }>;
  required: boolean;
}>;

export type JoinRulesSettings = Readonly<{
  guestListOnly: boolean;
  emailDomains: readonly string[];
  welcomePoints: number | null;
}>;

export type RulesInput = Readonly<{
  guestListOnly?: boolean | undefined;
  emailDomains?: readonly string[] | undefined;
  welcomePoints?: number | null | undefined;
}>;

export type JoinSetup = Readonly<{
  /** Sent back with a save of the fields, so a save from a stale page cannot delete newer fields and their answers. */
  version: number;
  fields: readonly FieldRecord[];
  rules: JoinRulesSettings;
  /** The welcome amount is fixed once anyone joined or the event is live (ADR-147). */
  welcomeLocked: boolean;
  guests: number;
}>;

export type Guest = Readonly<{
  id: string;
  kind: "phone" | "email";
  value: string;
  createdAt: Date;
}>;

export type GuestsAdded = Readonly<{
  added: number;
  existing: number;
  /** The lines that are neither a Saudi mobile nor an email, by their place in the upload (from 1). */
  invalid: readonly Readonly<{ line: number; text: string }>[];
  total: number;
}>;

export type SetupDone<T> =
  | Readonly<{ kind: "done"; value: T }>
  | Readonly<{ kind: "not_found" | "event_archived" | "setting_locked" | "fields_changed" }>
  | Readonly<{ kind: "invalid"; field: "fields" | "emailDomains" }>
  | Readonly<{ kind: "guest_list_full"; room: number }>;

/** At most this many join fields an event (FR-129) and guests an event (migration 0028). */
export const JOIN_FIELD_LIMIT = 5;
export const GUEST_LIMIT = 10_000;
/** Lines one upload takes; a bigger list goes in several. */
export const GUESTS_PER_UPLOAD = 2000;
export const DOMAIN_LIMIT = 10;
const LABEL_MAX = 60;

const done = <T>(value: T): SetupDone<T> => ({ kind: "done", value });

// The exclusion list's exact-domain shape (0019, 0028): an internationalized last label is its xn-- form.
const DOMAIN = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/** The domains in lower case without a leading `@`, once each; undefined when one is not a domain. */
export function cleanDomains(raw: readonly string[]): string[] | undefined {
  const domains = new Set<string>();
  for (const typed of raw) {
    const domain = typed.trim().toLowerCase().replace(/^@/, "");
    if (domain.length > 253 || !DOMAIN.test(domain)) {
      return undefined;
    }
    domains.add(domain);
  }
  return domains.size > DOMAIN_LIMIT ? undefined : [...domains];
}

type ParsedGuest = Readonly<{ kind: "phone" | "email"; value: string }>;

/** A line as a guest: a Saudi mobile in any usual form, else an email with a dotted domain; undefined when neither. */
export function parseGuest(line: string): ParsedGuest | undefined {
  const phone = normalizeSaudiMobile(line);
  if (phone !== undefined) {
    return { kind: "phone", value: phone };
  }
  const email = normalizeEmail(line);
  const domain = email.split("@")[1] ?? "";
  return isPlausibleEmail(email) && /^[^.]+(\.[^.]+)+$/.test(domain)
    ? { kind: "email", value: email }
    : undefined;
}

/**
 * Splits an upload into guests (once each) and the lines that are not one. Empty lines are skipped; an invalid line is
 * reported by its place and at most 60 characters of it, so the organizer can find and fix it (FR-132).
 */
export function parseGuests(lines: readonly string[]): Readonly<{
  guests: ParsedGuest[];
  invalid: { line: number; text: string }[];
}> {
  const guests = new Map<string, ParsedGuest>();
  const invalid: { line: number; text: string }[] = [];
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (line === "") {
      return;
    }
    const guest = parseGuest(line);
    if (guest === undefined) {
      invalid.push({ line: index + 1, text: line.slice(0, 60) });
      return;
    }
    guests.set(`${guest.kind}:${guest.value}`, guest);
  });
  return { guests: [...guests.values()], invalid };
}

/** A guest as the dashboard shows it: a phone's last four digits, an email's first letter and its domain. */
export function maskGuest(kind: "phone" | "email", value: string): string {
  if (kind === "phone") {
    return `•••• ${value.slice(-4)}`;
  }
  const [local = "", domain = ""] = value.split("@");
  return `${local.slice(0, 1)}•••@${domain}`;
}

const labelText = (text: string | undefined): string | null => {
  const trimmed = text?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
};

/** The fields to save, or undefined when the list breaks a rule the database would also refuse. */
export function cleanFields(
  input: readonly FieldInput[],
  current: readonly FieldRecord[],
): FieldRecord[] | undefined {
  if (input.length > JOIN_FIELD_LIMIT) {
    return undefined;
  }
  const kinds = new Set<JoinFieldKind>();
  const ids = new Set<string>();
  const cleaned: FieldRecord[] = [];
  for (const field of input) {
    const custom = field.kind === "custom";
    const label = custom
      ? { ar: labelText(field.label?.ar), en: labelText(field.label?.en) }
      : { ar: null, en: null };
    const kept = field.id === undefined ? undefined : current.find((row) => row.id === field.id);
    if (
      (custom && label.ar === null && label.en === null) ||
      [label.ar, label.en].some((text) => text !== null && [...text].length > LABEL_MAX) ||
      (!custom && kinds.has(field.kind)) ||
      (field.id !== undefined && (kept?.kind !== field.kind || ids.has(field.id)))
    ) {
      return undefined;
    }
    kinds.add(field.kind);
    if (field.id !== undefined) {
      ids.add(field.id);
    }
    cleaned.push({ id: field.id ?? "", kind: field.kind, label, required: field.required });
  }
  return cleaned;
}

type FieldRow = {
  id: string;
  kind: JoinFieldKind;
  label_ar: string | null;
  label_en: string | null;
  required: boolean;
};

async function readFields(client: PoolClient, eventId: string): Promise<FieldRecord[]> {
  const { rows } = await client.query<FieldRow>(
    `SELECT id, kind, label_ar, label_en, required FROM event_join_field
     WHERE event_id = $1 ORDER BY position, id`,
    [eventId],
  );
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    label: { ar: row.label_ar, en: row.label_en },
    required: row.required,
  }));
}

type EventRow = {
  join_fields_version: number;
  guest_list_only: boolean;
  email_domains: string[];
  welcome_points: number | null;
  has_members: boolean;
  guests: number;
};

async function readEvent(client: PoolClient, eventId: string): Promise<EventRow> {
  const { rows } = await client.query<EventRow>(
    `SELECT join_fields_version, guest_list_only, email_domains, welcome_points,
            EXISTS (SELECT 1 FROM enrollment n WHERE n.event_id = e.id) AS has_members,
            (SELECT count(*)::int FROM event_guest g WHERE g.event_id = e.id) AS guests
     FROM event e WHERE e.id = $1`,
    [eventId],
  );
  return rows[0] as EventRow;
}

const rulesOf = (row: EventRow): JoinRulesSettings => ({
  guestListOnly: row.guest_list_only,
  emailDomains: row.email_domains,
  welcomePoints: row.welcome_points,
});

const welcomeLocked = (event: BuilderEvent, row: EventRow) =>
  row.has_members || !(event.statusNow === "draft" || event.statusNow === "scheduled");

type Work<T> = (client: PoolClient, event: BuilderEvent) => Promise<SetupDone<T>>;

/** Runs one action on the path's event, locked against other saves: not found outside the caller's reach. */
function withSetupEvent<T>(
  deps: SetupDeps,
  actor: Actor,
  eventId: string,
  work: Work<T>,
  writes = true,
): Promise<SetupDone<T>> {
  return withConnection(deps.pool, (client) =>
    withRequestContext(
      client,
      { organizerId: actor.organizerId, staffUserId: actor.staffUserId },
      async () => {
        const event = await lockBuilderEvent(client, actor.organizerId, eventId);
        if (event === undefined) {
          return { kind: "not_found" } as const;
        }
        if (writes && event.statusNow === "archived") {
          return { kind: "event_archived" } as const;
        }
        return work(client, event);
      },
    ),
  );
}

const audit = (
  client: PoolClient,
  actor: Actor,
  caller: Caller,
  entry: Readonly<{
    action: string;
    eventId: string;
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
  }>,
) =>
  recordAudit(client, {
    actor: { type: "staff", id: actor.staffUserId },
    action: entry.action,
    target: { type: "event", id: entry.eventId },
    organizerId: actor.organizerId,
    eventId: entry.eventId,
    before: entry.before,
    after: entry.after,
    requestId: caller.requestId,
  });

const fieldsView = (fields: readonly FieldRecord[]) =>
  fields.map((field) => ({
    kind: field.kind,
    required: field.required,
    labelAr: field.label.ar,
    labelEn: field.label.en,
  }));

/** The event's join setup for its team: the fields, the locks, the welcome amount and how many guests (T-212). */
export function readSetup(
  deps: SetupDeps,
  actor: Actor,
  eventId: string,
): Promise<SetupDone<JoinSetup>> {
  return withSetupEvent(
    deps,
    actor,
    eventId,
    async (client, event) => {
      const row = await readEvent(client, eventId);
      return done({
        version: row.join_fields_version,
        fields: await readFields(client, eventId),
        rules: rulesOf(row),
        welcomeLocked: welcomeLocked(event, row),
        guests: row.guests,
      });
    },
    false,
  );
}

/**
 * Saves the event's whole field list in order (FR-129): fields kept by id are updated, new ones added and missing ones
 * deleted with their answers. The page sends the version it read; another save in between is `fields_changed`.
 */
export function saveFields(
  deps: SetupDeps,
  actor: Actor,
  eventId: string,
  input: Readonly<{ version: number; fields: readonly FieldInput[] }>,
  caller: Caller,
): Promise<SetupDone<Readonly<{ version: number; fields: FieldRecord[] }>>> {
  return withSetupEvent(deps, actor, eventId, async (client) => {
    const row = await readEvent(client, eventId);
    if (row.join_fields_version !== input.version) {
      return { kind: "fields_changed" };
    }
    const before = await readFields(client, eventId);
    const fields = cleanFields(input.fields, before);
    if (fields === undefined) {
      return { kind: "invalid", field: "fields" };
    }
    const keptIds = fields.map((field) => field.id).filter((id) => id !== "");
    await client.query(
      "DELETE FROM event_join_field WHERE event_id = $1 AND NOT (id = ANY ($2::uuid[]))",
      [eventId, keptIds],
    );
    for (const [position, field] of fields.entries()) {
      if (field.id === "") {
        await client.query(
          `INSERT INTO event_join_field (event_id, kind, label_ar, label_en, required, position)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [eventId, field.kind, field.label.ar, field.label.en, field.required, position],
        );
      } else {
        await client.query(
          `UPDATE event_join_field SET label_ar = $3, label_en = $4, required = $5, position = $6
           WHERE event_id = $1 AND id = $2`,
          [eventId, field.id, field.label.ar, field.label.en, field.required, position],
        );
      }
    }
    const version = input.version + 1;
    await client.query("UPDATE event SET join_fields_version = $2 WHERE id = $1", [
      eventId,
      version,
    ]);
    const after = await readFields(client, eventId);
    await audit(client, actor, caller, {
      action: "event.join_fields.update",
      eventId,
      before: { fields: fieldsView(before) },
      after: { fields: fieldsView(after) },
    });
    return done({ version, fields: after });
  });
}

/**
 * Sets the locks and the welcome amount (FR-134, FR-135, FR-136). A changed amount is refused once anyone joined or
 * the event is live (the database's guard backs it); sending the current amount is no change.
 */
export function updateRules(
  deps: SetupDeps,
  actor: Actor,
  eventId: string,
  input: RulesInput,
  caller: Caller,
): Promise<SetupDone<JoinRulesSettings>> {
  return withSetupEvent(deps, actor, eventId, async (client, event) => {
    const row = await readEvent(client, eventId);
    const before = rulesOf(row);
    const domains =
      input.emailDomains === undefined ? before.emailDomains : cleanDomains(input.emailDomains);
    if (domains === undefined) {
      return { kind: "invalid", field: "emailDomains" };
    }
    const after: JoinRulesSettings = {
      guestListOnly: input.guestListOnly ?? before.guestListOnly,
      emailDomains: domains,
      welcomePoints: input.welcomePoints === undefined ? before.welcomePoints : input.welcomePoints,
    };
    if (after.welcomePoints !== before.welcomePoints && welcomeLocked(event, row)) {
      return { kind: "setting_locked" };
    }
    await client.query(
      `UPDATE event SET guest_list_only = $2, email_domains = $3, welcome_points = $4 WHERE id = $1`,
      [eventId, after.guestListOnly, after.emailDomains, after.welcomePoints],
    );
    await audit(client, actor, caller, {
      action: "event.join_rules.update",
      eventId,
      before: { ...before },
      after: { ...after },
    });
    return done(after);
  });
}

/**
 * The event's guest list for its team: the total and the newest 200 entries, masked. With a contact, only the entry
 * for exactly that phone or email (none when it is not one), so an older guest can be found and removed (FR-132).
 */
export function listGuests(
  deps: SetupDeps,
  actor: Actor,
  eventId: string,
  contact?: string,
): Promise<SetupDone<Readonly<{ total: number; guests: Guest[] }>>> {
  const wanted = contact === undefined ? undefined : (parseGuest(contact) ?? null);
  return withSetupEvent(
    deps,
    actor,
    eventId,
    async (client) => {
      const counted = await client.query<{ total: number }>(
        "SELECT count(*)::int AS total FROM event_guest WHERE event_id = $1",
        [eventId],
      );
      const { rows } = await client.query<{
        id: string;
        kind: "phone" | "email";
        value: string;
        created_at: Date;
      }>(
        `SELECT id, kind, value, created_at FROM event_guest
         WHERE event_id = $1 AND ($2::boolean OR (kind = $3 AND value = $4))
         ORDER BY created_at DESC, id LIMIT 200`,
        [eventId, wanted === undefined, wanted?.kind ?? null, wanted?.value ?? null],
      );
      return done({
        total: counted.rows[0]?.total ?? 0,
        guests: rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          value: maskGuest(row.kind, row.value),
          createdAt: row.created_at,
        })),
      });
    },
    false,
  );
}

/**
 * Adds an upload to the guest list (FR-132): each valid line once, the ones already there counted, the invalid ones
 * reported and not added. An upload that would pass 10 000 adds nothing. The audit keeps counts, never a contact.
 */
export function addGuests(
  deps: SetupDeps,
  actor: Actor,
  eventId: string,
  lines: readonly string[],
  caller: Caller,
): Promise<SetupDone<GuestsAdded>> {
  const { guests, invalid } = parseGuests(lines);
  return withSetupEvent(deps, actor, eventId, async (client) => {
    const kinds = guests.map((guest) => guest.kind);
    const values = guests.map((guest) => guest.value);
    const { rows: counted } = await client.query<{ total: number; fresh: number }>(
      `SELECT (SELECT count(*)::int FROM event_guest WHERE event_id = $1) AS total,
              (SELECT count(*)::int FROM unnest($2::text[], $3::text[]) AS u(kind, value)
               WHERE NOT EXISTS (SELECT 1 FROM event_guest g
                                 WHERE g.event_id = $1 AND g.kind = u.kind AND g.value = u.value)) AS fresh`,
      [eventId, kinds, values],
    );
    const { total, fresh } = counted[0] as { total: number; fresh: number };
    if (total + fresh > GUEST_LIMIT) {
      return { kind: "guest_list_full", room: GUEST_LIMIT - total };
    }
    const { rowCount } = await client.query(
      `INSERT INTO event_guest (event_id, kind, value)
       SELECT $1, u.kind, u.value FROM unnest($2::text[], $3::text[]) AS u(kind, value)
       ON CONFLICT (event_id, kind, value) DO NOTHING`,
      [eventId, kinds, values],
    );
    const added = rowCount ?? 0;
    const result: GuestsAdded = {
      added,
      existing: guests.length - added,
      invalid,
      total: total + added,
    };
    if (added > 0) {
      await audit(client, actor, caller, {
        action: "event.guests.add",
        eventId,
        after: { added, existing: result.existing, total: result.total },
      });
    }
    return done(result);
  });
}

/** Removes one guest; an entry of another event is not found. */
export function removeGuest(
  deps: SetupDeps,
  actor: Actor,
  target: Readonly<{ eventId: string; id: string }>,
  caller: Caller,
): Promise<SetupDone<null>> {
  return withSetupEvent(deps, actor, target.eventId, async (client) => {
    const { rows } = await client.query<{ kind: string }>(
      "DELETE FROM event_guest WHERE event_id = $1 AND id = $2 RETURNING kind",
      [target.eventId, target.id],
    );
    const gone = rows[0];
    if (gone === undefined) {
      return { kind: "not_found" };
    }
    await audit(client, actor, caller, {
      action: "event.guests.remove",
      eventId: target.eventId,
      before: { kind: gone.kind },
    });
    return done(null);
  });
}
