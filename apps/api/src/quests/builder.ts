import {
  PLACED_QUEST_TYPES,
  QUEST_TYPES,
  parseQuestConfig,
  parseVerification,
  toInstant,
  unavailableGame,
  unavailableSubmissionKind,
  type QuestType,
} from "@questify/shared";
import type { Pool, PoolClient } from "pg";
import { recordAudit } from "#src/audit/record";
import type { Caller } from "#src/auth/sign-in";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { Actor } from "#src/events/events";
import {
  listCategories,
  listQuests,
  lockBuilderEvent,
  type Bilingual,
  type BuilderEvent,
  type CategoryRecord,
  type QuestFields,
  type QuestPlace,
  type QuestRecord,
} from "#src/quests/store";

/** Caps per event (T-103 plan, decision 9). */
export const BUILDER_LIMITS = { categories: 30, quests: 300 } as const;

type Text = Readonly<{ ar?: string | undefined; en?: string | undefined }>;

/** A category's name and rules; times as the event's wall clock (`YYYY-MM-DDTHH:mm`), null clears one. */
export type CategoryInput = Readonly<{
  name?: Text | undefined;
  orderMode?: "any" | "in_order" | undefined;
  opensAt?: string | null | undefined;
  unlockAfter?: string | null | undefined;
  completionBonus?: number | undefined;
  refresh?: "none" | "daily" | "weekly" | undefined;
  hidden?: boolean | undefined;
  /** The quest item its bonus gives (T-304d); null clears it. */
  itemId?: string | null | undefined;
}>;

export type CategoryField = "name" | "to" | "opensAt" | "unlockAfter" | "refresh";

/** Times as the event's wall clock (`YYYY-MM-DDTHH:mm`), read in its zone; null clears one. */
export type QuestInput = Readonly<{
  categoryId?: string | undefined;
  title?: Text | undefined;
  description?: Text | undefined;
  points?: number | undefined;
  repeatCap?: number | undefined;
  opensAt?: string | null | undefined;
  closesAt?: string | null | undefined;
  visible?: boolean | undefined;
  config?: unknown;
  verification?: unknown;
  /** A passport's steps as the full list in order (T-304b): an existing step by its id, a new one without. */
  steps?: readonly Readonly<{ id?: string | undefined; name: Text }>[] | undefined;
  /** The quest item its first completion gives (T-304d); null clears it. */
  itemId?: string | null | undefined;
  /** Its place on a spot type (T-303b); null clears it; a location quest must keep one. */
  place?: QuestPlace | null | undefined;
}>;

export type QuestField =
  | "categoryId"
  | "type"
  | "title"
  | "points"
  | "opensAt"
  | "closesAt"
  | "config"
  | "verification"
  | "needed"
  | "steps"
  | "place"
  | "dailyCap"
  | "game";

/** The refusals every builder action may give. */
export type Refused =
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "event_closed" }>
  | Readonly<{ kind: "confirm_required" }>
  /** `reason` is `not_available` for a game this version cannot play yet (catch, tap rush: T-305c). */
  | Readonly<{ kind: "invalid"; field: QuestField | CategoryField; reason?: "not_available" }>
  | Readonly<{ kind: "limit_reached"; limit: number }>
  | Readonly<{ kind: "order_stale" }>
  | Readonly<{ kind: "last_category" }>
  | Readonly<{ kind: "category_not_empty"; quests: number }>
  /** Other categories unlock after this one (FR-235): change them first. */
  | Readonly<{ kind: "category_in_use"; categories: readonly Bilingual[] }>
  /** Players completed it: its points are history (T-105); hide it instead, until T-604 offers keep or remove. */
  | Readonly<{ kind: "has_completions" }>
  /** Only rehearsal accounts completed it: erase the rehearsal first (T-211). */
  | Readonly<{ kind: "rehearsal_data" }>
  /** A submission quest asked for photos (T-301b) or video (never in v1, FR-1006). */
  | Readonly<{ kind: "submission_kind_unavailable"; asked: "photo" | "video" }>
  /** Players voted or started the quiz: only its text may change (ADR-194, migration 0041). */
  | Readonly<{ kind: "quest_locked" }>
  /** Players stamped this passport step (T-304b): it stays. */
  | Readonly<{ kind: "step_in_use" }>
  /** The quest item named is removed or another event's (T-304d). */
  | Readonly<{ kind: "invalid_item" }>;

export type Done<T> = Readonly<{ kind: "done"; value: T }> | Refused;

