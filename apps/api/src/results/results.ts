import { officialRules, type OfficialRules, type RulesData } from "@questify/shared";
import type { Pool, PoolClient } from "pg";
import type { Caller } from "#src/auth/sign-in";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { Actor } from "#src/events/events";
import { audit, changes } from "#src/quests/builder";
import { lockBuilderEvent, type Bilingual } from "#src/quests/store";

export type ResultsDeps = Readonly<{ pool: Pool }>;

export const PRIZE_KINDS = ["item", "experience"] as const;
export type PrizeKind = (typeof PRIZE_KINDS)[number];

/** At most this many rank prizes per event (ranks run 1 to 100). */
export const PRIZE_LIMIT = 100;

type Text = Readonly<{ ar?: string | null | undefined; en?: string | null | undefined }>;

export type PrizeInput = Readonly<{
  rankFrom?: number | undefined;
  rankTo?: number | undefined;
  name?: Text | undefined;
  description?: Text | undefined;
}>;

export type PrizeRecord = Readonly<{
  id: string;
  rankFrom: number;
  rankTo: number;
  kind: PrizeKind;
  name: Bilingual;
  description: Bilingual;
}>;

/** Why a results action was refused; each maps to one HTTP answer in the routes. */
export type ResultsRefusal =
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "event_archived" }>
  | Readonly<{ kind: "invalid"; field: string }>
  | Readonly<{ kind: "limit_reached"; limit: number }>
  | Readonly<{ kind: "owner_only" }>
  | Readonly<{ kind: "desk_needed" }>
  | Readonly<{ kind: "prizes_locked" }>
  | Readonly<{ kind: "overlap" }>
  | Readonly<{ kind: "removed" }>
  | Readonly<{ kind: "results_final" }>
  | Readonly<{ kind: "not_ended" }>
  | Readonly<{ kind: "results_changed" }>
  | Readonly<{ kind: "not_confirmed" }>
  | Readonly<{ kind: "bad_deadline" }>
  | Readonly<{ kind: "desk_closed_until_deadline" }>;

export type ResultsDone<T> = Readonly<{ kind: "done"; value: T }> | ResultsRefusal;

const RF409_DETAILS = new Set([
  "prizes_locked",
  "overlap",
  "removed",
  "results_final",
  "not_ended",
  "results_changed",
  "not_confirmed",
  "bad_deadline",
  "desk_closed_until_deadline",
]);

/** The SQLSTATEs of migration 0034 (and the event guard under a rank prize). */
export function refusalOf(code: string | undefined, detail: string): ResultsRefusal | undefined {
  switch (code) {
    case "AN404":
      return { kind: "not_found" };
    case "DL409":
      return { kind: "desk_needed" };
    case "22023":
      return { kind: "invalid", field: "expected" };
    case "RF409":
      return RF409_DETAILS.has(detail) ? ({ kind: detail } as ResultsRefusal) : undefined;
    default:
      return undefined;
  }
}

/** Runs one call in the team member's seat; a refusal the database raises becomes its result. */
async function asTeam<T>(
  deps: ResultsDeps,
  context: Actor,
  work: (client: PoolClient) => Promise<ResultsDone<T>>,
): Promise<ResultsDone<T>> {
  try {
    return await withConnection(deps.pool, (client) =>
      withRequestContext(
        client,
        { organizerId: context.organizerId, staffUserId: context.staffUserId },
        () => work(client),
      ),
    );
  } catch (error) {
    const pg = error as { code?: string; detail?: string };
    const refusal = refusalOf(pg.code, pg.detail ?? "");
    if (refusal === undefined) {
      throw error;
    }
    return refusal;
  }
}

const done = <T>(value: T): ResultsDone<T> => ({ kind: "done", value });
const iso = (value: unknown): string | null => (value instanceof Date ? value.toISOString() : null);
const textOf = (ar: unknown, en: unknown): Bilingual => ({
  ar: typeof ar === "string" ? ar : null,
  en: typeof en === "string" ? en : null,
});
const blankToNull = (value: string | null | undefined): string | null =>
  value === undefined || value === null || value.trim() === "" ? null : value.trim();

type PrizeRow = Readonly<Record<string, unknown>>;
const PRIZE_COLUMNS =
  "id, rank_from, rank_to, kind, name_ar, name_en, description_ar, description_en";

const prizeOf = (row: PrizeRow): PrizeRecord => ({
  id: String(row["id"]),
  rankFrom: Number(row["rank_from"]),
  rankTo: Number(row["rank_to"]),
  kind: row["kind"] as PrizeKind,
  name: textOf(row["name_ar"], row["name_en"]),
  description: textOf(row["description_ar"], row["description_en"]),
});

