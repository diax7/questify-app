import { isQuestType } from "@questify/shared";
import type { Caller } from "#src/auth/sign-in";
import type { Actor } from "#src/events/events";
import {
  BUILDER_LIMITS,
  anyCompletions,
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
import {
  countRows,
  deleteRow,
  insertQuest,
  readCategory,
  readQuest,
  reorder,
  updateQuest as writeQuest,
  type QuestRecord,
} from "#src/quests/store";

type Target = Readonly<{ eventId: string; id: string }>;

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
    if ((await readCategory(client, eventId, input.categoryId)) === undefined) {
      return { kind: "invalid", field: "categoryId" };
    }
    const fields = mergeQuest(undefined, input.type, input, event.timezone);
    if (isInvalid(fields)) {
      return fields;
    }
    if ((await countRows(client, "quest", eventId)) >= BUILDER_LIMITS.quests) {
      return { kind: "limit_reached", limit: BUILDER_LIMITS.quests };
    }
    const made = await insertQuest(client, eventId, input.type, fields);
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
    if (
      input.categoryId !== undefined &&
      (await readCategory(client, target.eventId, input.categoryId)) === undefined
    ) {
      return { kind: "invalid", field: "categoryId" };
    }
    const fields = mergeQuest(current, current.type, input, event.timezone);
    if (isInvalid(fields)) {
      return fields;
    }
    const updated = await writeQuest(client, current, fields);
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
    if (await anyCompletions(client, { questId: current.id })) {
      return { kind: "has_completions" };
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
