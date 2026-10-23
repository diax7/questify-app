import { REFRESHING_QUEST_TYPES, isQuestType, type QuestType } from "@questify/shared";
import type { Caller } from "#src/auth/sign-in";
import type { Actor } from "#src/events/events";
import {
  BUILDER_LIMITS,
  completionsOf,
  audit,
  auditView,
  done,
  isInvalid,
  mergeQuest,
  questChanges,
  withEvent,
  type BuilderDeps,
  type Change,
  type Done,
  type QuestInput,
} from "#src/quests/builder";
import { passportSteps } from "#src/quests/passports";
import {
  activeItem,
  countRows,
  deleteRow,
  insertQuest,
  readCategory,
  readQuest,
  reorder,
  updateQuest as writeQuest,
  writeSteps,
  type QuestRecord,
} from "#src/quests/store";
import type { PoolClient } from "pg";

type Target = Readonly<{ eventId: string; id: string }>;

/** A newly named item must be this event's and not removed; keeping or clearing the current one is always allowed. */
async function itemAllowed(
  client: PoolClient,
  eventId: string,
  itemId: string | null,
  current: string | null,
): Promise<boolean> {
  return itemId === null || itemId === current || activeItem(client, eventId, itemId);
}

/**
 * Whether a category of this event may hold a quest of this type: `categoryId` when it is not this event's, `refresh`
 * when it refreshes and the type is played once (T-304c, ADR-204).
 */
async function takesQuest(
  client: PoolClient,
  eventId: string,
  categoryId: string,
  type: QuestType,
): Promise<"yes" | "categoryId" | "refresh"> {
  const category = await readCategory(client, eventId, categoryId);
  if (category === undefined) {
    return "categoryId";
  }
  return category.refresh === "none" || REFRESHING_QUEST_TYPES.includes(type) ? "yes" : "refresh";
}

/**
 * Adds a quest of a shipped type to a category of this event (FR-1005, FR-228), at the end. Adding needs no
 * confirmation, even while the event is live: it is how organizers react on the day.
 */
export function createQuest(
  deps: BuilderDeps,
  actor: Actor,
  eventId: string,
  input: QuestInput & Readonly<{ type: string; categoryId: string }>,
  caller: Caller,
): Promise<Done<QuestRecord>> {
  return withEvent(deps, actor, eventId, { change: undefined }, async (client, event) => {
    if (!isQuestType(input.type)) {
      return { kind: "invalid", field: "type" };
    }
    const taken = await takesQuest(client, eventId, input.categoryId, input.type);
    if (taken !== "yes") {
      return { kind: "invalid", field: taken };
    }
    const fields = mergeQuest(undefined, input.type, input, event.timezone);
    if (isInvalid(fields)) {
      return fields;
    }
    if (!(await itemAllowed(client, eventId, fields.itemId, null))) {
      return { kind: "invalid_item" };
    }
    if ((await countRows(client, "quest", eventId)) >= BUILDER_LIMITS.quests) {
      return { kind: "limit_reached", limit: BUILDER_LIMITS.quests };
    }
    const checked = await passportSteps(client, undefined, input.type, fields, input.steps);
    if (checked.kind !== "steps") {
      return checked;
    }
    const inserted = await insertQuest(client, eventId, input.type, fields);
    const made =
      checked.steps === undefined
        ? inserted
        : await withWrittenSteps(client, inserted, checked.steps);
    await audit(client, actor, caller, {
      action: "quest.create",
      eventId,
      target: { type: "quest", id: made.id },
      after: auditView(made),
    });
    return done(made);
  });
}

/**
 * Changes a quest (FR-1007), its type excepted; a confirmation while the event is live. A new category must be one of
 * this event's, and the quest goes to its end.
 */
