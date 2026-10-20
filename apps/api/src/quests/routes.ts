import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  categoryNotEmpty,
  confirmRequired,
  eventClosed,
  invalidCategory,
  invalidQuest,
  lastCategory,
  limitReached,
  notFound,
  orderStale,
} from "#src/auth/http-errors";
import { callerOf, parse } from "#src/auth/request";
import { organizerContextOf } from "#src/organizers/context";
import { readBuilder, type BuilderDeps, type Done } from "#src/quests/builder";
import {
  createCategory,
  deleteCategory,
  reorderCategories,
  updateCategory,
} from "#src/quests/categories";
import { createQuest, deleteQuest, reorderQuests, updateQuest } from "#src/quests/quests";
import type { CategoryRecord, QuestRecord } from "#src/quests/store";

const BODY_LIMIT = 16_384;
const MAX_ORDER = 300;

const localTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
const text = (max: number) =>
  z.strictObject({ ar: z.string().max(max).optional(), en: z.string().max(max).optional() });
const confirm = z.boolean().optional();

const categoryBody = z.strictObject({ name: text(120), confirm });
const categoryPatch = z.strictObject({ name: text(120).optional(), confirm });
const categoryDelete = z
  .strictObject({ quests: z.enum(["move", "delete"]).optional(), to: z.uuid().optional(), confirm })
  .default({});
const questFields = {
  title: text(120).optional(),
  description: text(2000).optional(),
  points: z.number().int().min(0).max(100_000).optional(),
  repeatCap: z.number().int().min(1).max(100).optional(),
  opensAt: localTime.nullable().optional(),
  closesAt: localTime.nullable().optional(),
  visible: z.boolean().optional(),
  // Validated against the quest's type by the shared registry.
  config: z.record(z.string(), z.unknown()).optional(),
};
const questBody = z.strictObject({
  ...questFields,
  categoryId: z.uuid(),
  type: z.string().min(1).max(40),
  title: text(120),
  points: z.number().int().min(0).max(100_000),
});
const questPatch = z.strictObject({ ...questFields, categoryId: z.uuid().optional(), confirm });
const changeBody = z.strictObject({ confirm }).default({});
const orderBody = z.strictObject({ ids: z.array(z.uuid()).max(MAX_ORDER), confirm });

const eventParams = z.object({ eventId: z.uuid() });
const categoryParams = z.object({ eventId: z.uuid(), categoryId: z.uuid() });
const questParams = z.object({ eventId: z.uuid(), questId: z.uuid() });

const member = { config: { access: "member" }, bodyLimit: BODY_LIMIT } as const;
const creating = { ...member, config: { ...member.config, idempotent: true } } as const;

const categoryView = (category: CategoryRecord) => ({
  id: category.id,
  name: category.name,
  position: category.position,
});

/** A quest as the dashboard sees it; members see an entry code, players never will (T-105). */
const questView = (quest: QuestRecord) => ({
  id: quest.id,
  categoryId: quest.categoryId,
  type: quest.type,
  title: quest.title,
  description: quest.description,
  points: quest.points,
  repeatCap: quest.repeatCap,
  opensAt: quest.opensAt?.toISOString() ?? null,
  closesAt: quest.closesAt?.toISOString() ?? null,
  visible: quest.visible,
  position: quest.position,
  config: quest.config,
});

/** The answer for a result: its value through `ok`, or the error that names the refusal. */
function answer<T>(result: Done<T>, ok: (value: T) => unknown): unknown {
  switch (result.kind) {
    case "done":
      return ok(result.value);
    case "not_found":
      throw notFound();
    case "event_closed":
      throw eventClosed();
    case "confirm_required":
      throw confirmRequired();
    case "invalid":
      throw result.field === "name" || result.field === "to"
        ? invalidCategory({ field: result.field })
        : invalidQuest({ field: result.field });
    case "limit_reached":
      throw limitReached({ limit: result.limit });
    case "order_stale":
      throw orderStale();
    case "last_category":
      throw lastCategory();
    case "category_not_empty":
      throw categoryNotEmpty({ quests: result.quests });
  }
}