/** What the audit log keeps of a rank prize: its settings, never who won it. */
const auditView = (prize: PrizeRecord): Record<string, unknown> => ({
  rankFrom: prize.rankFrom,
  rankTo: prize.rankTo,
  kind: prize.kind,
  nameAr: prize.name.ar,
  nameEn: prize.name.en,
  descriptionAr: prize.description.ar,
  descriptionEn: prize.description.en,
});

type Merged = Readonly<{
  rankFrom: number;
  rankTo: number;
  name: Bilingual;
  description: Bilingual;
}>;

/** One text after an edit: undefined keeps a language, blank clears it. */
const pick = (text: Text | undefined, base: Bilingual): Bilingual =>
  text === undefined
    ? base
    : {
        ar: text.ar === undefined ? base.ar : blankToNull(text.ar),
        en: text.en === undefined ? base.en : blankToNull(text.en),
      };

/** The prize after an edit, or the first field that is wrong. */
function merge(current: Merged, input: PrizeInput): Merged | ResultsRefusal {
  const merged = {
    rankFrom: input.rankFrom ?? current.rankFrom,
    rankTo: input.rankTo ?? current.rankTo,
    name: pick(input.name, current.name),
    description: pick(input.description, current.description),
  };
  if (merged.rankFrom > merged.rankTo) {
    return { kind: "invalid", field: "rankTo" };
  }
  if (merged.name.ar === null && merged.name.en === null) {
    return { kind: "invalid", field: "name" };
  }
  return merged;
}

const isRefusal = (value: Merged | ResultsRefusal): value is ResultsRefusal => "kind" in value;

/** Opens the event for a prize write: not found for a stranger, refused once archived. */
async function openEvent(
  client: PoolClient,
  context: Actor,
  eventId: string,
): Promise<ResultsRefusal | undefined> {
  const event = await lockBuilderEvent(client, context.organizerId, eventId);
  if (event === undefined) {
    return { kind: "not_found" };
  }
  return event.statusNow === "archived" ? { kind: "event_archived" } : undefined;
}

export type PrizeSettings = Readonly<{
  rankPrizes: boolean;
  rules: Bilingual;
  prizes: readonly PrizeRecord[];
}>;

/** The event's rank prizes, the switch and the organizer's rules text (FR-519). Owners and editors. */
export function listPrizes(
  deps: ResultsDeps,
  context: Actor,
  eventId: string,
): Promise<ResultsDone<PrizeSettings>> {
  return asTeam(deps, context, async (client) => {
    const { rows: events } = await client.query(
      "SELECT rank_prizes, rules_ar, rules_en FROM event WHERE organizer_id = $1 AND id = $2",
      [context.organizerId, eventId],
    );
    const event = events[0];
    if (event === undefined) {
      return { kind: "not_found" };
    }
    const { rows } = await client.query<PrizeRow>(
      `SELECT ${PRIZE_COLUMNS} FROM rank_prize WHERE event_id = $1 AND status = 'active' ORDER BY rank_from`,
      [eventId],
    );
    return done({
      rankPrizes: event["rank_prizes"] === true,
      rules: textOf(event["rules_ar"], event["rules_en"]),
      prizes: rows.map(prizeOf),
    });
  });
}

/** Adds a prize for a rank range (FR-519). The database refuses overlaps and, once live, any new prize. */
export function createPrize(
  deps: ResultsDeps,
  context: Actor,
  eventId: string,
  input: PrizeInput & Readonly<{ kind: PrizeKind; rankFrom: number; rankTo: number }>,
  caller: Caller,
): Promise<ResultsDone<PrizeRecord>> {
  return asTeam(deps, context, async (client) => {
    const closed = await openEvent(client, context, eventId);
    if (closed !== undefined) {
      return closed;
    }
    const empty = { ar: null, en: null };
    const fields = merge(
      { rankFrom: input.rankFrom, rankTo: input.rankTo, name: empty, description: empty },
      input,
    );
    if (isRefusal(fields)) {
      return fields;
    }
    const { rows: counted } = await client.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM rank_prize WHERE event_id = $1 AND status = 'active'",
      [eventId],
    );
    if ((counted[0]?.n ?? 0) >= PRIZE_LIMIT) {
      return { kind: "limit_reached", limit: PRIZE_LIMIT };
    }
    const { rows } = await client.query<PrizeRow>(
      `INSERT INTO rank_prize (event_id, kind, rank_from, rank_to, name_ar, name_en, description_ar, description_en)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${PRIZE_COLUMNS}`,
      [
        eventId,
        input.kind,
        fields.rankFrom,
        fields.rankTo,
        fields.name.ar,
        fields.name.en,
        fields.description.ar,
        fields.description.en,
      ],
    );
    const made = prizeOf(rows[0] as PrizeRow);
    await audit(client, context, caller, {
      action: "rank_prize.create",
      eventId,
      target: { type: "rank_prize", id: made.id },
      after: auditView(made),
    });
    return done(made);
  });
}