export function updateQuest(
  deps: BuilderDeps,
  actor: Actor,
  target: Target,
  input: QuestInput & Change,
  caller: Caller,
): Promise<Done<QuestRecord>> {
  return withEvent(deps, actor, target.eventId, { change: input }, async (client, event) => {
    const current = await readQuest(client, target.eventId, target.id, true);
    if (current === undefined) {
      return { kind: "not_found" };
    }
    const taken =
      input.categoryId === undefined
        ? "yes"
        : await takesQuest(client, target.eventId, input.categoryId, current.type);
    if (taken !== "yes") {
      return { kind: "invalid", field: taken };
    }
    const fields = mergeQuest(current, current.type, input, event.timezone);
    if (isInvalid(fields)) {
      return fields;
    }
    if (!(await itemAllowed(client, target.eventId, fields.itemId, current.itemId))) {
      return { kind: "invalid_item" };
    }
    const checked = await passportSteps(client, current, current.type, fields, input.steps);
    if (checked.kind !== "steps") {
      return checked;
    }
    const written = { ...(await writeQuest(client, current, fields)), steps: current.steps };
    const updated =
      checked.steps === undefined
        ? written
        : await withWrittenSteps(client, written, checked.steps);
    const diff = questChanges(current, updated);
    if (Object.keys(diff.after).length > 0) {
      await audit(client, actor, caller, {
        action: "quest.update",
        eventId: target.eventId,
        target: { type: "quest", id: current.id },
        ...diff,
      });
    }
    return done(updated);
  });
}

/**
 * Deletes a quest; a confirmation while the event is live. Nothing references a quest yet: once completions exist
 * (T-105), a quest with completions is hidden instead until T-604 offers keep or remove.
 */
export function deleteQuest(
  deps: BuilderDeps,
  actor: Actor,
  target: Target,
  change: Change,
  caller: Caller,
): Promise<Done<null>> {
  return withEvent(deps, actor, target.eventId, { change }, async (client) => {
    const current = await readQuest(client, target.eventId, target.id, true);
    if (current === undefined) {
      return { kind: "not_found" };
    }
    const completed = await completionsOf(client, { questId: current.id });
    if (completed !== "none") {
      return { kind: completed === "real" ? "has_completions" : "rehearsal_data" };
    }
    await audit(client, actor, caller, {
      action: "quest.delete",
      eventId: target.eventId,
      target: { type: "quest", id: current.id },
      before: auditView(current),
    });
    await deleteRow(client, "quest", current.id);
    return done(null);
  });
}

/** Writes a passport's steps and reads the quest back with them. */
async function withWrittenSteps(
  client: Parameters<typeof writeSteps>[0],
  quest: QuestRecord,
  steps: Parameters<typeof writeSteps>[2],
): Promise<QuestRecord> {
  await writeSteps(client, quest, steps);
  return (await readQuest(client, quest.eventId, quest.id)) as QuestRecord;
}

/** Writes a new order from the full list of one category's quests. */
export function reorderQuests(
  deps: BuilderDeps,
  actor: Actor,
  target: Readonly<{ eventId: string; categoryId: string }>,
  input: Readonly<{ ids: readonly string[] }> & Change,
  caller: Caller,
): Promise<Done<null>> {
  return withEvent(deps, actor, target.eventId, { change: input }, async (client) => {
    const category = await readCategory(client, target.eventId, target.categoryId, true);
    if (category === undefined) {
      return { kind: "not_found" };
    }
    if (!(await reorder(client, "quest", { column: "category_id", id: category.id }, input.ids))) {
      return { kind: "order_stale" };
    }
    await audit(client, actor, caller, {
      action: "quest.reorder",
      eventId: target.eventId,
      target: { type: "category", id: category.id },
      after: { order: input.ids },
    });
    return done(null);
  });
}

/**
 * Pins a quest of this event as Up next for every player, or clears the pin with null (FR-1748). No confirmation, even
 * while the event is live: a pin moves no points. A quest outside the event is "not found"; the pin holds while the
 * quest is hidden, and Up next skips it until it shows again.
 */
export function setFocus(
  deps: BuilderDeps,
  actor: Actor,
  eventId: string,
  questId: string | null,
  caller: Caller,
): Promise<Done<Readonly<{ focusQuestId: string | null }>>> {
  return withEvent(deps, actor, eventId, { change: undefined }, async (client) => {
    if (questId !== null && (await readQuest(client, eventId, questId)) === undefined) {
      return { kind: "not_found" };
    }
    const { rows } = await client.query<{ focus_quest_id: string | null }>(
      "SELECT focus_quest_id FROM event WHERE id = $1",
      [eventId],
    );
    const before = rows[0]?.focus_quest_id ?? null;
    if (before !== questId) {
      await client.query("UPDATE event SET focus_quest_id = $2 WHERE id = $1", [eventId, questId]);
      await audit(client, actor, caller, {
        action: "event.focus_set",
        eventId,
        target: { type: "event", id: eventId },
        before: { focusQuestId: before },
        after: { focusQuestId: questId },
      });
    }
    return done({ focusQuestId: questId });
  });
}