export type BuilderView = Readonly<{
  /** The quest pinned as Up next (FR-1748), or null. */
  focusQuestId: string | null;
  categories: readonly (CategoryRecord & { quests: readonly QuestRecord[] })[];
}>;

export type CategoryDelete = Readonly<{
  quests?: "move" | "delete" | undefined;
  to?: string | undefined;
}>;

/** What every change carries: whether the person confirmed a change to a live event (FR-1007, ADR-063). */
export type Change = Readonly<{ confirm?: boolean | undefined }>;

export type BuilderDeps = Readonly<{ pool: Pool }>;

const CLOSED = "QE409";
const LOCKED = "QL409";
/**
 * Rows that keep a played quest or category: its completions, submissions, votes, quiz attempts and survey responses;
 * a category's bonus rows and the quest items it gave or missed (T-304d: an item-only bonus has no ledger entry).
 */
const PLAYED_TABLES = new Set([
  "quest_completion",
  "submission",
  "quest_vote",
  "quiz_attempt",
  "survey_response",
  "category_bonus",
  "redemption",
  "quest_item_miss",
]);

const blankToNull = (text: string | undefined): string | null => {
  const trimmed = text?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
};

export const bilingual = (text: Text | undefined, current: Bilingual): Bilingual =>
  text === undefined ? current : { ar: blankToNull(text.ar), en: blankToNull(text.en) };

export const NO_TEXT: Bilingual = { ar: null, en: null };

export const done = <T>(value: T): Done<T> => ({ kind: "done", value });

/** A time in the event's zone: undefined keeps the current one, null clears it, text that is not a time is refused. */
export function timeOf(
  input: string | null | undefined,
  current: Date | null,
  timeZone: string,
): Date | null | "invalid" {
  if (input === undefined) {
    return current;
  }
  if (input === null) {
    return null;
  }
  try {
    return toInstant(input, timeZone);
  } catch {
    return "invalid";
  }
}

/**
 * A quest's fields after this input, from what is stored (or nothing, for a new quest), checked as one whole. The
 * config is validated against the quest's type; a config left out keeps the stored one.
 */
export function mergeQuest(
  current: QuestRecord | undefined,
  type: QuestType,
  input: QuestInput,
  timeZone: string,
):
  | QuestFields
  | Readonly<{ kind: "invalid"; field: QuestField; reason?: "not_available" }>
  | Readonly<{ kind: "submission_kind_unavailable"; asked: "photo" | "video" }> {
  const asked = type === "submission" ? unavailableSubmissionKind(input.config) : undefined;
  if (asked !== undefined) {
    return { kind: "submission_kind_unavailable", asked };
  }
  // Catch and tap rush are named in FR-1804 and built in T-305c (ADR-214), as photo submissions wait (ADR-183).
  if (type === "game" && unavailableGame(input.config) !== undefined) {
    return { kind: "invalid", field: "game", reason: "not_available" };
  }
  const title = bilingual(input.title, current?.title ?? NO_TEXT);
  if (title.ar === null && title.en === null) {
    return { kind: "invalid", field: "title" };
  }
  const points = input.points ?? current?.points;
  if (points === undefined) {
    return { kind: "invalid", field: "points" };
  }
  const opensAt = timeOf(input.opensAt, current?.opensAt ?? null, timeZone);
  if (opensAt === "invalid") {
    return { kind: "invalid", field: "opensAt" };
  }
  const closesAt = timeOf(input.closesAt, current?.closesAt ?? null, timeZone);
  if (closesAt === "invalid" || (closesAt !== null && opensAt !== null && closesAt <= opensAt)) {
    return { kind: "invalid", field: "closesAt" };
  }
  const config =
    input.config === undefined && current !== undefined
      ? current.config
      : parseQuestConfig(type, input.config ?? {});
  if (config === undefined) {
    return { kind: "invalid", field: "config" };
  }
  const verification = parseVerification(type, input.verification, current?.verification);
  if (verification === undefined) {
    return { kind: "invalid", field: "verification" };
  }
  const place = input.place === undefined ? (current?.place ?? null) : input.place;
  if (
    (place !== null && !PLACED_QUEST_TYPES.includes(type)) ||
    (place === null && type === "location")
  ) {
    return { kind: "invalid", field: "place" };
  }
  // A vote, a quiz, a survey or a share is played once (ADR-191, ADR-198, ADR-199).
  const repeatCap = QUEST_TYPES[type].oneTry ? 1 : (input.repeatCap ?? current?.repeatCap ?? 1);
  // A meet quest's day can never pay more meetings than its whole life (ADR-210).
  if (type === "meet" && Number(config["dailyCap"]) > repeatCap) {
    return { kind: "invalid", field: "dailyCap" };
  }
  return {
    // Stryker disable next-line StringLiteral: a create always names its category (the route requires it)
    categoryId: input.categoryId ?? current?.categoryId ?? "",
    title,
    description: bilingual(input.description, current?.description ?? NO_TEXT),
    points,
    repeatCap,
    opensAt,
    closesAt,
    visible: input.visible ?? current?.visible ?? true,
    config,
    verification,
    itemId: input.itemId === undefined ? (current?.itemId ?? null) : input.itemId,
    place,
  };
}

