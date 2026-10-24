import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { PLACE_RADIUS } from "@questify/shared";
import {
  categoryInUse,
  categoryNotEmpty,
  hasCompletions,
  confirmRequired,
  eventClosed,
  invalidCategory,
  invalidItem,
  invalidQuest,
  lastCategory,
  limitReached,
  notFound,
  orderStale,
  platformFeatureOff,
  pollLocked,
  questLocked,
  rehearsalData,
  stepInUse,
  boostInUse,
  goalInUse,
  submissionKindUnavailable,
} from "#src/auth/http-errors";
import { callerOf, parse } from "#src/auth/request";
import { locationQuestsOn } from "#src/completions/complete";
import { organizerContextOf } from "#src/organizers/context";
import { readBuilder, type BuilderDeps, type Done } from "#src/quests/builder";
import {
  listCodes,
  regenerateCode,
  regenerateRevealCode,
  regenerateStepCode,
  type CodeDeps,
} from "#src/quests/codes";
import {
  createCategory,
  deleteCategory,
  reorderCategories,
  updateCategory,
} from "#src/quests/categories";
import { createQuest, deleteQuest, reorderQuests, setFocus, updateQuest } from "#src/quests/quests";
import type { CategoryRecord, QuestRecord } from "#src/quests/store";
import type { SettingsService } from "#src/settings/service";

const BODY_LIMIT = 16_384;
const MAX_ORDER = 300;

const localTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
const text = (max: number) =>
  z.strictObject({ ar: z.string().max(max).optional(), en: z.string().max(max).optional() });
const confirm = z.boolean().optional();

const categoryBody = z.strictObject({ name: text(120), confirm });
const categoryPatch = z.strictObject({
  name: text(120).optional(),
  orderMode: z.enum(["any", "in_order"]).optional(),
  opensAt: localTime.nullable().optional(),
  unlockAfter: z.uuid().nullable().optional(),
  completionBonus: z.number().int().min(0).max(100_000).optional(),
  refresh: z.enum(["none", "daily", "weekly"]).optional(),
  hidden: z.boolean().optional(),
  itemId: z.uuid().nullable().optional(),
  confirm,
});
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
  // Checked against the quest's type by the shared registry (FR-301).
  verification: z.array(z.string().max(20)).max(5).optional(),
  // A passport's steps, the full list in order (T-304b); checked as a whole by the builder.
  steps: z
    .array(z.strictObject({ id: z.uuid().optional(), name: text(120) }))
    .max(30)
    .optional(),
  // The quest item its first completion gives (T-304d); null clears it.
  itemId: z.uuid().nullable().optional(),
  // Its place on a spot type (T-303b); null clears it; checked against the type by the builder.
  place: z
    .strictObject({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
      radiusM: z.number().int().min(PLACE_RADIUS.min).max(PLACE_RADIUS.max),
    })
    .nullable()
    .optional(),
  // A flash quest (T-307): shown to players only inside its window.
  flash: z.boolean().optional(),
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
const focusBody = z.strictObject({ questId: z.uuid().nullable() });
const orderBody = z.strictObject({ ids: z.array(z.uuid()).max(MAX_ORDER), confirm });

const eventParams = z.object({ eventId: z.uuid() });
const categoryParams = z.object({ eventId: z.uuid(), categoryId: z.uuid() });
const questParams = z.object({ eventId: z.uuid(), questId: z.uuid() });
const stepParams = z.object({ eventId: z.uuid(), stepId: z.uuid() });

const member = { config: { access: "member" }, bodyLimit: BODY_LIMIT } as const;
const creating = { ...member, config: { ...member.config, idempotent: true } } as const;

const categoryView = (category: CategoryRecord) => ({
  id: category.id,
  name: category.name,
  position: category.position,
  orderMode: category.orderMode,
  opensAt: category.opensAt?.toISOString() ?? null,
  unlockAfter: category.unlockAfter,
  completionBonus: category.completionBonus,
  refresh: category.refresh,
  hidden: category.hidden,
  itemId: category.itemId,
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
  verification: quest.verification,
  itemId: quest.itemId,
  place: quest.place,
  pollSentAt: quest.pollSentAt?.toISOString() ?? null,
  flash: quest.flash,
  flashLaunchedAt: quest.flashLaunchedAt?.toISOString() ?? null,
  ...(quest.type === "passport"
    ? {
        steps: quest.steps.map((step) => ({
          id: step.id,
          name: step.name,
          position: step.position,
        })),
      }
    : {}),
});

