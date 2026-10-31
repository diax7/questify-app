import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  deskNeeded,
  enrollmentInactive,
  eventArchived,
  featureOff,
  idempotencyKeyReused,
  invalidReward,
  limitReached,
  notDigital,
  notEnoughBalance,
  redeemPaused,
  notFound,
  ownerOnly,
  rankPrizeKept,
  reservationEnded,
  rewardLimitReached,
  rewardNotOpen,
  shopClosed,
  shopWindowLocked,
  settingLocked,
  soldOut,
  stockBelowReserved,
  stockFromCodes,
  tooManyCodes,
  unauthenticated,
} from "#src/auth/http-errors";
import { callerOf, parse } from "#src/auth/request";
import { organizerContextOf } from "#src/organizers/context";
import {
  CODES_PER_UPLOAD,
  DESK_WINDOWS,
  HANDOVER_CONFIRM,
  REWARD_KINDS,
  SECTIONS,
  addRewardCodes,
  codesRunLow,
  createReward,
  listRewards,
  removeReward,
  updateReward,
  updateShop,
  type RewardDeps,
  type RewardDone,
  type RewardRecord,
} from "#src/rewards/builder";
import { CODE_MAX_LENGTH } from "#src/rewards/codes";
import { registerHeldPrizesRoute } from "#src/rewards/held-prizes";
import { requireEventFeature } from "#src/settings/feature-guard";
import type { SettingsService } from "#src/settings/service";
import {
  cancelRedemption,
  readShop,
  reserveReward,
  setGoal,
  type ReserveResult,
  type ShopDeps,
} from "#src/rewards/shop";

const BODY_LIMIT = 16_384;

const localTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
const text = (max: number) =>
  z.strictObject({ ar: z.string().max(max).optional(), en: z.string().max(max).optional() });

const rewardFields = {
  name: text(120).optional(),
  description: text(2000).optional(),
  price: z.number().int().min(1).max(1_000_000).optional(),
  stock: z.number().int().min(0).max(100_000).optional(),
  perPlayerLimit: z.number().int().min(1).max(100).nullable().optional(),
  opensAt: localTime.nullable().optional(),
  closesAt: localTime.nullable().optional(),
  section: z.enum(SECTIONS).nullable().optional(),
  tags: z.strictObject({ new: z.boolean().optional(), limited: z.boolean().optional() }).optional(),
};
const rewardBody = z.strictObject({
  ...rewardFields,
  kind: z.enum(REWARD_KINDS),
  name: text(120),
  price: z.number().int().min(1).max(1_000_000),
});
const rewardPatch = z.strictObject(rewardFields);
const deskBody = z.strictObject({
  location: text(200).optional(),
  pin: z
    .strictObject({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) })
    .nullable()
    .optional(),
  hours: z
    .array(z.strictObject({ opensAt: localTime, closesAt: localTime }))
    .max(DESK_WINDOWS)
    .nullable()
    .optional(),
});
const shopBody = z.strictObject({
  pickupMinutes: z.number().int().min(15).max(10_080).optional(),
  daysAfter: z.number().int().min(0).max(30).optional(),
  rules: text(2000).optional(),
  spendLowersRank: z.boolean().optional(),
  desk: deskBody.optional(),
  handoverConfirm: z.enum(HANDOVER_CONFIRM).optional(),
});
/** Each code is checked again after normalizing (`normalizeCode`); this only bounds the request. */
const codesBody = z.strictObject({
  codes: z
    .array(z.string().max(CODE_MAX_LENGTH * 2))
    .min(1)
    .max(CODES_PER_UPLOAD),
});
/** 5 000 codes of up to 400 characters of JSON each, with room for the envelope. */
const CODES_BODY_LIMIT = 2_200_000;

const eventParams = z.object({ eventId: z.uuid() });
const rewardParams = z.object({ eventId: z.uuid(), rewardId: z.uuid() });

const member = { config: { access: "member" }, bodyLimit: BODY_LIMIT } as const;
const creating = { ...member, config: { ...member.config, idempotent: true } } as const;

/** A reward as the dashboard sees it: the stock, what is out and what is left (FR-504, FR-514). */
const rewardView = (reward: RewardRecord) => ({
  id: reward.id,
  kind: reward.kind,
  name: reward.name,
  description: reward.description,
  price: reward.price,
  stock: reward.stock,
  unitsOut: reward.unitsOut,
  stockLeft: reward.stock - reward.unitsOut,
  perPlayerLimit: reward.perPlayerLimit,
  opensAt: reward.opensAt?.toISOString() ?? null,
  closesAt: reward.closesAt?.toISOString() ?? null,
  section: reward.section,
  tags: reward.tags,
  position: reward.position,
  lowCodes: codesRunLow(reward),
});

