import type { Caller } from "#src/auth/sign-in";
import type { Actor } from "#src/events/events";
import {
  BUILDER_LIMITS,
  anyCompletions,
  NO_TEXT,
  audit,
  bilingual,
  changes,
  done,
  withEvent,
  type BuilderDeps,
  type CategoryDelete,
  type CategoryInput,
  type Change,
  type Done,
} from "#src/quests/builder";
import {
  countRows,
  deleteQuestsOf,
  deleteRow,
  insertCategory,
  moveQuests,
  readCategory,
  renameCategory,
  reorder,
  type CategoryRecord,
} from "#src/quests/store";

const nameView = (category: CategoryRecord) => ({
  nameAr: category.name.ar,
  nameEn: category.name.en,
});

/** Adds a category at the end (FR-1004). Adding needs no confirmation, even while the event is live. */
export function createCategory(
  deps: BuilderDeps,
  actor: Actor,
  eventId: string,
  input: CategoryInput,
  caller: Caller,
): Promise<Done<CategoryRecord>> {
  return withEvent(deps, actor, eventId, { change: undefined }, async (client) => {
    const name = bilingual(input.name, NO_TEXT);
    if (name.ar === null && name.en === null) {
      return { kind: "invalid", field: "name" };
    }
    if ((await countRows(client, "category", eventId)) >= BUILDER_LIMITS.categories) {
      return { kind: "limit_reached", limit: BUILDER_LIMITS.categories };
    }
    const made = await insertCategory(client, eventId, name);
    await audit(client, actor, caller, {
      action: "category.create",
      eventId,
      target: { type: "category", id: made.id },
      after: nameView(made),
    });
    return done(made);
  });
}

/** Renames a category; a confirmation while the event is live. */
export function updateCategory(
  deps: BuilderDeps,
  actor: Actor,
  target: Readonly<{ eventId: string; id: string }>,
  input: CategoryInput & Change,
  caller: Caller,
): Promise<Done<CategoryRecord>> {
  return withEvent(deps, actor, target.eventId, { change: input }, async (client) => {
    const current = await readCategory(client, target.eventId, target.id, true);
    if (current === undefined) {
      return { kind: "not_found" };
    }
    const name = bilingual(input.name, current.name);
    if (name.ar === null && name.en === null) {
      return { kind: "invalid", field: "name" };
    }
    const renamed = await renameCategory(client, current.id, name);
    const diff = changes(nameView(current), nameView(renamed));
    if (Object.keys(diff.after).length > 0) {
      await audit(client, actor, caller, {
        action: "category.update",
        eventId: target.eventId,
        target: { type: "category", id: current.id },
        ...diff,
      });
    }
    return done(renamed);
  });
}

/**
 * Deletes a category (FR-1004). One that holds quests needs a choice: move them to the end of another category of this
 * event, or delete them. The last category stays: every quest needs one, and the event always has one (FR-228).
 */
export function deleteCategory(
  deps: BuilderDeps,
  actor: Actor,
  target: Readonly<{ eventId: string; id: string }>,
  choice: CategoryDelete & Change,
  caller: Caller,
): Promise<Done<null>> {
  const { eventId } = target;
  return withEvent(deps, actor, eventId, { change: choice }, async (client) => {
    const current = await readCategory(client, eventId, target.id, true);
    if (current === undefined) {
      return { kind: "not_found" };
    }
    if ((await countRows(client, "category", eventId)) <= 1) {
      return { kind: "last_category" };
    }
    const held = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM quest WHERE category_id = $1",
      [current.id],
    );
    const quests = held.rows[0]?.count ?? 0;
    const outcome: Record<string, unknown> = { quests };
    if (quests > 0 && choice.quests === undefined) {
      return { kind: "category_not_empty", quests };
    }
    if (quests > 0 && choice.quests === "move") {
      const to =
        choice.to === undefined ? undefined : await readCategory(client, eventId, choice.to);
      if (to === undefined || to.id === current.id) {
        return { kind: "invalid", field: "to" };
      }
      await moveQuests(client, current.id, to.id);
      outcome["movedTo"] = to.id;
    }
    if (quests > 0 && choice.quests === "delete") {
      if (await anyCompletions(client, { categoryId: current.id })) {
        return { kind: "has_completions" };
      }
      outcome["deletedQuests"] = await deleteQuestsOf(client, current.id);
    }
    // Written first: the audit rules need the event, and the entry goes back with the transaction on any failure.
    await audit(client, actor, caller, {
      action: "category.delete",
      eventId,
      target: { type: "category", id: current.id },
      before: nameView(current),
      after: outcome,
    });
    await deleteRow(client, "category", current.id);
    return done(null);
  });
}

/** Writes a new order from the full list of this event's categories (FR-229). */
export function reorderCategories(
  deps: BuilderDeps,
  actor: Actor,
  eventId: string,
  input: Readonly<{ ids: readonly string[] }> & Change,
  caller: Caller,
): Promise<Done<null>> {
  return withEvent(deps, actor, eventId, { change: input }, async (client) => {
    if (!(await reorder(client, "category", { column: "event_id", id: eventId }, input.ids))) {
      return { kind: "order_stale" };
    }
    await audit(client, actor, caller, {
      action: "category.reorder",
      eventId,
      target: { type: "event", id: eventId },
      after: { order: input.ids },
    });
    return done(null);
  });
}