/**
 * The answer for a result: its value through `ok`, or the error that names the refusal. A field is named as the
 * category's on the category routes and as the quest's elsewhere (both have an `opensAt`).
 */
function answer<T>(
  result: Done<T>,
  ok: (value: T) => unknown,
  subject: "quest" | "category" = "quest",
): unknown {
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
      throw subject === "category"
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
    case "category_in_use":
      throw categoryInUse({ categories: result.categories });
    case "has_completions":
      throw hasCompletions();
    case "rehearsal_data":
      throw rehearsalData();
    case "submission_kind_unavailable":
      throw submissionKindUnavailable({ asked: result.asked });
    case "quest_locked":
      throw questLocked();
    case "step_in_use":
      throw stepInUse();
    case "goal_in_use":
      throw goalInUse();
    case "boost_in_use":
      throw boostInUse();
    case "invalid_item":
      throw invalidItem();
    case "poll_locked":
      throw pollLocked({ field: result.field });
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
    return answer(
      result,
      (category) => reply.code(201).send({ category: categoryView(category) }),
      "category",
    );
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
    return answer(result, empty(reply), "category");
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
    return answer(result, (category) => ({ category: categoryView(category) }), "category");
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
    return answer(result, empty(reply), "category");
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
      return answer(result, empty(reply), "category");
    },
  );
}

function registerQuestRoutes(scope: FastifyInstance, deps: BuilderDeps & SwitchDeps): void {
  scope.post("/events/:eventId/quests", creating, async (request, reply) => {
    const { eventId } = parse(eventParams, request.params);
    const body = parse(questBody, request.body);
    // A location quest only while the platform's switch is on (ADR-208); existing ones stay and complete by QR.
    if (body.type === "location" && !(await locationQuestsOn(deps.settings))) {
      throw platformFeatureOff();
    }
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
type SwitchDeps = Readonly<{ settings: Pick<SettingsService, "forEvent"> }>;

export function registerBuilderRoutes(scope: FastifyInstance, deps: CodeDeps & SwitchDeps): void {
  scope.get("/events/:eventId/quests", member, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const result = await readBuilder(deps, organizerContextOf(request), eventId);
    return answer(result, (builder) => ({
      focusQuestId: builder.focusQuestId,
      categories: builder.categories.map((category) => ({
        ...categoryView(category),
        quests: category.quests.map(questView),
      })),
    }));
  });
  // FR-1748: the quest every player sees as Up next while it is open for them; null clears it.
  scope.put("/events/:eventId/focus", member, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const { questId } = parse(focusBody, request.body);
    const result = await setFocus(
      deps,
      organizerContextOf(request),
      eventId,
      questId,
      callerOf(request),
    );
    return answer(result, (focus) => focus);
  });
  registerCategoryRoutes(scope, deps);
  registerQuestRoutes(scope, deps);
  registerCodeRoutes(scope, deps);
}

/** The printed quest codes (FR-305), the hidden categories' secret codes (T-304c) and regenerating one (FR-1711). */
function registerCodeRoutes(scope: FastifyInstance, deps: CodeDeps): void {
  scope.get("/events/:eventId/codes", member, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const result = await listCodes(deps, organizerContextOf(request), eventId);
    return answer(result, (codes) => codes);
  });

  scope.post("/events/:eventId/quests/:questId/qr/regenerate", member, async (request) => {
    const { eventId, questId } = parse(questParams, request.params);
    const result = await regenerateCode(
      deps,
      organizerContextOf(request),
      { eventId, questId },
      callerOf(request),
    );
    return answer(result, (code) => code);
  });

  scope.post(
    "/events/:eventId/categories/:categoryId/reveal/regenerate",
    member,
    async (request) => {
      const { eventId, categoryId } = parse(categoryParams, request.params);
      const result = await regenerateRevealCode(
        deps,
        organizerContextOf(request),
        { eventId, categoryId },
        callerOf(request),
      );
      return answer(result, (code) => code, "category");
    },
  );

  scope.post("/events/:eventId/steps/:stepId/qr/regenerate", member, async (request) => {
    const { eventId, stepId } = parse(stepParams, request.params);
    const result = await regenerateStepCode(
      deps,
      organizerContextOf(request),
      { eventId, stepId },
      callerOf(request),
    );
    return answer(result, (code) => code);
  });
}
