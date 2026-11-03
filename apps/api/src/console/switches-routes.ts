import {
  REGISTRIES,
  featureSwitchBodySchema,
  tuningBodySchema,
  type ConfigIssue,
} from "@questify/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { invalidCatalog, notFound } from "#src/auth/http-errors";
import type { PublicAccount } from "#src/auth/staff-store";
import { parse } from "#src/auth/request";
import { CONSOLE_CATALOG_LIMIT, CONSOLE_CATALOG_WRITE_LIMIT } from "#src/console/catalog-routes";
import { throttled, type ConsolePlatformDeps } from "#src/console/platform-routes";
import { createPlatformSwitches } from "#src/settings/platform-switches";
import type { SaveResult, SettingsService } from "#src/settings/service";

const read = { config: { access: "admin" }, bodyLimit: 1024 } as const;
const write = { config: { access: "admin" }, bodyLimit: 4096 } as const;

const keyParams = z.object({ key: z.string().regex(/^[a-z][a-zA-Z0-9]*$/) });

export type ConsoleSwitchesDeps = Pick<ConsolePlatformDeps, "pool" | "keys"> &
  Readonly<{ settings: SettingsService }>;

/** The admin of a request that passed the console hook. */
export function accountOf(request: FastifyRequest): PublicAccount {
  const account = request.staff?.account;
  // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the console hook sets it or answers
  if (account === undefined) {
    throw notFound();
  }
  return account;
}

export function refuseInvalid(issues: readonly ConfigIssue[]) {
  return invalidCatalog({ issues: issues.map(({ path, message }) => ({ path, message })) });
}

/** A save's answer: nothing to say on success, 404 for a refused caller, the named fields for a bad value. */
export function settle(saved: SaveResult): void {
  if (saved.ok) {
    return;
  }
  if (saved.reason === "invalid") {
    throw refuseInvalid(saved.issues);
  }
  throw notFound();
}

/**
 * The console's platform switches and tuning numbers (T-703, FR-1405, FR-1769, FR-1770), registered inside the console
 * scope whose hook answers 404 to anyone but an active platform admin; the settings service checks the admin again and
 * audits each change with the value before and after (`platform_settings.update`). Only features and numbers the app
 * contains can be set (FR-1504); a number outside its range is refused with the range. DELETE puts one back to what the
 * app ships with. The settings cache is cleared on every save, so a change reaches the apps within the cache's time.
 */
export function registerConsoleSwitchesRoutes(
  scope: FastifyInstance,
  deps: ConsoleSwitchesDeps,
): void {
  const switches = createPlatformSwitches({
    pool: deps.pool,
    registries: REGISTRIES,
    forget: deps.settings.forget,
  });
  scope.get("/switches", read, async (request, reply) => {
    await throttled(deps, request, reply, CONSOLE_CATALOG_LIMIT);
    const view = await switches.view(accountOf(request));
    if (view === undefined) {
      throw notFound();
    }
    return view;
  });

  scope.put("/switches/features/:key", write, async (request, reply) => {
    const { key } = parse(keyParams, request.params);
    const body = featureSwitchBodySchema.safeParse(request.body);
    if (!body.success) {
      throw refuseInvalid(
        body.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      );
    }
    await throttled(deps, request, reply, CONSOLE_CATALOG_WRITE_LIMIT);
    settle(
      await switches.setFeature(accountOf(request), key, body.data, {
        requestId: request.id,
      }),
    );
    return reply.code(204).send();
  });

  scope.delete("/switches/features/:key", write, async (request, reply) => {
    const { key } = parse(keyParams, request.params);
    if (!Object.hasOwn(REGISTRIES.features, key)) {
      throw notFound();
    }
    await throttled(deps, request, reply, CONSOLE_CATALOG_WRITE_LIMIT);
    settle(
      await switches.setFeature(accountOf(request), key, null, {
        requestId: request.id,
      }),
    );
    return reply.code(204).send();
  });

  scope.put("/switches/tuning/:key", write, async (request, reply) => {
    const { key } = parse(keyParams, request.params);
    const body = tuningBodySchema.safeParse(request.body);
    if (!body.success) {
      throw refuseInvalid(
        body.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
      );
    }
    await throttled(deps, request, reply, CONSOLE_CATALOG_WRITE_LIMIT);
    settle(
      await switches.setTuning(accountOf(request), key, body.data.value, {
        requestId: request.id,
      }),
    );
    return reply.code(204).send();
  });

  scope.delete("/switches/tuning/:key", write, async (request, reply) => {
    const { key } = parse(keyParams, request.params);
    if (!Object.hasOwn(REGISTRIES.tuning, key)) {
      throw notFound();
    }
    await throttled(deps, request, reply, CONSOLE_CATALOG_WRITE_LIMIT);
    settle(
      await switches.setTuning(accountOf(request), key, null, {
        requestId: request.id,
      }),
    );
    return reply.code(204).send();
  });
}