type BuilderRefusal = Exclude<RewardDone<never>, { kind: "done" }>;

/** Each refusal of the dashboard's reward doors as the HTTP error it answers. */
const BUILDER_REFUSALS: {
  readonly [K in BuilderRefusal["kind"]]: (result: Extract<BuilderRefusal, { kind: K }>) => Error;
} = {
  not_found: () => notFound(),
  event_archived: () => eventArchived(),
  invalid: (result) => invalidReward({ field: result.field }),
  limit_reached: (result) => limitReached({ limit: result.limit }),
  stock_below_reserved: (result) => stockBelowReserved({ unitsOut: result.unitsOut }),
  stock_from_codes: () => stockFromCodes(),
  not_digital: () => notDigital(),
  too_many_codes: (result) => tooManyCodes({ room: result.room }),
  owner_only: () => ownerOnly(),
  setting_locked: () => settingLocked(),
  desk_needed: () => deskNeeded(),
  shop_window_locked: (result) => shopWindowLocked({ reason: result.reason }),
};

function answer<T>(result: RewardDone<T>, ok: (value: T) => unknown): unknown {
  if (result.kind === "done") {
    return ok(result.value);
  }
  const refuse = BUILDER_REFUSALS[result.kind] as (refused: BuilderRefusal) => Error;
  throw refuse(result);
}

/**
 * The dashboard's rewards (T-201): `GET`/`POST …/events/:eventId/rewards`, `PATCH`/`DELETE …/rewards/:rewardId`, and
 * `POST …/rewards/:rewardId/codes` to add a digital reward's codes (an Idempotency-Key; a replay answers the first
 * result), and `PUT …/events/:eventId/shop` for the pickup time, the days after the end (after the end only longer,
 * frozen once the shop has closed: 409 `shop_window_locked`), the rules, the prize desk (place, pin, hours, how players
 * confirm) and, for the owner only, whether spending lowers the ranking. Both answer the shop with its `state` and
 * `closesAt`. Owners and editors.
 */
export function registerRewardBuilderRoutes(scope: FastifyInstance, deps: RewardDeps): void {
  scope.get("/events/:eventId/rewards", member, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const result = await listRewards(deps, organizerContextOf(request), eventId);
    return answer(result, (value) => ({
      shop: value.shop,
      rewards: value.rewards.map(rewardView),
    }));
  });

  scope.post("/events/:eventId/rewards", creating, async (request, reply) => {
    const { eventId } = parse(eventParams, request.params);
    const body = parse(rewardBody, request.body);
    const result = await createReward(
      deps,
      organizerContextOf(request),
      eventId,
      body,
      callerOf(request),
    );
    return answer(result, (reward) => reply.code(201).send({ reward: rewardView(reward) }));
  });

  scope.patch("/events/:eventId/rewards/:rewardId", member, async (request) => {
    const { eventId, rewardId } = parse(rewardParams, request.params);
    const body = parse(rewardPatch, request.body);
    const result = await updateReward(
      deps,
      organizerContextOf(request),
      { eventId, id: rewardId },
      body,
      callerOf(request),
    );
    return answer(result, (reward) => ({ reward: rewardView(reward) }));
  });

  scope.delete("/events/:eventId/rewards/:rewardId", member, async (request, reply) => {
    const { eventId, rewardId } = parse(rewardParams, request.params);
    const result = await removeReward(
      deps,
      organizerContextOf(request),
      { eventId, id: rewardId },
      callerOf(request),
    );
    return answer(result, () => reply.code(204).send());
  });

  scope.post(
    "/events/:eventId/rewards/:rewardId/codes",
    { ...creating, bodyLimit: CODES_BODY_LIMIT },
    async (request) => {
      const { eventId, rewardId } = parse(rewardParams, request.params);
      const body = parse(codesBody, request.body);
      const result = await addRewardCodes(
        deps,
        organizerContextOf(request),
        { eventId, id: rewardId },
        body.codes,
        callerOf(request),
      );
      return answer(result, (codes) => codes);
    },
  );

  scope.put("/events/:eventId/shop", member, async (request) => {
    const { eventId } = parse(eventParams, request.params);
    const body = parse(shopBody, request.body);
    const result = await updateShop(
      deps,
      organizerContextOf(request),
      eventId,
      body,
      callerOf(request),
    );
    return answer(result, (shop) => ({ shop }));
  });
}

