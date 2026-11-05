import {
  ACHIEVEMENT_ID,
  ITEM_ID,
  TEMPLATE_KEY,
  itemCreateSchema,
  xpTableDocSchema,
  type CatalogKind,
} from "@questify/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { invalidCatalog } from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import { BUCKETS } from "#src/auth/throttle";
import {
  docSchemaOf,
  isConfirmable,
  listCatalog,
  revertCatalog,
  saveCatalog,
} from "#src/console/catalog";
import type { ConsolePlatformDeps } from "#src/console/platform-routes";
import { throttled } from "#src/console/throttle";
import { createItem, previewXpTable } from "#src/console/xp-table";
import type { DeviceLimit } from "#src/devices/limits";

const read = { config: { access: "admin" }, bodyLimit: 1024 } as const;
// A 100-level XP table is about 6,000 bytes.
const preview = { config: { access: "admin" }, bodyLimit: 32 * 1024 } as const;
const create = { config: { access: "admin" }, bodyLimit: 4 * 1024 } as const;
// A template body is at most 30,000 bytes; the rest is its names and descriptions.
const write = { config: { access: "admin" }, bodyLimit: 128 * 1024 } as const;
const revert = { config: { access: "admin", idempotent: true }, bodyLimit: 1024 } as const;

/** 240 catalog reads a minute per admin: each tab reads its list when it opens and the XP table previews every edit. */
export const CONSOLE_CATALOG_LIMIT = {
  bucket: BUCKETS.consoleCatalog,
  max: 240,
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
   * The names the answers use: `{ [list]: rows }` and `{ [one]: row }`. Undefined for the level titles and the amounts,
   * each one document with no id in the address: their answer is the document itself.
   */
  names: Readonly<{ list: string; one: string }> | undefined;
  id: z.ZodType<string> | undefined;
  /** The editor changes what `GET /v1/config` composes, so a change clears the settings cache (T-713). */
  composed?: true;
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
  { kind: "amounts", path: "/catalog/amounts", names: undefined, id: undefined },
  { kind: "xp_table", path: "/catalog/xp-table", names: undefined, id: undefined },
  {
    kind: "item",
    path: "/catalog/items",
    names: { list: "items", one: "item" },
    id: z.string().regex(ITEM_ID),
  },
  {
    kind: "home_layout",
    path: "/catalog/home-layout",
    names: undefined,
    id: undefined,
    composed: true,
  },
  {
    kind: "player_intro",
    path: "/catalog/player-intro",
    names: undefined,
    id: undefined,
    composed: true,
  },
];

const confirmation = z.strictObject({ confirmed: z.boolean().optional() });
/** A revert body of an editor that takes no confirmation: empty. */
const noConfirmation = z.strictObject({ confirmed: z.never().optional() });

/**
 * A save's body split into the document and the confirmation. Only an editor that can pay gems (the achievements) takes
 * `confirmed`; anywhere else it is an unknown field the document's schema refuses.
 */
function splitConfirmed(
  kind: CatalogKind,
  body: unknown,
): Readonly<{ doc: unknown; confirmed: boolean }> {
  if (!isConfirmable(kind) || typeof body !== "object" || body === null || Array.isArray(body)) {
    return { doc: body, confirmed: false };
  }
  const { confirmed, ...doc } = body as Record<string, unknown>;
  return { doc, confirmed: parse(confirmation, { confirmed }).confirmed === true };
}

function invalidBody(issues: readonly z.core.$ZodIssue[]) {
  return invalidCatalog({
    issues: issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  });
}

/** What the catalog routes need beyond the console's: how to drop the settings cache after a change to the composed config. */
export type ConsoleCatalogDeps = Pick<ConsolePlatformDeps, "pool" | "keys"> &
  Readonly<{ forgetConfig: () => void }>;

