import {
  bannerBodySchema,
  eventMaintenanceBodySchema,
  maintenanceBodySchema,
} from "@questify/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { notFound } from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import { CONSOLE_CATALOG_LIMIT, CONSOLE_CATALOG_WRITE_LIMIT } from "#src/console/catalog-routes";
import { throttled } from "#src/console/throttle";
import {
  accountOf,
  refuseInvalid,
  settle,
  type ConsoleSwitchesDeps,
} from "#src/console/switches-routes";
import { createPlatformNotices } from "#src/settings/platform-notices";

const read = { config: { access: "admin" }, bodyLimit: 1024 } as const;
const write = { config: { access: "admin" }, bodyLimit: 4096 } as const;

const eventParams = z.object({ eventId: z.uuid() });

/** Checks a body with the shared schema, or answers 422 with the named fields. */
function bodyOf<S extends z.ZodType>(schema: S, body: unknown): z.output<S> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw refuseInvalid(
      parsed.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    );
  }
  return parsed.data;
}

/**
 * The console's maintenance mode and banner (T-703b, FR-1771, FR-1772), registered inside the console scope whose hook
 * answers 404 to anyone but an active platform admin; the service checks the admin again and audits each change with the
 * value before and after (`platform_settings.update`). The settings cache is cleared on every save, so the wall and the
 * apps follow within the cache's time.
 */
export function registerConsoleNoticesRoutes(
  scope: FastifyInstance,
  deps: ConsoleSwitchesDeps,
): void {
  const notices = createPlatformNotices({ pool: deps.pool, forget: deps.settings.forget });

  scope.get("/switches/notices", read, async (request, reply) => {
    await throttled(deps, request, reply, CONSOLE_CATALOG_LIMIT);
    const view = await notices.view(accountOf(request));
    if (view === undefined) {
      throw notFound();
    }
    return view;
  });

  scope.put("/switches/maintenance/global", write, async (request, reply) => {
    const { message } = bodyOf(maintenanceBodySchema, request.body);
    await throttled(deps, request, reply, CONSOLE_CATALOG_WRITE_LIMIT);
    settle(
      await notices.setGlobalMaintenance(accountOf(request), message, { requestId: request.id }),
    );
    return reply.code(204).send();
  });

  scope.delete("/switches/maintenance/global", write, async (request, reply) => {
    await throttled(deps, request, reply, CONSOLE_CATALOG_WRITE_LIMIT);
    settle(await notices.setGlobalMaintenance(accountOf(request), null, { requestId: request.id }));
    return reply.code(204).send();
  });

  scope.put("/switches/maintenance/events", write, async (request, reply) => {
    const body = bodyOf(eventMaintenanceBodySchema, request.body);
    await throttled(deps, request, reply, CONSOLE_CATALOG_WRITE_LIMIT);
    settle(await notices.pauseEvent(accountOf(request), body, { requestId: request.id }));
    return reply.code(204).send();
  });

  scope.delete("/switches/maintenance/events/:eventId", write, async (request, reply) => {
    const { eventId } = parse(eventParams, request.params);
    await throttled(deps, request, reply, CONSOLE_CATALOG_WRITE_LIMIT);
    settle(await notices.resumeEvent(accountOf(request), eventId, { requestId: request.id }));
    return reply.code(204).send();
  });

  scope.put("/switches/banner", write, async (request, reply) => {
    const body = bodyOf(bannerBodySchema, request.body);
    await throttled(deps, request, reply, CONSOLE_CATALOG_WRITE_LIMIT);
    settle(await notices.setBanner(accountOf(request), body, { requestId: request.id }));
    return reply.code(204).send();
  });

  scope.delete("/switches/banner", write, async (request, reply) => {
    await throttled(deps, request, reply, CONSOLE_CATALOG_WRITE_LIMIT);
    settle(await notices.setBanner(accountOf(request), null, { requestId: request.id }));
    return reply.code(204).send();
  });
}
