import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  changeSetBusy,
  changeSetFinished,
  eventClosed,
  invalidChangeSet,
  limitReached,
  notFound,
} from "#src/auth/http-errors";
import { callerOf, parse } from "#src/auth/request";
import {
  SET_LIMITS,
  applyChangeSet,
  closeChangeSet,
  createChangeSet,
  listChangeSets,
  readChangeSet,
  type ChangeSetDeps,
  type SetDone,
} from "#src/change-sets/change-sets";
import type { SetRecord, SetSummary } from "#src/change-sets/store";
import { organizerContextOf } from "#src/organizers/context";

const ITEM_BYTES = 16_384;
/** A full set of items at their largest, with room for the envelope. */
const CREATE_BODY_LIMIT = SET_LIMITS.items * (ITEM_BYTES + 512);

const item = z
  .strictObject({
    op: z.enum(["add", "edit", "delete"]),
    target: z.enum(["quest", "category", "reward"]),
    targetId: z.uuid().optional(),
    body: z.record(z.string(), z.unknown()).default({}),
  })
  .refine((one) => (one.op === "add") === (one.targetId === undefined), {
    path: ["targetId"],
  })
  .refine((one) => JSON.stringify(one.body).length <= ITEM_BYTES, { path: ["body"] });
const createBody = z.strictObject({ items: z.array(item).min(1).max(SET_LIMITS.items) });
const applyBody = z.strictObject({ itemIds: z.array(z.uuid()).min(1).max(SET_LIMITS.items) });
const emptyBody = z.union([z.strictObject({}), z.undefined(), z.null()]);

const eventParams = z.object({ eventId: z.uuid() });
const setParams = z.object({ eventId: z.uuid(), setId: z.uuid() });

const member = { config: { access: "member" }, bodyLimit: 1024 } as const;
const writing = { config: { access: "member", idempotent: true } } as const;

/** The value of a call, or the refusal as the HTTP error it answers. */
function valueOf<T>(result: SetDone<T>): T {
  switch (result.kind) {
    case "done":
      return result.value;
    case "not_found":
      throw notFound();
    case "event_closed":
      throw eventClosed();
    case "finished":
      throw changeSetFinished();
    case "busy":
      throw changeSetBusy();
    case "limit_reached":
      throw limitReached({ limit: result.limit });
    case "invalid":
      throw invalidChangeSet({ field: result.field });
  }
}

const setView = (set: SetRecord) => ({
  id: set.id,
  status: set.status,
  createdAt: set.createdAt.toISOString(),
  finishedAt: set.finishedAt?.toISOString() ?? null,
});

const summaryView = (set: SetSummary) => ({
  ...setView(set),
  items: set.items,
  pending: set.pending,
});

/**
 * Change sets (T-604b, FR-1034, FR-1035): `POST …/events/:eventId/change-sets` makes a set of up to 100 items (add,
 * edit or delete of a quest, a category or a reward; nothing is applied), `GET` lists them, `GET …/:setId` opens one
 * with each item checked now (invalid with its reason, stale, or ready, and what it would change), `POST …/:setId/apply`
 * applies the selected items one by one through the builder's own services (a refused item is `failed`, a changed target
 * `stale`), and `POST …/:setId/close` closes it without applying the rest. Owners and editors within their event limit.
 */
export function registerChangeSetRoutes(scope: FastifyInstance, deps: ChangeSetDeps): void {
  scope.get("/events/:eventId/change-sets", member, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const sets = valueOf(await listChangeSets(deps, organizerContextOf(request), eventId));
    return { changeSets: sets.map(summaryView) };
  });

  scope.post(
    "/events/:eventId/change-sets",
    { ...writing, bodyLimit: CREATE_BODY_LIMIT },
    async (request, reply) => {
      const { eventId } = parse(eventParams, request.params);
      const body = parse(createBody, request.body);
      const items = body.items.map((one) => ({
        op: one.op,
        target: one.target,
        targetId: one.targetId ?? null,
        body: one.body,
      }));
      const made = valueOf(
        await createChangeSet(deps, organizerContextOf(request), eventId, items, callerOf(request)),
      );
      return reply.code(201).send({ changeSet: summaryView(made) });
    },
  );

  scope.get("/events/:eventId/change-sets/:setId", member, async (request) => {
    const { eventId, setId } = parse(setParams, request.params);
    const set = valueOf(await readChangeSet(deps, organizerContextOf(request), { eventId, setId }));
    return {
      changeSet: { ...setView(set), items: set.items },
    };
  });

  scope.post(
    "/events/:eventId/change-sets/:setId/apply",
    { ...writing, bodyLimit: 8192 },
    async (request) => {
      const { eventId, setId } = parse(setParams, request.params);
      const { itemIds } = parse(applyBody, request.body);
      const applied = valueOf(
        await applyChangeSet(
          deps,
          organizerContextOf(request),
          { eventId, setId, itemIds },
          callerOf(request),
        ),
      );
      return { changeSet: { id: setId, status: applied.status }, results: applied.results };
    },
  );

  scope.post(
    "/events/:eventId/change-sets/:setId/close",
    { ...writing, bodyLimit: 1024 },
    async (request) => {
      const { eventId, setId } = parse(setParams, request.params);
      parse(emptyBody, request.body);
      const closed = valueOf(
        await closeChangeSet(
          deps,
          organizerContextOf(request),
          { eventId, setId },
          callerOf(request),
        ),
      );
      return { changeSet: { id: setId, status: closed.status } };
    },
  );
}