const empty = (reply: FastifyReply) => () => reply.code(204).send();

function registerCategoryRoutes(scope: FastifyInstance, deps: BuilderDeps): void {
  scope.post("/events/:eventId/categories", creating, async (request, reply) => {
    const { eventId } = parse(eventParams, request.params);
    const body = parse(categoryBody, request.body);
    const result = await createCategory(
      deps,
      organizerContextOf(request),
      eventId,
      body,
      callerOf(request),
    );
    return answer(result, (category) => reply.code(201).send({ category: categoryView(category) }));
  });

  scope.put("/events/:eventId/categories/order", member, async (request, reply) => {
    const { eventId } = parse(eventParams, request.params);
    const body = parse(orderBody, request.body);
    const result = await reorderCategories(
      deps,
      organizerContextOf(request),
      eventId,
      body,
      callerOf(request),
    );
    return answer(result, empty(reply));
  });

  scope.patch("/events/:eventId/categories/:categoryId", member, async (request) => {
    const { eventId, categoryId } = parse(categoryParams, request.params);
    const body = parse(categoryPatch, request.body);
    const result = await updateCategory(
      deps,
      organizerContextOf(request),
      { eventId, id: categoryId },
      body,
      callerOf(request),
    );
    return answer(result, (category) => ({ category: categoryView(category) }));
  });

  scope.delete("/events/:eventId/categories/:categoryId", member, async (request, reply) => {
    const { eventId, categoryId } = parse(categoryParams, request.params);
    const body = parse(categoryDelete, request.body ?? {});
    const result = await deleteCategory(
      deps,
      organizerContextOf(request),
      { eventId, id: categoryId },
      body,
      callerOf(request),
    );
    return answer(result, empty(reply));
  });

  scope.put(
    "/events/:eventId/categories/:categoryId/quests/order",
    member,
    async (request, reply) => {
      const { eventId, categoryId } = parse(categoryParams, request.params);
      const body = parse(orderBody, request.body);
      const result = await reorderQuests(
        deps,
        organizerContextOf(request),
        { eventId, categoryId },
        body,
        callerOf(request),
      );
      return answer(result, empty(reply));
    },
  );
}

function registerQuestRoutes(scope: FastifyInstance, deps: BuilderDeps): void {
  scope.post("/events/:eventId/quests", creating, async (request, reply) => {
    const { eventId } = parse(eventParams, request.params);
    const body = parse(questBody, request.body);
    const result = await createQuest(
      deps,
      organizerContextOf(request),
      eventId,
      body,
      callerOf(request),
    );
    return answer(result, (quest) => reply.code(201).send({ quest: questView(quest) }));
  });

  scope.patch("/events/:eventId/quests/:questId", member, async (request) => {
    const { eventId, questId } = parse(questParams, request.params);
    const body = parse(questPatch, request.body);
    const result = await updateQuest(
      deps,
      organizerContextOf(request),
      { eventId, id: questId },
      body,
      callerOf(request),
    );
    return answer(result, (quest) => ({ quest: questView(quest) }));
  });

  scope.delete("/events/:eventId/quests/:questId", member, async (request, reply) => {
    const { eventId, questId } = parse(questParams, request.params);
    const body = parse(changeBody, request.body ?? {});
    const result = await deleteQuest(
      deps,
      organizerContextOf(request),
      { eventId, id: questId },
      body,
      callerOf(request),
    );
    return answer(result, empty(reply));
  });
}

/**
 * The quest builder's routes (FR-1004–1008, FR-226–229), inside the organizer scope. Categories and quests are always
 * read under the event in the path, so an id from another event is "not found".
 */
export function registerBuilderRoutes(scope: FastifyInstance, deps: BuilderDeps): void {
  scope.get("/events/:eventId/quests", member, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const result = await readBuilder(deps, organizerContextOf(request), eventId);
    return answer(result, (builder) => ({
      categories: builder.categories.map((category) => ({
        ...categoryView(category),
        quests: category.quests.map(questView),
      })),
    }));
  });
  registerCategoryRoutes(scope, deps);
  registerQuestRoutes(scope, deps);
}