export const isInvalid = (
  value: object,
): value is
  | Readonly<{ kind: "invalid"; field: QuestField }>
  | Readonly<{ kind: "submission_kind_unavailable"; asked: "photo" | "video" }> => "kind" in value;

/**
 * What an audit entry keeps of a quest. An entry code is a secret, and the audit refuses any `code` key: the entry
 * says only that one is set (`entryCode`), and an edit that changes it says so (`codeChanged`).
 */
export function auditView(quest: QuestRecord): Record<string, unknown> {
  const { code, ...config } = quest.config;
  return {
    categoryId: quest.categoryId,
    type: quest.type,
    titleAr: quest.title.ar,
    titleEn: quest.title.en,
    descriptionAr: quest.description.ar,
    descriptionEn: quest.description.en,
    points: quest.points,
    repeatCap: quest.repeatCap,
    opensAt: quest.opensAt?.toISOString() ?? null,
    closesAt: quest.closesAt?.toISOString() ?? null,
    visible: quest.visible,
    config,
    verification: quest.verification,
    itemId: quest.itemId,
    place: quest.place,
    ...(code === undefined ? {} : { entryCode: "set" }),
    ...(quest.type === "passport"
      ? {
          steps: quest.steps.map((step) => ({
            id: step.id,
            nameAr: step.name.ar,
            nameEn: step.name.en,
          })),
        }
      : {}),
  };
}

/** The audit's before and after for an edit, with a changed entry code noted but never written. */
export function questChanges(before: QuestRecord, after: QuestRecord) {
  const diff = changes(auditView(before), auditView(after));
  return before.config["code"] === after.config["code"]
    ? diff
    : {
        before: { ...diff.before, codeChanged: false },
        after: { ...diff.after, codeChanged: true },
      };
}

/** Only the fields that changed, before and after. */
export function changes(before: Record<string, unknown>, after: Record<string, unknown>) {
  const keys = Object.keys(after).filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
  return {
    before: Object.fromEntries(keys.map((key) => [key, before[key]])),
    after: Object.fromEntries(keys.map((key) => [key, after[key]])),
  };
}

type Work<T> = (client: PoolClient, event: BuilderEvent) => Promise<Done<T>>;

/**
 * Runs one builder action on the path's event, locked: not found outside the caller's reach, closed once the event has
 * ended, and, for a change to what players see, a confirmation while the event is live. Every action refuses before
 * its first write, so a refusal leaves nothing behind (a refusal is a normal return and commits; a new action must keep
 * this rule, or throw instead); the lock means a category checked here is still there when the
 * action writes.
 */
