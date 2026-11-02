import { ACHIEVEMENT_ID, ITEM_ID, TEMPLATE_KEY, type CatalogKind } from "@questify/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { invalidCatalog } from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import { BUCKETS } from "#src/auth/throttle";
import { docSchemaOf, listCatalog, revertCatalog, saveCatalog } from "#src/console/catalog";
import { throttled, type ConsolePlatformDeps } from "#src/console/platform-routes";
import type { DeviceLimit } from "#src/devices/limits";

const read = { config: { access: "admin" }, bodyLimit: 1024 } as const;
// A template body is at most 30,000 bytes; the rest is its names and descriptions.
const write = { config: { access: "admin" }, bodyLimit: 128 * 1024 } as const;
const revert = { config: { access: "admin", idempotent: true }, bodyLimit: 1024 } as const;

/** 60 catalog reads a minute per admin: each tab reads its list once when it opens. */
export const CONSOLE_CATALOG_LIMIT = {
  bucket: BUCKETS.consoleCatalog,
  max: 60,
  windowSeconds: 60,
} as const satisfies DeviceLimit;
/** 120 catalog changes and reverts an hour per admin. */
export const CONSOLE_CATALOG_WRITE_LIMIT = {
  bucket: BUCKETS.consoleCatalogWrite,
  max: 120,
  windowSeconds: 3600,
} as const satisfies DeviceLimit;

type Catalog = Readonly<{
  kind: CatalogKind;
  path: string;
  /**
   * The names the answers use: `{ [list]: rows }` and `{ [one]: row }`. Undefined for the level titles, which are one
   * document with no id in the address: their answer is the document itself.
   */
  names: Readonly<{ list: string; one: string }> | undefined;
  id: z.ZodType<string> | undefined;
}>;

const CATALOGS: readonly Catalog[] = [
  {
    kind: "template",
    path: "/catalog/templates",
    names: { list: "templates", one: "template" },
    id: z.string().regex(TEMPLATE_KEY),
  },
  {
    kind: "achievement",
    path: "/catalog/achievements",
    names: { list: "achievements", one: "achievement" },
    id: z.string().regex(ACHIEVEMENT_ID),
  },
  { kind: "level_titles", path: "/catalog/level-titles", names: undefined, id: undefined },
  {
    kind: "gem_shop",
    path: "/catalog/gem-shop",
    names: { list: "items", one: "item" },
    id: z.string().regex(ITEM_ID),
  },
];

function registerCatalog(
  scope: FastifyInstance,
  deps: Pick<ConsolePlatformDeps, "pool" | "keys">,
  catalog: Catalog,
): void {
  const { kind } = catalog;
  const idPath = catalog.id === undefined ? "" : "/:id";
  const idOf = (params: unknown): string =>
    catalog.id === undefined ? "all" : parse(z.object({ id: catalog.id }), params).id;

  scope.get(catalog.path, read, async (request, reply) => {
    const caller = await throttled(deps, request, reply, CONSOLE_CATALOG_LIMIT);
    const rows = await listCatalog(deps.pool, caller, kind);
    return catalog.names === undefined ? rows[0] : { [catalog.names.list]: rows };
  });

  scope.put(`${catalog.path}${idPath}`, write, async (request, reply) => {
    const id = idOf(request.params);
    const checked = docSchemaOf(kind).safeParse(request.body);
    if (!checked.success) {
      throw invalidCatalog({
        issues: checked.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
    }
    const caller = await throttled(deps, request, reply, CONSOLE_CATALOG_WRITE_LIMIT);
    const row = await saveCatalog(deps.pool, caller, kind, {
      id,
      input: checked.data,
      requestId: request.id,
    });
    return catalog.names === undefined ? row : { [catalog.names.one]: row };
  });

  scope.post(`${catalog.path}${idPath}/revert`, revert, async (request, reply) => {
    const id = idOf(request.params);
    parse(z.strictObject({}), request.body ?? {});
    const caller = await throttled(deps, request, reply, CONSOLE_CATALOG_WRITE_LIMIT);
    const row = await revertCatalog(deps.pool, caller, kind, { id, requestId: request.id });
    return catalog.names === undefined ? row : { [catalog.names.one]: row };
  });
}

/**
 * The console's catalog editors (T-709b, FR-1403): event templates, achievements, level titles and the gem shop. Each is a
 * list, a save and a revert, registered inside the console scope whose hook answers 404 to anyone but an active platform
 * admin; every door re-reads the admin in the database. A save is checked against the editor's schema here and again by
 * the door, and is audited with the fields before and after; a revert is the same save with the earlier fields.
 */
export function registerConsoleCatalogRoutes(
  scope: FastifyInstance,
  deps: Pick<ConsolePlatformDeps, "pool" | "keys">,
): void {
  for (const catalog of CATALOGS) {
    registerCatalog(scope, deps, catalog);
  }
}
