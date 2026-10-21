import { parseQuestConfig, toInstant, type QuestType } from "@questify/shared";
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
  type QuestRecord,
} from "#src/quests/store";

/** Caps per event (T-103 plan, decision 9). */
export const BUILDER_LIMITS = { categories: 30, quests: 300 } as const;

type Text = Readonly<{ ar?: string | undefined; en?: string | undefined }>;

export type CategoryInput = Readonly<{ name?: Text | undefined }>;

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
}>;

export type QuestField =
  | "categoryId"
  | "type"
  | "title"
  | "points"
  | "opensAt"
  | "closesAt"
  | "config";

/** The refusals every builder action may give. */
export type Refused =
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "event_closed" }>
  | Readonly<{ kind: "confirm_required" }>
  | Readonly<{ kind: "invalid"; field: QuestField | "name" | "to" }>
  | Readonly<{ kind: "limit_reached"; limit: number }>
  | Readonly<{ kind: "order_stale" }>
  | Readonly<{ kind: "last_category" }>
  | Readonly<{ kind: "category_not_empty"; quests: number }>
  /** Players completed it: its points are history (T-105); hide it instead, until T-604 offers keep or remove. */
  | Readonly<{ kind: "has_completions" }>;

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

const blankToNull = (text: string | undefined): string | null => {
  const trimmed = text?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
};

export const bilingual = (text: Text | undefined, current: Bilingual): Bilingual =>
  text === undefined ? current : { ar: blankToNull(text.ar), en: blankToNull(text.en) };

export const NO_TEXT: Bilingual = { ar: null, en: null };

export const done = <T>(value: T): Done<T> => ({ kind: "done", value });

/** A time in the event's zone: undefined keeps the current one, null clears it, text that is not a time is refused. */
function timeOf(
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
): QuestFields | Readonly<{ kind: "invalid"; field: QuestField }> {
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
  return {
    // Stryker disable next-line StringLiteral: a create always names its category (the route requires it)
    categoryId: input.categoryId ?? current?.categoryId ?? "",
    title,
    description: bilingual(input.description, current?.description ?? NO_TEXT),
    points,
    repeatCap: input.repeatCap ?? current?.repeatCap ?? 1,
    opensAt,
    closesAt,
    visible: input.visible ?? current?.visible ?? true,
    config,
  };
}

export const isInvalid = (
  value: object,
): value is Readonly<{ kind: "invalid"; field: QuestField }> => "kind" in value;

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
    ...(code === undefined ? {} : { entryCode: "set" }),
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
    // A player completed the quest between the check and the delete: its points are history (migration 0012).
    const pg = error as { code?: string; table?: string };
    if (pg.code === "23503" && pg.table === "quest_completion") {
      return { kind: "has_completions" };
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
    target: { type: "category" | "quest" | "event"; id: string };
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

/** True when a player completed any of these quests (their points are history, migration 0012). */
export async function anyCompletions(
  client: PoolClient,
  where: Readonly<{ questId: string } | { categoryId: string }>,
): Promise<boolean> {
  const { rowCount } =
    "questId" in where
      ? await client.query("SELECT 1 FROM quest_completion WHERE quest_id = $1 LIMIT 1", [
          where.questId,
        ])
      : await client.query(
          "SELECT 1 FROM quest_completion c JOIN quest q ON q.id = c.quest_id WHERE q.category_id = $1 LIMIT 1",
          [where.categoryId],
        );
  return rowCount === 1;
}