export async function withEvent<T>(
  deps: BuilderDeps,
  actor: Actor,
  eventId: string,
  gate: Readonly<{ change: Change | undefined }>,
  work: Work<T>,
): Promise<Done<T>> {
  try {
    return await withConnection(deps.pool, (client) =>
      withRequestContext(
        client,
        { organizerId: actor.organizerId, staffUserId: actor.staffUserId },
        async () => {
          const event = await lockBuilderEvent(client, actor.organizerId, eventId);
          if (event === undefined) {
            return { kind: "not_found" } as const;
          }
          // Stryker disable next-line ConditionalExpression,LogicalOperator,StringLiteral,BlockStatement: the database guard refuses the same writes (migration 0010); this answers before any work
          if (event.statusNow === "ended" || event.statusNow === "archived") {
            return { kind: "event_closed" } as const;
          }
          if (
            gate.change !== undefined &&
            event.statusNow === "live" &&
            gate.change.confirm !== true
          ) {
            return { kind: "confirm_required" } as const;
          }
          return work(client, event);
        },
      ),
    );
  } catch (error) {
    // Stryker disable all: reached only when the event ends between the check above and a write, milliseconds apart
    if ((error as { code?: string }).code === CLOSED) {
      return { kind: "event_closed" };
    }
    // Stryker restore all
    const pg = error as { code?: string; table?: string };
    if (pg.code === LOCKED) {
      return { kind: "quest_locked" };
    }
    // The categories' unlocks would go round in a circle (migration 0044).
    if (pg.code === "CU422") {
      return { kind: "invalid", field: "unlockAfter" };
    }
    // A played-once quest would sit in a refreshing category (migration 0046); the builder checks first.
    if (pg.code === "QT422") {
      return { kind: "invalid", field: "refresh" };
    }
    // The item was removed between the builder's check and the write (migration 0047).
    if (pg.code === "QI422") {
      return { kind: "invalid_item" };
    }
    // A player played the quest between the check and the delete: its points are history (migration 0012).
    if (pg.code === "23503" && pg.table !== undefined && PLAYED_TABLES.has(pg.table)) {
      return { kind: "has_completions" };
    }
    // A player stamped a passport step between the check and its delete (migration 0045).
    if (pg.code === "23503" && pg.table === "passport_stamp") {
      return { kind: "step_in_use" };
    }
    throw error;
  }
}

export const audit = (
  client: PoolClient,
  actor: Actor,
  caller: Caller,
  entry: Readonly<{
    action: string;
    eventId: string;
    target: {
      type: "category" | "quest" | "event" | "reward" | "rank_prize" | "quest_item";
      id: string;
    };
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
  }>,
) =>
  recordAudit(client, {
    actor: { type: "staff", id: actor.staffUserId },
    action: entry.action,
    target: entry.target,
    organizerId: actor.organizerId,
    eventId: entry.eventId,
    before: entry.before,
    after: entry.after,
    requestId: caller.requestId,
  });

async function view(
  client: PoolClient,
  eventId: string,
  focusQuestId: string | null,
): Promise<BuilderView> {
  const categories = await listCategories(client, eventId);
  const quests = await listQuests(client, eventId);
  return {
    focusQuestId,
    categories: categories.map((category) => ({
      ...category,
      quests: quests.filter((quest) => quest.categoryId === category.id),
    })),
  };
}

/** The event's categories with their quests, in order, for the builder (any status: an ended event is still read). */
export function readBuilder(
  deps: BuilderDeps,
  actor: Actor,
  eventId: string,
): Promise<Done<BuilderView>> {
  return withConnection(deps.pool, (client) =>
    withRequestContext(
      client,
      { organizerId: actor.organizerId, staffUserId: actor.staffUserId },
      async () => {
        const { rows } = await client.query<{ focus_quest_id: string | null }>(
          "SELECT focus_quest_id FROM event WHERE organizer_id = $1 AND id = $2",
          [actor.organizerId, eventId],
        );
        const event = rows[0];
        return event === undefined
          ? { kind: "not_found" }
          : done(await view(client, eventId, event.focus_quest_id));
      },
    ),
  );
}

/**
 * Who completed any of these quests, or sent a submission for one: `real` when a player did (their points are history,
 * migration 0012; a submission is kept with its review, migration 0040), `rehearsal` when only rehearsal accounts did
 * (erased with the rehearsal, T-211), `none` otherwise.
 */
export async function completionsOf(
  client: PoolClient,
  where: Readonly<{ questId: string } | { categoryId: string }>,
): Promise<"none" | "rehearsal" | "real"> {
  const quests =
    "questId" in where
      ? { sql: "q.id = $1", value: where.questId }
      : { sql: "q.category_id = $1", value: where.categoryId };
  const { rows } = await client.query<{ real: boolean | null }>(
    `WITH chosen AS (SELECT q.id FROM quest q WHERE ${quests.sql})
     SELECT bool_or(n.joined_via IS DISTINCT FROM 'rehearsal') AS real
     FROM (SELECT c.enrollment_id FROM quest_completion c WHERE c.quest_id IN (SELECT id FROM chosen)
           UNION ALL
           SELECT s.enrollment_id FROM submitters_of(ARRAY(SELECT id FROM chosen)) s) c
     JOIN enrollment n ON n.id = c.enrollment_id`,
    [quests.value],
  );
  const real = rows[0]?.real ?? null;
  return real === null ? "none" : real ? "real" : "rehearsal";
}
