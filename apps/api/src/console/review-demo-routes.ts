import { REVIEW_VERSION_MAX, REVIEW_WINDOW_DAYS } from "@questify/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { invalidReviewDemo } from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import { BUCKETS } from "#src/auth/throttle";
import type { ConsolePlatformDeps } from "#src/console/platform-routes";
import { throttled } from "#src/console/throttle";
import {
  closeReviewDemo,
  createReviewDemo,
  prepareReviewDemo,
  readReviewDemo,
  setReviewDemoContact,
  type ReviewDemoKeys,
} from "#src/console/review-demo";
import type { DeviceLimit } from "#src/devices/limits";
import { normalizeSaudiMobile } from "#src/players/phone";

const read = { config: { access: "admin" }, bodyLimit: 1024 } as const;
const write = { config: { access: "admin", idempotent: true }, bodyLimit: 1024 } as const;
// Not idempotent: a replay would have to keep the fixed code in the idempotency store; a retry makes a new code instead.
const prepare = { config: { access: "admin" }, bodyLimit: 1024 } as const;

/** 120 review demo reads a minute per admin. */
export const CONSOLE_REVIEW_DEMO_LIMIT = {
  bucket: BUCKETS.consoleReviewDemo,
  max: 120,
  windowSeconds: 60,
} as const satisfies DeviceLimit;
/** 30 review demo changes an hour per admin (create, number, prepare, close). */
export const CONSOLE_REVIEW_DEMO_WRITE_LIMIT = {
  bucket: BUCKETS.consoleReviewDemoWrite,
  max: 30,
  windowSeconds: 3600,
} as const satisfies DeviceLimit;

const phoneBody = z.strictObject({ phone: z.string().max(32) });
const prepareBody = z.strictObject({
  days: z
    .number()
    .int()
    .min(REVIEW_WINDOW_DAYS.min)
    .max(REVIEW_WINDOW_DAYS.max)
    .default(REVIEW_WINDOW_DAYS.default),
  version: z.string().trim().min(1).max(REVIEW_VERSION_MAX),
});

/** The reviewer phone as `player_contact` stores it, or 422 naming the field. */
function phoneOf(raw: unknown): string {
  const phone = normalizeSaudiMobile(parse(phoneBody, raw).phone);
  if (phone === undefined) {
    throw invalidReviewDemo({ field: "phone" });
  }
  return phone;
}

export type ConsoleReviewDemoDeps = Pick<ConsolePlatformDeps, "pool"> &
  Readonly<{ keys: ReviewDemoKeys & ConsolePlatformDeps["keys"] }>;

/**
 * The console's App Review demo (T-710, FR-1406, FR-1407, FR-1736): its state and readiness, Create, Change reviewer
 * number, Prepare for review (the new fixed code, shown once) and Close window. Registered inside the console scope,
 * whose hook answers 404 to anyone but an active platform admin; every door re-reads the admin in the database.
 */
export function registerConsoleReviewDemoRoutes(
  scope: FastifyInstance,
  deps: ConsoleReviewDemoDeps,
): void {
  scope.get("/review-demo", read, async (request, reply) => {
    const caller = await throttled(deps, request, reply, CONSOLE_REVIEW_DEMO_LIMIT);
    return { demo: await readReviewDemo(deps.pool, caller) };
  });

  scope.post("/review-demo", write, async (request, reply) => {
    const phone = phoneOf(request.body);
    const caller = await throttled(deps, request, reply, CONSOLE_REVIEW_DEMO_WRITE_LIMIT);
    const demo = await createReviewDemo(deps.pool, deps.keys, caller, {
      phone,
      requestId: request.id,
    });
    return reply.code(201).send({ demo });
  });

  scope.put("/review-demo/contact", write, async (request, reply) => {
    const phone = phoneOf(request.body);
    const caller = await throttled(deps, request, reply, CONSOLE_REVIEW_DEMO_WRITE_LIMIT);
    return {
      demo: await setReviewDemoContact(deps.pool, deps.keys, caller, {
        phone,
        requestId: request.id,
      }),
    };
  });

  scope.post("/review-demo/prepare", prepare, async (request, reply) => {
    const body = parse(prepareBody, request.body);
    const caller = await throttled(deps, request, reply, CONSOLE_REVIEW_DEMO_WRITE_LIMIT);
    const prepared = await prepareReviewDemo(deps.pool, deps.keys, caller, {
      ...body,
      requestId: request.id,
    });
    return reply.header("cache-control", "no-store").send(prepared);
  });

  scope.post("/review-demo/close", write, async (request, reply) => {
    const caller = await throttled(deps, request, reply, CONSOLE_REVIEW_DEMO_WRITE_LIMIT);
    return { demo: await closeReviewDemo(deps.pool, caller, { requestId: request.id }) };
  });
}
