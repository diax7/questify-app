import {
  PLACED_QUEST_TYPES,
  QUEST_TYPES,
  isLivePoll,
  parseQuestConfig,
  parseVerification,
  toInstant,
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
  /** Shown to players only inside its window (T-307): launched from a draft, or scheduled with both times. */
  flash?: boolean | undefined;
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
  /** A live poll can never be a flash quest (T-307). */
  | "flash"
  /** A shown flash quest needs both times, 1 to 1,440 minutes apart (T-307, CTO 1). */
  | "flashWindow"
  /** A launched flash quest stays one (T-307, CTO 10). */
  | "flashLaunched";

/** The refusals every builder action may give. */
export type Refused =
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "event_closed" }>
  | Readonly<{ kind: "confirm_required" }>
  | Readonly<{ kind: "invalid"; field: QuestField | CategoryField }>
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
  /** A community goal counts this quest or category (T-306b): change or delete the goal first. */
  | Readonly<{ kind: "goal_in_use" }>
  /** A boost doubles this category (T-307): it stays while the boost does. */
  | Readonly<{ kind: "boost_in_use" }>
  /** The quest item named is removed or another event's (T-304d). */
  | Readonly<{ kind: "invalid_item" }>
  /**
   * A live poll's `live` setting, choices or minutes once sent or voted on, or `live` added to a vote players can see
   * (T-306, migration 0052): `field` names which.
   */
  | Readonly<{ kind: "poll_locked"; field: string }>;

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

type Window = Readonly<{ opensAt: Date | null; closesAt: Date | null; visible: boolean }>;

/**
 * A live poll's window is Send's and Close's (T-306, ADR-220): a draft stays hidden with no times, a sent poll keeps
 * the window it was sent with, whatever the input says. Every other quest takes the input's.
 */
function windowOf(live: boolean, current: QuestRecord | undefined, asked: Window): Window {
  if (!live) {
    return asked;
  }
  return current?.pollSentAt === null || current === undefined
    ? { opensAt: null, closesAt: null, visible: false }
    : { opensAt: current.opensAt, closesAt: current.closesAt, visible: current.visible };
}

/** A flash quest's shortest and longest shown window (T-307, ADR-231). */
export const FLASH_WINDOW_MS = { min: 60_000, max: 1440 * 60_000 } as const;

/** Whether a flash quest runs or ran: launched, or its scheduled window has started. */
const flashStarted = (current: QuestRecord | undefined, now: Date): current is QuestRecord =>
  current?.flash === true &&
  (current.flashLaunchedAt !== null ||
    (current.visible && current.opensAt !== null && current.opensAt <= now));

/**
 * A flash quest's window (T-307, ADR-231): once launched, or once a scheduled window has started, it is Launch's and
 * End now's, whatever the input says; otherwise a shown one needs both times, 1 to 1,440 minutes apart.
 */
export function flashWindowOf(
  current: QuestRecord | undefined,
  asked: Window,
  now: Date,
): Window | "flashWindow" {
  if (flashStarted(current, now)) {
    return { opensAt: current.opensAt, closesAt: current.closesAt, visible: current.visible };
  }
  if (!asked.visible) {
    return asked;
  }
  const length =
    asked.opensAt === null || asked.closesAt === null
      ? 0
      : asked.closesAt.getTime() - asked.opensAt.getTime();
  return length >= FLASH_WINDOW_MS.min && length <= FLASH_WINDOW_MS.max ? asked : "flashWindow";
}

/**
 * Whether the quest is flash after this input, or the field that refuses it: never a live poll, and it stays flash once
 * launched or once its scheduled window has started (CTO code review 2).
 */
function flashOf(
  current: QuestRecord | undefined,
  input: QuestInput,
  live: boolean,
  now: Date,
): boolean | "flash" | "flashLaunched" {
  const flash = input.flash ?? current?.flash ?? false;
  if (flash && live) {
    return "flash";
  }
  return !flash && flashStarted(current, now) ? "flashLaunched" : flash;
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
  now: Date = new Date(),
):
  | QuestFields
  | Readonly<{ kind: "invalid"; field: QuestField }>
  | Readonly<{ kind: "submission_kind_unavailable"; asked: "photo" | "video" }> {
  const asked = type === "submission" ? unavailableSubmissionKind(input.config) : undefined;
  if (asked !== undefined) {
    return { kind: "submission_kind_unavailable", asked };
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
  const live = isLivePoll(type, config);
  const flash = flashOf(current, input, live, now);
  if (typeof flash === "string") {
    return { kind: "invalid", field: flash };
  }
  const wanted = {
    opensAt,
    closesAt,
    // A new flash quest without both times is a draft, launched later.
    visible:
      input.visible ?? current?.visible ?? (!flash || (opensAt !== null && closesAt !== null)),
  };
  const window = flash ? flashWindowOf(current, wanted, now) : windowOf(live, current, wanted);
  if (window === "flashWindow") {
    return { kind: "invalid", field: "flashWindow" };
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
    ...window,
    config,
    verification,
    itemId: input.itemId === undefined ? (current?.itemId ?? null) : input.itemId,
    place,
    flash,
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
    flash: quest.flash,
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
    const pg = error as { code?: string; table?: string; detail?: string };
    if (pg.code === LOCKED) {
      return { kind: "quest_locked" };
    }
    // A live poll's settings once sent or voted on (migration 0052).
    if (pg.code === "PL409") {
      return { kind: "poll_locked", field: pg.detail ?? "live" };
    }
    // A flash quest launched, or its window started, between the read and the write (migration 0055).
    if (pg.code === "FL409") {
      return { kind: "invalid", field: "flashWindow" };
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
    // A community goal counts the quest or category (migration 0053), or a step unlocks it (migration 0054).
    if (pg.code === "23503" && (pg.table === "community_goal" || pg.table === "community_step")) {
      return { kind: "goal_in_use" };
    }
    // A boost doubles the category (migration 0055).
    if (pg.code === "23503" && pg.table === "boost") {
      return { kind: "boost_in_use" };
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