function registerCatalog(scope: FastifyInstance, deps: ConsoleCatalogDeps, catalog: Catalog): void {
  const { kind } = catalog;
  const idPath = catalog.id === undefined ? "" : "/:id";
  const changed = (): void => {
    if (catalog.composed === true) {
      deps.forgetConfig();
    }
  };
  const idOf = (params: unknown): string =>
    catalog.id === undefined ? "all" : parse(z.object({ id: catalog.id }), params).id;

  scope.get(catalog.path, read, async (request, reply) => {
    const caller = await throttled(deps, request, reply, CONSOLE_CATALOG_LIMIT);
    const rows = await listCatalog(deps.pool, caller, kind);
    return catalog.names === undefined ? rows[0] : { [catalog.names.list]: rows };
  });

  scope.put(`${catalog.path}${idPath}`, write, async (request, reply) => {
    const id = idOf(request.params);
    const { doc, confirmed } = splitConfirmed(kind, request.body);
    const checked = docSchemaOf(kind).safeParse(doc);
    if (!checked.success) {
      throw invalidBody(checked.error.issues);
    }
    const caller = await throttled(deps, request, reply, CONSOLE_CATALOG_WRITE_LIMIT);
    const row = await saveCatalog(deps.pool, caller, kind, {
      id,
      input: checked.data,
      requestId: request.id,
      confirmed,
    });
    changed();
    return catalog.names === undefined ? row : { [catalog.names.one]: row };
  });

  scope.post(`${catalog.path}${idPath}/revert`, revert, async (request, reply) => {
    const id = idOf(request.params);
    const { confirmed } = parse(
      isConfirmable(kind) ? confirmation : noConfirmation,
      request.body ?? {},
    );
    const caller = await throttled(deps, request, reply, CONSOLE_CATALOG_WRITE_LIMIT);
    const row = await revertCatalog(deps.pool, caller, kind, {
      id,
      requestId: request.id,
      confirmed: confirmed === true,
    });
    changed();
    return catalog.names === undefined ? row : { [catalog.names.one]: row };
  });
}

/**
 * The XP table's preview (a read: what a table would do to active players now) and a new item (a change, audited), both
 * checked against the shared schema here and again by their doors (T-709d).
 */
function registerXpTableExtras(
  scope: FastifyInstance,
  deps: Pick<ConsolePlatformDeps, "pool" | "keys">,
): void {
  scope.post("/catalog/xp-table/preview", preview, async (request, reply) => {
    const checked = xpTableDocSchema.safeParse(request.body);
    if (!checked.success) {
      throw invalidBody(checked.error.issues);
    }
    const caller = await throttled(deps, request, reply, CONSOLE_CATALOG_LIMIT);
    return previewXpTable(deps.pool, caller, checked.data);
  });

  scope.post("/catalog/items", create, async (request, reply) => {
    const checked = itemCreateSchema.safeParse(request.body);
    if (!checked.success) {
      throw invalidBody(checked.error.issues);
    }
    const caller = await throttled(deps, request, reply, CONSOLE_CATALOG_WRITE_LIMIT);
    reply.code(201);
    return {
      item: await createItem(deps.pool, caller, { doc: checked.data, requestId: request.id }),
    };
  });
}

/**
 * The console's catalog editors (T-709b, T-709c, T-709d, FR-1403): event templates, achievements (names and thresholds),
 * level titles, the gem shop, the XP and gem amounts, the XP table with its level rewards, Questify's items, and Questify
 * home's layout (T-713, FR-1838) and the player intro's cards (T-802b, FR-1803). Each is a
 * list, a save and a revert, registered inside the console scope whose hook answers 404 to anyone but an active platform
 * admin; every door re-reads the admin in the database. A save is checked against the editor's schema here and again by
 * the door, and is audited with the fields before and after; a revert is the same save with the earlier fields. The XP
 * table also has a preview, and the items a create.
 */
export function registerConsoleCatalogRoutes(
  scope: FastifyInstance,
  deps: ConsoleCatalogDeps,
): void {
  for (const catalog of CATALOGS) {
    registerCatalog(scope, deps, catalog);
  }
  registerXpTableExtras(scope, deps);
}
