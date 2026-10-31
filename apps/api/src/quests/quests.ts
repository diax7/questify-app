import {
  REFRESHING_QUEST_TYPES,
  firstBonusProblem,
  isQuestType,
  type FirstBonusInput,
  type QuestType,
} from "@questify/shared";
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
  withFirstBonus,
  type BuilderDeps,
  type BuilderQuest,
  type Change,
  type Done,
  type QuestInput,
  type Refused,
} from "#src/quests/builder";
import { setFirstBonus } from "#src/quests/first-bonus";
import {
  PAST_POINTS_TYPES,
  applyPast,
  deletePlayed,
  pastReplay,
  type PastChange,
} from "#src/quests/live-edits";
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

/** Whether new points reach future completions only or also the kept past ones (T-604, FR-411). */
export type PointsApply = Readonly<{ apply?: "future" | "past" | undefined }>;

/** A quest after its edit, with what "also past" did (null for a future-only edit). */
export type EditedQuest = Readonly<{ quest: BuilderQuest; change: PastChange | null }>;

/**
 * Which points choice an edit runs, or its refusal: "also past" only on a type paid the quest's points per completion
 * and with a key; new points in a live event whose quest has real completions must say which (409 apply_required).
 */
async function pointsChoice(
  client: PoolClient,
  live: boolean,
  current: QuestRecord,
  input: QuestInput & PointsApply,
  key: string | undefined,
): Promise<"future" | "past" | Refused> {
  if (input.apply === "past") {
    if (!PAST_POINTS_TYPES.includes(current.type)) {
      return { kind: "invalid", field: "apply" };
    }
    return key === undefined ? { kind: "key_required" } : "past";
  }
  const changing = input.points !== undefined && input.points !== current.points;
  if (input.apply === undefined && changing && live) {
    if ((await completionsOf(client, { questId: current.id })) === "real") {
      return { kind: "apply_required" };
    }
  }
  return "future";
}

/** The input's bonus problem as the builder's refusal, or undefined when there is none or nothing to change. */
function bonusRefusal(
  input: FirstBonusInput | undefined,
): Readonly<{ kind: "invalid_first_bonus"; field: "points" | "slots" }> | undefined {
  const field = input === undefined ? null : firstBonusProblem(input);
  return field === null ? undefined : { kind: "invalid_first_bonus", field };
}

/**
 * Writes the input's first-N bonus after the quest write (the setter's lock is taken last, ADR-260) and reads the quest
 * back with its bonus. A refusal of the setter throws, so the quest write rolls back with it.
 */
async function savedWithBonus(
  client: PoolClient,
  quest: QuestRecord,
  input: FirstBonusInput | undefined,
  caller: Caller,
): Promise<BuilderQuest> {
  if (input !== undefined) {
    const outcome = await setFirstBonus(
      client,
      { eventId: quest.eventId, questId: quest.id },
      input,
      caller.requestId,
    );
    caller.log("quest.first_bonus_set", { questId: quest.id, outcome });
  }
  return (await withFirstBonus(client, quest.eventId, [quest]))[0] as BuilderQuest;
}

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
): Promise<Done<BuilderQuest>> {
  return withEvent(deps, actor, eventId, { change: undefined }, async (client, event) => {
    if (!isQuestType(input.type)) {
      return { kind: "invalid", field: "type" };
    }
    const bonus = bonusRefusal(input.firstBonus);
    if (bonus !== undefined) {
      return bonus;
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
    return done(await savedWithBonus(client, made, input.firstBonus, caller));
  });
}

/**
 * Changes a quest (FR-1007), its type excepted; a confirmation while the event is live. A new category must be one of
 * this event's, and the quest goes to its end.
 */
export function updateQuest(
  deps: BuilderDeps,
  actor: Actor,
  target: Target & Readonly<{ key?: string | undefined }>,
  input: QuestInput & Change & PointsApply,
  caller: Caller,
): Promise<Done<EditedQuest>> {
  return withEvent(deps, actor, target.eventId, { change: input }, async (client, event) => {
    const current = await readQuest(client, target.eventId, target.id, true);
    if (current === undefined) {
      return { kind: "not_found" };
    }
    const bonus = bonusRefusal(input.firstBonus);
    if (bonus !== undefined) {
      return bonus;
    }
    const choice = await pointsChoice(
      client,
      event.statusNow === "live",
      current,
      input,
      target.key,
    );
    if (typeof choice !== "string") {
      return choice;
    }
    const points = input.points ?? current.points;
    const key = target.key ?? "";
    if (choice === "past") {
      const earlier = await pastReplay(client, {
        eventId: target.eventId,
        questId: current.id,
        points,
        key,
      });
      if (earlier?.kind === "other") {
        return { kind: "key_reused" };
      }
      if (earlier?.kind === "same") {
        const quest = await savedWithBonus(client, current, undefined, caller);
        return done({ quest, change: earlier.change });
      }
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
    const change =
      choice === "past"
        ? await applyPast(client, {
            eventId: target.eventId,
            questId: current.id,
            fromPoints: current.points,
            key,
            requestId: caller.requestId ?? "",
          })
        : null;
    return done({ quest: await savedWithBonus(client, updated, input.firstBonus, caller), change });
  });
}

/**
 * Deletes a quest; a confirmation while the event is live. An unplayed quest is deleted; a quest real players completed
 * is deleted by a mark that keeps or removes its points (T-604, FR-412: 409 points_choice_required until one is chosen);
 * one only rehearsal accounts played waits for the rehearsal's wipe (rehearsal_data).
 */
export function deleteQuest(
  deps: BuilderDeps,
  actor: Actor,
  target: Target,
  change: Change & Readonly<{ points?: "keep" | "remove" | undefined }>,
  caller: Caller,
): Promise<Done<null>> {
  return withEvent(deps, actor, target.eventId, { change }, async (client) => {
    const current = await readQuest(client, target.eventId, target.id, true);
    if (current === undefined) {
      return { kind: "not_found" };
    }
    const completed = await completionsOf(client, { questId: current.id });
    if (completed === "real") {
      if (change.points === undefined) {
        return { kind: "points_choice_required" };
      }
      const remove = change.points === "remove";
      const outcome = await deletePlayed(client, {
        eventId: target.eventId,
        questId: current.id,
        remove,
        requestId: caller.requestId ?? "",
      });
      caller.log("quest.deleted_played", { questId: current.id, ...outcome });
      return done(null);
    }
    if (completed !== "none") {
      return { kind: "rehearsal_data" };
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
