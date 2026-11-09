import type { Caller } from "#src/auth/sign-in";
import type { Actor } from "#src/events/events";
import {
  BUILDER_LIMITS,
  completionsOf,
  NO_TEXT,
  audit,
  bilingual,
  changes,
  done,
  timeOf,
  withEvent,
  type BuilderDeps,
  type CategoryDelete,
  type CategoryInput,
  type Change,
  type Done,
  type Refused,
} from "#src/quests/builder";
import {
  playedCategory,
  activeItem,
  countRows,
  deleteQuestsOf,
  deleteRow,
  holdsPlayedOnce,
  insertCategory,
  moveQuests,
  readCategory,
  reorder,
  unlockedBy,
  writeCategory,
  type BuilderEvent,
  type CategoryRecord,
  type CategoryRuleFields,
} from "#src/quests/store";
import type { PoolClient } from "pg";

export const nameView = (category: CategoryRecord) => ({
  nameAr: category.name.ar,
  nameEn: category.name.en,
});

/** What the audit log records of a category: its name and its rules. */
export const categoryView = (category: CategoryRecord) => ({
  ...nameView(category),
  orderMode: category.orderMode,
  opensAt: category.opensAt?.toISOString() ?? null,
  unlockAfter: category.unlockAfter,
  completionBonus: category.completionBonus,
  refresh: category.refresh,
  hidden: category.hidden,
  itemId: category.itemId,
});

/** The input's value when it names one (null clears), else the current one. */
const pick = <T>(given: T | undefined, current: T): T => (given === undefined ? current : given);

/** Whether the unlock is none or names another category of this event. */
async function unlockAllowed(
  client: PoolClient,
  eventId: string,
  current: CategoryRecord,
  unlockAfter: string | null,
): Promise<boolean> {
  if (unlockAfter === null) {
    return true;
  }
  return (
    unlockAfter !== current.id && (await readCategory(client, eventId, unlockAfter)) !== undefined
  );
}

/** Whether the bonus item is none, unchanged, or an active item of this event. */
async function itemAllowed(
  client: PoolClient,
  eventId: string,
  current: CategoryRecord,
  itemId: string | null,
): Promise<boolean> {
  if (itemId === null || itemId === current.itemId) {
    return true;
  }
  return activeItem(client, eventId, itemId);
}

/**
 * A category's rules after this input (T-304, T-304c): the opening time read in the event's zone, an unlock that names
 * another category of this event (a circle is refused by the database, migration 0044), and a refresh only over
 * repeatable quests (ADR-204).
 */
async function rulesOf(
  client: PoolClient,
  event: BuilderEvent,
  current: CategoryRecord,
  input: CategoryInput,
): Promise<CategoryRuleFields | Refused> {
  const opensAt = timeOf(input.opensAt, current.opensAt, event.timezone);
  if (opensAt === "invalid") {
    return { kind: "invalid", field: "opensAt" };
  }
  const unlockAfter = pick(input.unlockAfter, current.unlockAfter);
  if (!(await unlockAllowed(client, event.id, current, unlockAfter))) {
    return { kind: "invalid", field: "unlockAfter" };
  }
  const refresh = input.refresh ?? current.refresh;
  if (refresh !== "none" && (await holdsPlayedOnce(client, current.id))) {
    return { kind: "invalid", field: "refresh" };
  }
  const itemId = pick(input.itemId, current.itemId);
  if (!(await itemAllowed(client, event.id, current, itemId))) {
    return { kind: "invalid_item" };
  }
  return { ...plainRules(input, current), opensAt, unlockAfter, refresh, itemId };
}

/** The rules that need no check: the input's value, else the current one. */
const plainRules = (input: CategoryInput, current: CategoryRecord) => ({
  orderMode: input.orderMode ?? current.orderMode,
  completionBonus: input.completionBonus ?? current.completionBonus,
  hidden: input.hidden ?? current.hidden,
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

/** Renames a category and sets its rules (T-304); a confirmation while the event is live. */
export function updateCategory(
  deps: BuilderDeps,
  actor: Actor,
  target: Readonly<{ eventId: string; id: string }>,
  input: CategoryInput & Change,
  caller: Caller,
): Promise<Done<CategoryRecord>> {
  return withEvent(deps, actor, target.eventId, { change: input }, async (client, event) => {
    const current = await readCategory(client, target.eventId, target.id, true);
    if (current === undefined) {
      return { kind: "not_found" };
    }
    const name = bilingual(input.name, current.name);
    if (name.ar === null && name.en === null) {
      return { kind: "invalid", field: "name" };
    }
    const rules = await rulesOf(client, event, current, input);
    if ("kind" in rules) {
      return rules;
    }
    const renamed = await writeCategory(client, current.id, { name, ...rules });
    const diff = changes(categoryView(current), categoryView(renamed));
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

/** The refusal for a category players or rehearsal accounts completed. */
const completedRefusal = (played: "rehearsal" | "real"): Refused => ({
  kind: played === "real" ? "has_completions" : "rehearsal_data",
});

/** Why this category cannot go whatever is done with its quests: the last one, an unlock, a paid bonus. */
async function deletionBlock(
  client: PoolClient,
  eventId: string,
  current: CategoryRecord,
): Promise<Refused | undefined> {
  if ((await countRows(client, "category", eventId)) <= 1) {
    return { kind: "last_category" };
  }
  const unlocking = await unlockedBy(client, current.id);
  if (unlocking.length > 0) {
    return { kind: "category_in_use", categories: unlocking };
  }
  const bonuses = await playedCategory(client, current.id);
  return bonuses === "none" ? undefined : completedRefusal(bonuses);
}

/** Moves the quests to the end of another category of this event; the new home's id, or the refusal. */
async function moveAway(
  client: PoolClient,
  current: CategoryRecord,
  toId: string | undefined,
): Promise<string | Refused> {
  const to = toId === undefined ? undefined : await readCategory(client, current.eventId, toId);
  if (to === undefined || to.id === current.id) {
    return { kind: "invalid", field: "to" };
  }
  await moveQuests(client, current.id, to.id);
  return to.id;
}

/** Does what the choice says with the quests of a category being deleted, noting it in `outcome`; or the refusal. */
async function settleQuests(
  client: PoolClient,
  current: CategoryRecord,
  choice: CategoryDelete,
  outcome: Record<string, unknown>,
  quests: number,
): Promise<Refused | undefined> {
  if (quests === 0) {
    return undefined;
  }
  if (choice.quests === undefined) {
    return { kind: "category_not_empty", quests };
  }
  if (choice.quests === "move") {
    const moved = await moveAway(client, current, choice.to);
    if (typeof moved !== "string") {
      return moved;
    }
    outcome["movedTo"] = moved;
  }
  if (choice.quests === "delete") {
    const completed = await completionsOf(client, { categoryId: current.id });
    if (completed !== "none") {
      return completedRefusal(completed);
    }
    outcome["deletedQuests"] = await deleteQuestsOf(client, current.id);
  }
  return undefined;
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
    const blocked = await deletionBlock(client, eventId, current);
    if (blocked !== undefined) {
      return blocked;
    }
    const held = await client.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM quest WHERE category_id = $1",
      [current.id],
    );
    const quests = held.rows[0]?.count ?? 0;
    const outcome: Record<string, unknown> = { quests };
    const refused = await settleQuests(client, current, choice, outcome, quests);
    if (refused !== undefined) {
      return refused;
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
