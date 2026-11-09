/**
 * Characterisation of the category builder's update and delete (function-limits split, 2026-11-09): the copies below
 * are `updateCategory` (with its `rulesOf`) and `deleteCategory` as they stood before the split. Every combination of
 * the stored state and the input must give the same answer and make the same store calls in the same order from the
 * old and the new code.
 */
import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import type { Actor } from "#src/events/events";

const world = vi.hoisted(() => ({
  log: [] as unknown[],
  categories: new Map<string, unknown>(),
  count: 2,
  unlocking: [] as unknown[],
  bonuses: "none" as string,
  holds: false,
  activeItem: true,
  quests: 0,
  completed: "none" as string,
}));

vi.mock("#src/quests/store", async (original) => ({
  ...(await original<typeof import("#src/quests/store")>()),
  readCategory: async (_client: unknown, eventId: string, id: string, lock?: boolean) => {
    world.log.push(["readCategory", eventId, id, lock]);
    return world.categories.get(id);
  },
  countRows: async (_client: unknown, table: string, eventId: string) => {
    world.log.push(["countRows", table, eventId]);
    return world.count;
  },
  unlockedBy: async (_client: unknown, id: string) => {
    world.log.push(["unlockedBy", id]);
    return world.unlocking;
  },
  playedCategory: async (_client: unknown, id: string) => {
    world.log.push(["playedCategory", id]);
    return world.bonuses;
  },
  holdsPlayedOnce: async (_client: unknown, id: string) => {
    world.log.push(["holdsPlayedOnce", id]);
    return world.holds;
  },
  activeItem: async (_client: unknown, eventId: string, itemId: string) => {
    world.log.push(["activeItem", eventId, itemId]);
    return world.activeItem;
  },
  moveQuests: async (_client: unknown, from: string, to: string) => {
    world.log.push(["moveQuests", from, to]);
  },
  deleteQuestsOf: async (_client: unknown, id: string) => {
    world.log.push(["deleteQuestsOf", id]);
    return ["quest-1", "quest-2"];
  },
  deleteRow: async (_client: unknown, table: string, id: string) => {
    world.log.push(["deleteRow", table, id]);
  },
  writeCategory: async (_client: unknown, id: string, fields: object) => {
    world.log.push(["writeCategory", id, fields]);
    return { ...(world.categories.get(id) as object), ...fields };
  },
}));

vi.mock("#src/quests/builder", async (original) => ({
  ...(await original<typeof import("#src/quests/builder")>()),
  withEvent: async (
    _deps: unknown,
    _actor: unknown,
    _eventId: string,
    gate: unknown,
    work: (client: PoolClient, event: unknown) => Promise<unknown>,
  ) => {
    world.log.push(["withEvent", gate]);
    return work(CLIENT, EVENT);
  },
  audit: async (_client: unknown, _actor: unknown, _caller: unknown, entry: unknown) => {
    world.log.push(["audit", entry]);
  },
  completionsOf: async (_client: unknown, where: unknown) => {
    world.log.push(["completionsOf", where]);
    return world.completed;
  },
}));

