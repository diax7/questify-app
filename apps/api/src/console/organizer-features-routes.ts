import { REGISTRIES, organizerOverrideBodySchema } from "@questify/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { invalidCatalog, notFound } from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import type { PublicAccount } from "#src/auth/staff-store";
import { CONSOLE_CATALOG_LIMIT, CONSOLE_CATALOG_WRITE_LIMIT } from "#src/console/catalog-routes";
import { throttled, type ConsolePlatformDeps } from "#src/console/platform-routes";
import {
  createOrganizerOverrides,
  type OrganizerOverrideService,
  type OverrideResult,
} from "#src/settings/organizer-overrides";
import type { SettingsService } from "#src/settings/service";

const read = { config: { access: "admin" }, bodyLimit: 1024 } as const;
const write = { config: { access: "admin" }, bodyLimit: 1024 } as const;

const params = z.object({
  organizerId: z.uuid(),
  key: z.string().regex(/^[a-z][a-zA-Z0-9]*$/),
});
const organizerParams = z.object({ organizerId: z.uuid() });

export type ConsoleOrganizerFeaturesDeps = Pick<ConsolePlatformDeps, "pool" | "keys"> &
  Readonly<{ settings: SettingsService }>;

/** The admin of a request that passed the console hook. */
function accountOf(request: FastifyRequest): PublicAccount {
  const account = request.staff?.account;
  // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the console hook sets it or answers
  if (account === undefined) {
    throw notFound();
  }
  return account;
}

/** A save's answer: nothing on success, 404 for a refused caller or an unknown organizer, 422 for a feature that cannot be overridden. */
function settle(saved: OverrideResult): void {
  if (saved.ok) {
    return;
  }
  if (saved.reason === "not_overridable") {
    throw invalidCatalog({
      issues: [{ path: "feature", message: "cannot be overridden for one organizer" }],
    });
  }
  throw notFound();
}

async function setOverride(
  overrides: OrganizerOverrideService,
  request: FastifyRequest,
  enabled: boolean | null,
): Promise<void> {
  const { organizerId, key } = parse(params, request.params);
  settle(
    await overrides.set(accountOf(request), organizerId, key, enabled, { requestId: request.id }),
  );
}

/**
 * The console's per-organizer feature overrides (T-711, FR-1826), registered inside the console scope whose hook answers
 * 404 to anyone but an active platform admin; the service checks the admin again and audits each change with the value
 * before and after (`organizer.feature_override.set` and `.clear`). Only the 16 event-level features (T-711b)
 * can be overridden; an override acts at once on the composed configuration and the SQL rules (cache cleared on every save).
 */
export function registerConsoleOrganizerFeaturesRoutes(
  scope: FastifyInstance,
  deps: ConsoleOrganizerFeaturesDeps,
): void {
  const overrides = createOrganizerOverrides({
    pool: deps.pool,
    registries: REGISTRIES,
    forget: deps.settings.forget,
  });

  scope.get("/organizers/:organizerId/features", read, async (request, reply) => {
    const { organizerId } = parse(organizerParams, request.params);
    await throttled(deps, request, reply, CONSOLE_CATALOG_LIMIT);
    const view = await overrides.view(accountOf(request), organizerId);
    if (view === undefined) {
      throw notFound();
    }
    return view;
  });

  scope.put("/organizers/:organizerId/features/:key", write, async (request, reply) => {
    const body = organizerOverrideBodySchema.safeParse(request.body);
    if (!body.success) {
      throw invalidCatalog({
        issues: body.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }
    await throttled(deps, request, reply, CONSOLE_CATALOG_WRITE_LIMIT);
    await setOverride(overrides, request, body.data.enabled);
    return reply.code(204).send();
  });

  scope.delete("/organizers/:organizerId/features/:key", write, async (request, reply) => {
    await throttled(deps, request, reply, CONSOLE_CATALOG_WRITE_LIMIT);
    await setOverride(overrides, request, null);
    return reply.code(204).send();
  });
}
