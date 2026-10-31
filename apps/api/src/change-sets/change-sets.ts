import type { ApiErrorEnvelope } from "@questify/shared";
import type { Pool, PoolClient } from "pg";
import { notFound } from "#src/auth/http-errors";
import { recordAudit } from "#src/audit/record";
import type { Caller } from "#src/auth/sign-in";
import { KINDS, evaluate, viewOf, type ItemView } from "#src/change-sets/review";
import type { RunContext } from "#src/change-sets/kinds";
import {
  decideItem,
  finishSet,
  insertSet,
  listSets,
  readItems,
  readSet,
  type ItemRecord,
  type NewItem,
  type SetRecord,
  type SetStatus,
  type SetSummary,
} from "#src/change-sets/store";
import type { JsonObject, ItemOp, ItemTarget } from "#src/change-sets/store";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { Actor } from "#src/events/events";
import type { BuilderEvent } from "#src/quests/store";
import type { RewardCodeKey } from "#src/rewards/codes";
import type { SettingsService } from "#src/settings/service";

/** The most items in a set, and the most open sets in an event (migration 0099). */
export const SET_LIMITS = { items: 100, open: 20, listed: 50 } as const;

export type ChangeSetDeps = Readonly<{
  pool: Pool;
  codeKey: RewardCodeKey;
  settings: Pick<SettingsService, "forEvent">;
}>;

/** Why a change set call was refused; each maps to one HTTP answer. */
export type SetRefusal =
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "event_closed" }>
  | Readonly<{ kind: "finished" }>
  | Readonly<{ kind: "busy" }>
  | Readonly<{ kind: "limit_reached"; limit: number }>
  | Readonly<{ kind: "invalid"; field: "itemIds" }>;

export type SetDone<T> = Readonly<{ kind: "done"; value: T }> | SetRefusal;

const done = <T>(value: T): SetDone<T> => ({ kind: "done", value });

/** An item as the caller proposes it. */
export type ProposedItem = Readonly<{
  op: ItemOp;
  target: ItemTarget;
  targetId: string | null;
  body: JsonObject;
}>;

export type SetView = SetRecord & Readonly<{ items: readonly ItemView[] }>;

/** What happened to one selected item. */
export type ItemResult = Readonly<{
  itemId: string;
  status: "applied" | "failed" | "stale";
  error: ApiErrorEnvelope | null;
}>;

export type ApplyOutcome = Readonly<{ status: SetStatus; results: readonly ItemResult[] }>;

const seatOf = (actor: Actor) => ({
  organizerId: actor.organizerId,
  staffUserId: actor.staffUserId,
});

const isClosed = (event: BuilderEvent): boolean =>
  event.statusNow === "ended" || event.statusNow === "archived";

async function readEvent(
  client: PoolClient,
  actor: Actor,
  eventId: string,
  lock: boolean,
): Promise<BuilderEvent | undefined> {
  const { rows } = await client.query<{
    id: string;
    timezone: string;
    status_now: BuilderEvent["statusNow"];
  }>(
    `SELECT id, timezone, event_status_now(status, starts_at, ends_at) AS status_now
     FROM event WHERE organizer_id = $1 AND id = $2${lock ? " FOR NO KEY UPDATE" : ""}`,
    [actor.organizerId, eventId],
  );
  const row = rows[0];
  return row === undefined
    ? undefined
    : { id: row.id, timezone: row.timezone, statusNow: row.status_now };
}

/** The database's own refusals of migration 0099 as call refusals; undefined for any other error. */
function refusalOfError(error: unknown): SetRefusal | undefined {
  const code = (error as { code?: string }).code;
  if (code === "CS429") {
    return { kind: "limit_reached", limit: SET_LIMITS.open };
  }
  return code === "CS409" ? { kind: "finished" } : undefined;
}

/**
 * Runs `work` on the path's event as the caller (not found outside their organizer and event limit), in one
 * transaction. `lock` takes the event the way a builder write does.
 */
async function inEvent<T>(
  pool: Pool,
  actor: Actor,
  eventId: string,
  work: (client: PoolClient, event: BuilderEvent) => Promise<SetDone<T>>,
  lock = false,
): Promise<SetDone<T>> {
  try {
    return await withConnection(pool, (client) =>
      withRequestContext(client, seatOf(actor), async () => {
        const event = await readEvent(client, actor, eventId, lock);
        return event === undefined ? ({ kind: "not_found" } as const) : work(client, event);
      }),
    );
  } catch (error) {
    const refused = refusalOfError(error);
    if (refused === undefined) {
      throw error;
    }
    return refused;
  }
}