async function readPrize(client: PoolClient, eventId: string, id: string) {
  const { rows } = await client.query<PrizeRow>(
    `SELECT ${PRIZE_COLUMNS} FROM rank_prize WHERE event_id = $1 AND id = $2 AND status = 'active' FOR UPDATE`,
    [eventId, id],
  );
  return rows[0] === undefined ? undefined : prizeOf(rows[0]);
}

/** Edits a prize. Once the event is live only its names and descriptions may change (the database checks). */
export function updatePrize(
  deps: ResultsDeps,
  context: Actor,
  target: Readonly<{ eventId: string; id: string }>,
  input: PrizeInput,
  caller: Caller,
): Promise<ResultsDone<PrizeRecord>> {
  return asTeam(deps, context, async (client) => {
    const closed = await openEvent(client, context, target.eventId);
    if (closed !== undefined) {
      return closed;
    }
    const current = await readPrize(client, target.eventId, target.id);
    if (current === undefined) {
      return { kind: "not_found" };
    }
    const fields = merge(current, input);
    if (isRefusal(fields)) {
      return fields;
    }
    const { rows } = await client.query<PrizeRow>(
      `UPDATE rank_prize SET rank_from = $3, rank_to = $4, name_ar = $5, name_en = $6, description_ar = $7,
              description_en = $8
       WHERE event_id = $1 AND id = $2 RETURNING ${PRIZE_COLUMNS}`,
      [
        target.eventId,
        target.id,
        fields.rankFrom,
        fields.rankTo,
        fields.name.ar,
        fields.name.en,
        fields.description.ar,
        fields.description.en,
      ],
    );
    const after = prizeOf(rows[0] as PrizeRow);
    const diff = changes(auditView(current), auditView(after));
    if (Object.keys(diff.after).length > 0) {
      await audit(client, context, caller, {
        action: "rank_prize.update",
        eventId: target.eventId,
        target: { type: "rank_prize", id: target.id },
        ...diff,
      });
    }
    return done(after);
  });
}

/** Removes a prize before the event goes live. */
export function removePrize(
  deps: ResultsDeps,
  context: Actor,
  target: Readonly<{ eventId: string; id: string }>,
  caller: Caller,
): Promise<ResultsDone<null>> {
  return asTeam(deps, context, async (client) => {
    const closed = await openEvent(client, context, target.eventId);
    if (closed !== undefined) {
      return closed;
    }
    const current = await readPrize(client, target.eventId, target.id);
    if (current === undefined) {
      return { kind: "not_found" };
    }
    await client.query("UPDATE rank_prize SET status = 'removed' WHERE id = $1", [target.id]);
    await audit(client, context, caller, {
      action: "rank_prize.remove",
      eventId: target.eventId,
      target: { type: "rank_prize", id: target.id },
      before: auditView(current),
    });
    return done(null);
  });
}

/** Switches rank prizes (locked once live) and writes the organizer's rules text (always editable). */
export function updatePrizeSettings(
  deps: ResultsDeps,
  context: Actor,
  eventId: string,
  input: Readonly<{ rankPrizes?: boolean | undefined; rules?: Text | undefined }>,
  caller: Caller,
): Promise<ResultsDone<Readonly<{ rankPrizes: boolean; rules: Bilingual }>>> {
  return asTeam(deps, context, async (client) => {
    const closed = await openEvent(client, context, eventId);
    if (closed !== undefined) {
      return closed;
    }
    const { rows } = await client.query(
      "SELECT rank_prizes, rules_ar, rules_en FROM event WHERE id = $1",
      [eventId],
    );
    const before = {
      rankPrizes: rows[0]?.["rank_prizes"] === true,
      rules: textOf(rows[0]?.["rules_ar"], rows[0]?.["rules_en"]),
    };
    const rules = input.rules;
    const after = {
      rankPrizes: input.rankPrizes ?? before.rankPrizes,
      rules: {
        ar: rules?.ar === undefined ? before.rules.ar : blankToNull(rules.ar),
        en: rules?.en === undefined ? before.rules.en : blankToNull(rules.en),
      },
    };
    await client.query(
      "UPDATE event SET rank_prizes = $2, rules_ar = $3, rules_en = $4 WHERE id = $1",
      [eventId, after.rankPrizes, after.rules.ar, after.rules.en],
    );
    for (const [action, was, now] of [
      ["event.rank_prizes", { on: before.rankPrizes }, { on: after.rankPrizes }],
      ["event.rules", { ...before.rules }, { ...after.rules }],
    ] as const) {
      const diff = changes(was, now);
      if (Object.keys(diff.after).length > 0) {
        await audit(client, context, caller, {
          action,
          eventId,
          target: { type: "event", id: eventId },
          ...diff,
        });
      }
    }
    return done(after);
  });
}