/** The refusals that carry nothing but their kind. */
const PLAIN_REFUSALS = {
  not_found: notFound,
  // Stryker disable next-line StringLiteral: the idempotency convention refuses a reused key first; the database's own check backs it once the stored key has expired
  key_reused: idempotencyKeyReused,
  // The event's or the platform's shop switch is off (T-602c): the same answer as the shop's read.
  feature_off: featureOff,
  sold_out: soldOut,
  not_enough_balance: notEnoughBalance,
  redeem_paused: redeemPaused,
  rank_prize: rankPrizeKept,
} as const;

function refusal(result: Exclude<ReserveResult, { kind: "done" }>): never {
  switch (result.kind) {
    case "enrollment_inactive":
      throw enrollmentInactive({ reason: result.reason });
    case "shop_closed":
      throw shopClosed({ reason: result.reason });
    case "reward_not_open":
      throw rewardNotOpen({ reason: result.reason });
    case "limit_reached":
      throw rewardLimitReached({ limit: result.limit });
    case "reservation_ended":
      throw reservationEnded({ status: result.status });
    default:
      throw PLAIN_REFUSALS[result.kind]();
  }
}

const shopParams = z.object({ eventId: z.uuid() });
const reserveParams = z.object({ rewardId: z.uuid() });
const cancelParams = z.object({ redemptionId: z.uuid() });
const goalBody = z.strictObject({ rewardId: z.uuid().nullable() });

/**
 * The player's shop (T-201, T-202): `GET /v1/events/:eventId/shop`, `POST /v1/rewards/:rewardId/reserve` (an
 * Idempotency-Key, a new one per tap), `POST /v1/redemptions/:redemptionId/cancel` (cancelling twice is harmless) and
 * `PUT /v1/events/:eventId/goal` (T-213), and `GET /v1/events/:eventId/held-prizes` (T-602d), which is not behind the shop's
 * switch.
 */
export function registerShopRoutes(
  app: FastifyInstance,
  deps: ShopDeps & Readonly<{ settings: Pick<SettingsService, "forEvent"> }>,
): void {
  registerHeldPrizesRoute(app, deps);
  app.get("/v1/events/:eventId/shop", { config: { access: "player" } }, async (request, reply) => {
    const { eventId } = parse(shopParams, request.params);
    // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the player guard answers first
    if (request.player === undefined) {
      throw unauthenticated();
    }
    await requireEventFeature(deps.settings, eventId, request.player.id, "shop");
    const view = await readShop(deps, { playerId: request.player.id, eventId });
    if (view === undefined) {
      throw notFound();
    }
    reply.header("cache-control", "no-store");
    return view;
  });

  app.post(
    "/v1/rewards/:rewardId/reserve",
    { config: { access: "player", idempotent: true }, bodyLimit: 1024 },
    async (request, reply) => {
      const { rewardId } = parse(reserveParams, request.params);
      const key = request.headers["idempotency-key"];
      // Stryker disable next-line ConditionalExpression,LogicalOperator,BlockStatement: unreachable: the player guard and the idempotency convention answer first
      if (request.player === undefined || typeof key !== "string") {
        throw unauthenticated();
      }
      const result = await reserveReward(deps, {
        playerId: request.player.id,
        rewardId,
        idempotencyKey: key,
      });
      if (result.kind !== "done") {
        return refusal(result);
      }
      return reply.code(result.value.replayed ? 200 : 201).send(result.value);
    },
  );

  app.post(
    "/v1/redemptions/:redemptionId/cancel",
    { config: { access: "player" }, bodyLimit: 1024 },
    async (request) => {
      const { redemptionId } = parse(cancelParams, request.params);
      // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the player guard answers first
      if (request.player === undefined) {
        throw unauthenticated();
      }
      const result = await cancelRedemption(deps, { playerId: request.player.id, redemptionId });
      if (result.kind !== "done") {
        return refusal(result);
      }
      return result.value;
    },
  );

  // FR-517: pin a reward as the goal, or clear it with null. A PUT sets the same value however often it is sent.
  app.put(
    "/v1/events/:eventId/goal",
    { config: { access: "player" }, bodyLimit: 1024 },
    async (request) => {
      const { eventId } = parse(shopParams, request.params);
      const { rewardId } = parse(goalBody, request.body);
      // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the player guard answers first
      if (request.player === undefined) {
        throw unauthenticated();
      }
      await requireEventFeature(deps.settings, eventId, request.player.id, "shop");
      const result = await setGoal(deps, { playerId: request.player.id, eventId, rewardId });
      if (result.kind === "not_found") {
        throw notFound();
      }
      return { goalRewardId: result.goalRewardId };
    },
  );
}