const auditSet = (
  client: PoolClient,
  actor: Actor,
  caller: Caller,
  entry: Readonly<{ action: string; eventId: string; after: Record<string, unknown> }>,
) =>
  recordAudit(client, {
    actor: { type: "staff", id: actor.staffUserId },
    action: entry.action,
    target: { type: "event", id: entry.eventId },
    organizerId: actor.organizerId,
    eventId: entry.eventId,
    after: entry.after,
    requestId: caller.requestId,
  });

/**
 * Makes a set from the proposed items (FR-1034): nothing is applied. An edit or a delete keeps the target's view as it
 * is now, so a later change to the target shows as stale; an item whose target is not there is kept as it is and
 * shows as invalid when the set is opened.
 */
export function createChangeSet(
  deps: ChangeSetDeps,
  actor: Actor,
  eventId: string,
  items: readonly ProposedItem[],
  caller: Caller,
): Promise<SetDone<SetSummary>> {
  return inEvent(
    deps.pool,
    actor,
    eventId,
    async (client, event) => {
      if (isClosed(event)) {
        return { kind: "event_closed" };
      }
      const prepared: NewItem[] = [];
      for (const item of items) {
        const seen =
          item.targetId === null
            ? undefined
            : await KINDS[item.target].read({ client, event }, item.targetId);
        prepared.push({ ...item, before: seen?.view ?? null });
      }
      const made = await insertSet(
        client,
        { organizerId: actor.organizerId, eventId, staffUserId: actor.staffUserId },
        prepared,
      );
      await auditSet(client, actor, caller, {
        action: "change_set.create",
        eventId,
        after: { changeSetId: made.id, items: prepared.length },
      });
      return done({ ...made, items: prepared.length, pending: prepared.length });
    },
    true,
  );
}

/** The event's sets, newest first (any state: a finished set is still read). */
export function listChangeSets(
  deps: ChangeSetDeps,
  actor: Actor,
  eventId: string,
): Promise<SetDone<SetSummary[]>> {
  return inEvent(deps.pool, actor, eventId, async (client) =>
    done(await listSets(client, eventId, SET_LIMITS.listed)),
  );
}

/**
 * One set with each item checked against the event now (FR-1034): invalid with its reason, stale, or ready, and what
 * it would change. Nothing is written; the builder refuses what only the database can see when the item is applied.
 */
export function readChangeSet(
  deps: ChangeSetDeps,
  actor: Actor,
  target: Readonly<{ eventId: string; setId: string }>,
): Promise<SetDone<SetView>> {
  return inEvent(deps.pool, actor, target.eventId, async (client, event) => {
    const set = await readSet(client, target.eventId, target.setId);
    if (set === undefined) {
      return { kind: "not_found" };
    }
    const views: ItemView[] = [];
    for (const item of await readItems(client, set.id)) {
      views.push(await viewOf({ client, event }, item));
    }
    return done({ ...set, items: views });
  });
}

/** Records one item's decision in its own transaction. */
function decide(
  deps: ChangeSetDeps,
  actor: Actor,
  eventId: string,
  item: ItemRecord,
  decision: Readonly<{ status: ItemResult["status"]; error: ApiErrorEnvelope | null }>,
): Promise<SetDone<ItemResult>> {
  return inEvent(deps.pool, actor, eventId, async (client) => {
    await decideItem(client, item.id, decision);
    return done({ itemId: item.id, ...decision });
  });
}

/**
 * Applies one pending item: checked against the event now, then run through the builder's service with the caller's
 * own seat in its own transaction, then recorded. A target that changed since the set was made is skipped as stale.
 */
async function applyOne(
  deps: ChangeSetDeps,
  context: RunContext,
  item: ItemRecord,
): Promise<ItemResult> {
  const { actor, eventId } = context;
  const checked = await inEvent(deps.pool, actor, eventId, async (client, event) =>
    done(await evaluate({ client, event }, item, false)),
  );
  const found = checked.kind === "done" ? checked.value : undefined;
  const record = async (status: ItemResult["status"], error: ApiErrorEnvelope | null) => {
    const recorded = await decide(deps, actor, eventId, item, { status, error });
    return recorded.kind === "done" ? recorded.value : { itemId: item.id, status, error };
  };
  if (found === undefined) {
    return record("failed", notFound().envelope);
  }
  if (found.state === "invalid") {
    return record("failed", found.problem);
  }
  if (found.state === "stale") {
    return record("stale", null);
  }
  const refusal = await KINDS[item.target].run(context, item, found.input);
  return record(refusal === null ? "applied" : "failed", refusal);
}

