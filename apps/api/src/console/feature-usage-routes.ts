import { USAGE_PAGE_DEFAULT, USAGE_PAGE_MAX } from "@questify/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { parse } from "#src/auth/request";
import { BUCKETS } from "#src/auth/throttle";
import { readFeatureUsage } from "#src/console/feature-usage";
import type { ConsolePlatformDeps } from "#src/console/platform-routes";
import { throttled } from "#src/console/throttle";
import type { DeviceLimit } from "#src/devices/limits";

const read = { config: { access: "admin" }, bodyLimit: 1024 } as const;

/** 60 feature usage reads a minute per admin: a page is a bounded read, and a search reads again for each press of Search. */
export const CONSOLE_FEATURE_USAGE_LIMIT = {
  bucket: BUCKETS.consoleFeatureUsage,
  max: 60,
  windowSeconds: 60,
} as const satisfies DeviceLimit;

const listQuery = z.strictObject({
  q: z.string().trim().min(1).max(254).optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(USAGE_PAGE_MAX).default(USAGE_PAGE_DEFAULT),
});

export type ConsoleFeatureUsageDeps = Pick<ConsolePlatformDeps, "pool" | "keys">;

/**
 * The console's per-organizer feature usage (T-714, FR-1839): which features each organizer has on, in how many of its
 * events, and in how many of them the feature has content. Registered inside the console scope, whose hook answers 404 to
 * anyone but an active platform admin; the database door checks the admin again. Read only, counts only, nothing audited.
 */
export function registerConsoleFeatureUsageRoutes(
  scope: FastifyInstance,
  deps: ConsoleFeatureUsageDeps,
): void {
  scope.get("/feature-usage", read, async (request, reply) => {
    const query = parse(listQuery, request.query);
    const caller = await throttled(deps, request, reply, CONSOLE_FEATURE_USAGE_LIMIT);
    return readFeatureUsage(deps.pool, caller, {
      q: query.q ?? null,
      cursor: query.cursor ?? null,
      limit: query.limit,
    });
  });
}