import {
  bilingual,
  changes,
  completionsOf,
  audit,
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
import { deleteCategory, updateCategory, categoryView } from "#src/quests/categories";
import {
  activeItem,
  countRows,
  deleteQuestsOf,
  deleteRow,
  holdsPlayedOnce,
  moveQuests,
  playedCategory,
  readCategory,
  unlockedBy,
  writeCategory,
  type BuilderEvent,
  type CategoryRecord,
  type CategoryRuleFields,
} from "#src/quests/store";
import type { Caller } from "#src/auth/sign-in";

const CLIENT = {
  query: async (sql: string, params: unknown[]) => {
    world.log.push(["query", sql, params]);
    return { rows: [{ count: world.quests }] };
  },
} as unknown as PoolClient;
const EVENT = {
  id: "ev-1",
  timezone: "Asia/Riyadh",
  statusNow: "draft",
} as unknown as BuilderEvent;
const DEPS = {} as BuilderDeps;
const ACTOR = {} as Actor;
const CALLER = {} as Caller;

// ---- the functions as they stood ----------------------------------------------------------------------------------

async function oldRulesOf(
  client: PoolClient,
  event: BuilderEvent,
  current: CategoryRecord,
  input: CategoryInput,
): Promise<CategoryRuleFields | Refused> {
  const opensAt = timeOf(input.opensAt, current.opensAt, event.timezone);
  if (opensAt === "invalid") {
    return { kind: "invalid", field: "opensAt" };
  }
  const unlockAfter = input.unlockAfter === undefined ? current.unlockAfter : input.unlockAfter;
  if (
    unlockAfter !== null &&
    (unlockAfter === current.id ||
      (await readCategory(client, event.id, unlockAfter)) === undefined)
  ) {
    return { kind: "invalid", field: "unlockAfter" };
  }
  const refresh = input.refresh ?? current.refresh;
  if (refresh !== "none" && (await holdsPlayedOnce(client, current.id))) {
    return { kind: "invalid", field: "refresh" };
  }
  const itemId = input.itemId === undefined ? current.itemId : input.itemId;
  if (
    itemId !== null &&
    itemId !== current.itemId &&
    !(await activeItem(client, event.id, itemId))
  ) {
    return { kind: "invalid_item" };
  }
  return {
    orderMode: input.orderMode ?? current.orderMode,
    opensAt,
    unlockAfter,
    completionBonus: input.completionBonus ?? current.completionBonus,
    refresh,
    hidden: input.hidden ?? current.hidden,
    itemId,
  };
}

function oldUpdateCategory(
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
    const rules = await oldRulesOf(client, event, current, input);
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

function oldDeleteCategory(
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
    const unlocking = await unlockedBy(client, current.id);
    if (unlocking.length > 0) {
      return { kind: "category_in_use", categories: unlocking };
    }
    const bonuses = await playedCategory(client, current.id);
    if (bonuses !== "none") {
      return { kind: bonuses === "real" ? "has_completions" : "rehearsal_data" };
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
      const completed = await completionsOf(client, { categoryId: current.id });
      if (completed !== "none") {
        return { kind: completed === "real" ? "has_completions" : "rehearsal_data" };
      }
      outcome["deletedQuests"] = await deleteQuestsOf(client, current.id);
    }
    // Written first: the audit rules need the event, and the entry goes back with the transaction on any failure.
    await audit(client, actor, caller, {
      action: "category.delete",
      eventId,
      target: { type: "category", id: current.id },
      before: { nameAr: current.name.ar, nameEn: current.name.en },
      after: outcome,
    });
    await deleteRow(client, "category", current.id);
    return done(null);
  });
}

// ---- the cases ----------------------------------------------------------------------------------------------------

const CURRENT: CategoryRecord = {
  id: "cat-1",
  eventId: "ev-1",
  name: { ar: "الأول", en: "One" },
  position: 0,
  orderMode: "any",
  opensAt: new Date("2030-01-01T10:00:00Z"),
  unlockAfter: null,
  completionBonus: 5,
  refresh: "none",
  hidden: false,
  itemId: "item-1",
};
const OTHER: CategoryRecord = { ...CURRENT, id: "cat-2", name: { ar: null, en: "Two" } };

function reset(found: boolean, current: CategoryRecord) {
  world.log = [];
  world.categories = new Map<string, unknown>([[OTHER.id, OTHER]]);
  if (found) {
    world.categories.set(current.id, current);
  }
}

/** Every combination of the axes' values. */
function product<T extends Record<string, readonly unknown[]>>(
  axes: T,
): { [K in keyof T]: T[K][number] }[] {
  return Object.entries(axes).reduce<Record<string, unknown>[]>(
    (rows, [key, values]) =>
      rows.flatMap((row) => values.map((value) => ({ ...row, [key]: value }))),
    [{}],
  ) as { [K in keyof T]: T[K][number] }[];
}