/** Holds the set's advisory lock on its own connection while `work` runs; busy when an apply or a close has it. */
async function withSetLock<T>(
  pool: Pool,
  setId: string,
  caller: Caller,
  work: () => Promise<SetDone<T>>,
): Promise<SetDone<T>> {
  const key = `change_set_apply:${setId}`;
  const holder = await pool.connect();
  let healthy = true;
  try {
    const { rows } = await holder.query<{ held: boolean }>(
      "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS held",
      [key],
    );
    if (rows[0]?.held !== true) {
      return { kind: "busy" };
    }
    try {
      return await work();
    } finally {
      healthy = await holder
        .query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [key])
        .then(
          () => true,
          (error: unknown) => {
            caller.log("change_set.unlock_failed", { setId, error: String(error) });
            return false;
          },
        );
    }
  } finally {
    holder.release(!healthy);
  }
}

/** The selected items of an open set, in the set's order; a refusal when the set is finished or an id is not pending. */
async function selectedItems(
  deps: ChangeSetDeps,
  actor: Actor,
  target: Readonly<{ eventId: string; setId: string; itemIds: readonly string[] }>,
): Promise<SetDone<ItemRecord[]>> {
  return inEvent(deps.pool, actor, target.eventId, async (client, event) => {
    if (isClosed(event)) {
      return { kind: "event_closed" };
    }
    const set = await readSet(client, target.eventId, target.setId);
    if (set === undefined) {
      return { kind: "not_found" };
    }
    if (set.status !== "open") {
      return { kind: "finished" };
    }
    const pending = (await readItems(client, set.id)).filter((item) => item.status === "pending");
    const chosen = pending.filter((item) => target.itemIds.includes(item.id));
    return chosen.length === new Set(target.itemIds).size
      ? done(chosen)
      : { kind: "invalid", field: "itemIds" };
  });
}

/**
 * Applies the selected items of an open set (FR-1035), one after another, each through the builder's own service in
 * its own transaction: a refused item is `failed` with the builder's reason and the rest go on. Items not selected stay
 * pending. The set is `applied` when no item is left pending. Another apply or close of the same set meanwhile is
 * `busy`.
 */
export function applyChangeSet(
  deps: ChangeSetDeps,
  actor: Actor,
  target: Readonly<{ eventId: string; setId: string; itemIds: readonly string[] }>,
  caller: Caller,
): Promise<SetDone<ApplyOutcome>> {
  return withSetLock(deps.pool, target.setId, caller, async () => {
    const chosen = await selectedItems(deps, actor, target);
    if (chosen.kind !== "done") {
      return chosen;
    }
    const context: RunContext = { ...deps, actor, caller, eventId: target.eventId };
    const results: ItemResult[] = [];
    for (const item of chosen.value) {
      results.push(await applyOne(deps, context, item));
    }
    return inEvent(deps.pool, actor, target.eventId, async (client) => {
      const left = (await readItems(client, target.setId)).some(
        (item) => item.status === "pending",
      );
      if (!left) {
        await finishSet(client, target.setId, "applied");
      }
      await auditSet(client, actor, caller, {
        action: "change_set.apply",
        eventId: target.eventId,
        after: {
          changeSetId: target.setId,
          applied: results.filter((one) => one.status === "applied").length,
          failed: results.filter((one) => one.status === "failed").length,
          stale: results.filter((one) => one.status === "stale").length,
        },
      });
      return done({ status: left ? ("open" as const) : ("applied" as const), results });
    });
  });
}

/** Closes an open set without applying what is still pending (FR-1035): the event stays as it is. */
export function closeChangeSet(
  deps: ChangeSetDeps,
  actor: Actor,
  target: Readonly<{ eventId: string; setId: string }>,
  caller: Caller,
): Promise<SetDone<Readonly<{ status: "closed" }>>> {
  return withSetLock(deps.pool, target.setId, caller, () =>
    inEvent(deps.pool, actor, target.eventId, async (client) => {
      const set = await readSet(client, target.eventId, target.setId, true);
      if (set === undefined) {
        return { kind: "not_found" };
      }
      if (set.status !== "open") {
        return { kind: "finished" };
      }
      await finishSet(client, set.id, "closed");
      await auditSet(client, actor, caller, {
        action: "change_set.close",
        eventId: target.eventId,
        after: { changeSetId: set.id },
      });
      return done({ status: "closed" as const });
    }),
  );
}