export type ResultsState = "not_ended" | "open" | "confirmed" | "revealed";

export type Place = Readonly<{
  rank: number;
  enrollmentId: string;
  /** `username` is null for a deleted account: the place keeps its rank and score (FR-1739). */
  player: Readonly<{ username: string | null; avatar: string }>;
  score: number;
  openFlags: number;
  flagKinds: readonly string[];
  prize: Readonly<{ id: string; kind: PrizeKind; name: Bilingual }> | null;
  /** The prize's redemption status after the reveal (reserved, handed_over, cancelled, expired). */
  prizeStatus: string | null;
}>;

export type ResultsView = Readonly<{
  state: ResultsState;
  rankPrizes: boolean;
  endsAt: string | null;
  confirmedAt: string | null;
  revealedAt: string | null;
  claimUntil: string | null;
  defaultClaimUntil: string | null;
  places: readonly Place[];
}>;

/** A place's name: null for a deleted account (T-217), never the text "null". */
const usernameOf = (row: Readonly<Record<string, unknown>>): string | null =>
  row["username"] === null ? null : String(row["username"]);

const placeOf = (row: Readonly<Record<string, unknown>>): Place => ({
  rank: Number(row["rank"]),
  enrollmentId: String(row["enrollment_id"]),
  player: { username: usernameOf(row), avatar: String(row["avatar"]) },
  score: Number(row["score"]),
  openFlags: Number(row["open_flags"]),
  flagKinds: (row["flag_kinds"] as string[] | null) ?? [],
  prize:
    row["prize_id"] === null
      ? null
      : {
          id: String(row["prize_id"]),
          kind: row["prize_kind"] as PrizeKind,
          name: textOf(row["prize_name_ar"], row["prize_name_en"]),
        },
  prizeStatus: typeof row["redemption_status"] === "string" ? row["redemption_status"] : null,
});

async function viewOf(client: PoolClient, eventId: string): Promise<ResultsView> {
  const { rows: states } = await client.query("SELECT * FROM results_state($1)", [eventId]);
  const { rows } = await client.query("SELECT * FROM results_places($1)", [eventId]);
  const state = states[0] ?? {};
  return {
    state: state["state"] as ResultsState,
    rankPrizes: state["rank_prizes"] === true,
    endsAt: iso(state["ends_at"]),
    confirmedAt: iso(state["confirmed_at"]),
    revealedAt: iso(state["revealed_at"]),
    claimUntil: iso(state["claim_until"]),
    defaultClaimUntil: iso(state["default_claim_until"]),
    places: rows.map(placeOf),
  };
}

/** Where the results stand and the places with their open flags (FR-1719). Owners and editors. */
export function readResults(
  deps: ResultsDeps,
  context: Actor,
  eventId: string,
): Promise<ResultsDone<ResultsView>> {
  return asTeam(deps, context, async (client) => done(await viewOf(client, eventId)));
}

/**
 * The owner confirms the places they saw (FR-1719, ADR-163): `expected` is their enrollment ids in rank order. A list
 * that is no longer current is refused, so the owner confirms exactly what they reviewed.
 */
export function confirmResults(
  deps: ResultsDeps,
  context: Actor,
  request: Readonly<{ eventId: string; expected: readonly string[]; requestId: string }>,
): Promise<ResultsDone<ResultsView>> {
  return asTeam(deps, context, async (client) => {
    const { rows } = await client.query<{ outcome: string }>(
      "SELECT confirm_results($1, $2, $3) AS outcome",
      [request.eventId, request.expected, request.requestId],
    );
    if (rows[0]?.outcome === "not_owner") {
      return { kind: "owner_only" };
    }
    return done(await viewOf(client, request.eventId));
  });
}