describe("updateCategory characterisation", () => {
  const cases = product({
    found: [true, false],
    currentRefresh: ["none", "daily"] as const,
    currentUnlock: [null, "cat-2"],
    name: [undefined, { en: "Renamed" }, { ar: " ", en: "" }],
    opensAt: [undefined, null, "2030-05-01T09:00", "tomorrow"],
    unlockAfter: [undefined, null, "cat-1", "cat-2", "cat-9"],
    refresh: [undefined, "none", "weekly"] as const,
    holds: [false, true],
    itemId: [undefined, null, "item-1", "item-2"],
    activeItem: [false, true],
    others: [{}, { orderMode: "in_order", completionBonus: 9, hidden: true }] as const,
  });

  it(`answers and calls the store as before over ${cases.length} cases`, async () => {
    const outcomes = new Set<string>();
    const target = { eventId: "ev-1", id: "cat-1" };
    for (const c of cases) {
      const current = {
        ...CURRENT,
        refresh: c.currentRefresh,
        unlockAfter: c.currentUnlock,
      } as CategoryRecord;
      const input = {
        name: c.name,
        opensAt: c.opensAt,
        unlockAfter: c.unlockAfter,
        refresh: c.refresh,
        itemId: c.itemId,
        confirm: true,
        ...c.others,
      } as CategoryInput & Change;
      world.holds = c.holds;
      world.activeItem = c.activeItem;
      reset(c.found, current);
      const before = await oldUpdateCategory(DEPS, ACTOR, target, input, CALLER);
      const beforeLog = world.log;
      reset(c.found, current);
      const after = await updateCategory(DEPS, ACTOR, target, input, CALLER);
      expect({ after, log: world.log }, JSON.stringify(c)).toStrictEqual({
        after: before,
        log: beforeLog,
      });
      const result = before as { kind: string; field?: string };
      outcomes.add(`${result.kind}:${result.field ?? ""}`);
    }
    expect([...outcomes].toSorted()).toEqual([
      "done:",
      "invalid:name",
      "invalid:opensAt",
      "invalid:refresh",
      "invalid:unlockAfter",
      "invalid_item:",
      "not_found:",
    ]);
  });
});

describe("deleteCategory characterisation", () => {
  const cases = product({
    found: [true, false],
    count: [1, 2],
    unlocking: [[], [{ id: "cat-3" }]],
    bonuses: ["none", "real", "rehearsal"],
    quests: [0, 3],
    choice: [undefined, "move", "delete"] as const,
    to: [undefined, "cat-1", "cat-2", "cat-9"],
    completed: ["none", "real", "rehearsal"],
  });

  it(`answers and calls the store as before over ${cases.length} cases`, async () => {
    const outcomes = new Set<string>();
    const target = { eventId: "ev-1", id: "cat-1" };
    for (const c of cases) {
      const choice = { quests: c.choice, to: c.to } as CategoryDelete & Change;
      world.count = c.count;
      world.unlocking = c.unlocking;
      world.bonuses = c.bonuses;
      world.quests = c.quests;
      world.completed = c.completed;
      reset(c.found, CURRENT);
      const before = await oldDeleteCategory(DEPS, ACTOR, target, choice, CALLER);
      const beforeLog = world.log;
      reset(c.found, CURRENT);
      const after = await deleteCategory(DEPS, ACTOR, target, choice, CALLER);
      expect({ after, log: world.log }, JSON.stringify(c)).toStrictEqual({
        after: before,
        log: beforeLog,
      });
      const result = before as { kind: string; field?: string };
      outcomes.add(`${result.kind}:${result.field ?? ""}`);
    }
    expect([...outcomes].toSorted()).toEqual([
      "category_in_use:",
      "category_not_empty:",
      "done:",
      "has_completions:",
      "invalid:to",
      "last_category:",
      "not_found:",
      "rehearsal_data:",
    ]);
  });
});