/** The owner reveals the winners with the claim deadline they chose (FR-520, FR-521, ADR-162, ADR-164). */
export function revealResults(
  deps: ResultsDeps,
  context: Actor,
  request: Readonly<{ eventId: string; claimUntil: Date; requestId: string }>,
): Promise<ResultsDone<ResultsView>> {
  return asTeam(deps, context, async (client) => {
    const { rows } = await client.query<{ outcome: string }>(
      "SELECT reveal_results($1, $2, $3) AS outcome",
      [request.eventId, request.claimUntil, request.requestId],
    );
    if (rows[0]?.outcome === "not_owner") {
      return { kind: "owner_only" };
    }
    return done(await viewOf(client, request.eventId));
  });
}

export type PlayerPlace = Readonly<{
  rank: number;
  /** `username` is null for a deleted account (FR-1739). */
  player: Readonly<{ username: string | null; avatar: string }>;
  score: number;
  prize: Readonly<{ kind: PrizeKind; name: Bilingual }> | null;
  mine: boolean;
}>;

export type MyPrize = Readonly<{
  rank: number;
  prize: Readonly<{ kind: PrizeKind; name: Bilingual }>;
  redemptionId: string;
  status: string;
  claimUntil: string | null;
}>;

export type PlayerResults = Readonly<{
  revealed: boolean;
  places: readonly PlayerPlace[];
  /** The caller's own prize, when they won one. */
  me: MyPrize | null;
}>;

/** Reads the revealed results as a member sees them (`event_results`); nothing before the reveal or for a stranger. */
export async function resultsFor(client: PoolClient, eventId: string): Promise<PlayerResults> {
  const { rows } = await client.query("SELECT * FROM event_results($1)", [eventId]);
  const places = rows.map((row) => ({
    rank: Number(row["rank"]),
    player: { username: usernameOf(row), avatar: String(row["avatar"]) },
    score: Number(row["score"]),
    prize:
      row["prize_kind"] === null
        ? null
        : {
            kind: row["prize_kind"] as PrizeKind,
            name: textOf(row["prize_name_ar"], row["prize_name_en"]),
          },
    mine: row["mine"] === true,
  }));
  const mine = rows.find((row) => row["mine"] === true && row["redemption_id"] !== null);
  const myPlace = places.find((place) => place.mine);
  return {
    revealed: rows.length > 0,
    places,
    me:
      mine === undefined || myPlace?.prize === null || myPlace === undefined
        ? null
        : {
            rank: myPlace.rank,
            prize: myPlace.prize,
            redemptionId: String(mine["redemption_id"]),
            status: String(mine["redemption_status"]),
            claimUntil: iso(mine["claim_until"]),
          },
  };
}

/** The member's view of the revealed results (FR-520, FR-1718). */
export function playerResults(
  deps: ResultsDeps,
  playerId: string,
  eventId: string,
): Promise<PlayerResults> {
  return withConnection(deps.pool, (client) =>
    withRequestContext(client, { playerId }, () => resultsFor(client, eventId)),
  );
}

/** The database's rules data (`rules_of`, migration 0034) as the shared rules builder takes it. */
export function rulesDataOf(json: Readonly<Record<string, unknown>>): RulesData {
  const prizes = (json["prizes"] as Readonly<Record<string, unknown>>[] | null) ?? [];
  const claim = json["claimUntil"];
  return {
    rankPrizes: json["rankPrizes"] === true,
    prizes: prizes.map((prize) => ({
      rankFrom: Number(prize["rankFrom"]),
      rankTo: Number(prize["rankTo"]),
      name: textOf(prize["nameAr"], prize["nameEn"]),
    })),
    organizer: String(json["organizer"]),
    endsAt: new Date(String(json["endsAt"])),
    timezone: String(json["timezone"]),
    claimUntil: typeof claim === "string" ? new Date(claim) : null,
    text: textOf(json["rulesAr"], json["rulesEn"]),
  };
}

/** The official rules for a member in the app; undefined for anyone else. */
export function memberRules(
  deps: ResultsDeps,
  playerId: string,
  eventId: string,
): Promise<OfficialRules | null | undefined> {
  return withConnection(deps.pool, (client) =>
    withRequestContext(client, { playerId }, async () => {
      const { rows } = await client.query<{ rules: Record<string, unknown> | null }>(
        "SELECT event_rules($1) AS rules",
        [eventId],
      );
      const json = rows[0]?.rules ?? null;
      return json === null ? undefined : officialRules(rulesDataOf(json));
    }),
  );
}
