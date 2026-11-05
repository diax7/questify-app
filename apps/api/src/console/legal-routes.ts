import { HELP_ID, LEGAL_DOCUMENT_IDS, helpDocSchema, legalPublishSchema } from "@questify/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { invalidCatalog } from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import { CONSOLE_CATALOG_LIMIT, CONSOLE_CATALOG_WRITE_LIMIT } from "#src/console/catalog-routes";
import { listHelp, listLegal, publishLegal, revertHelp, saveHelp } from "#src/console/legal";
import type { ConsolePlatformDeps } from "#src/console/platform-routes";
import { throttled } from "#src/console/throttle";

const read = { config: { access: "admin" }, bodyLimit: 1024 } as const;
// A legal text is at most 100,000 characters in each language, which is up to about 600 KB as UTF-8.
const publish = { config: { access: "admin", idempotent: true }, bodyLimit: 700 * 1024 } as const;
const write = { config: { access: "admin" }, bodyLimit: 32 * 1024 } as const;
const revert = { config: { access: "admin", idempotent: true }, bodyLimit: 1024 } as const;

const documentParams = z.object({ document: z.enum(LEGAL_DOCUMENT_IDS) });
const articleParams = z.object({ id: z.string().regex(HELP_ID) });

/** What a body that fails its schema answers: the named fields, as the catalog editors do. */
function refuseBody(
  issues: readonly Readonly<{ path: readonly PropertyKey[]; message: string }>[],
) {
  return invalidCatalog({
    issues: issues.map((issue) => ({
      path: issue.path.map(String).join("."),
      message: issue.message,
    })),
  });
}

/**
 * The console's legal documents and help articles (T-707, FR-1781, FR-1782), registered inside the console scope whose
 * hook answers 404 to anyone but an active platform admin; every door re-reads the admin in the database. A publish
 * adds a version that is in force at once; a help save is audited with the fields before and after and can be reverted.
 */
export function registerConsoleLegalRoutes(
  scope: FastifyInstance,
  deps: Pick<ConsolePlatformDeps, "pool" | "keys">,
): void {
  scope.get("/legal", read, async (request, reply) => {
    const caller = await throttled(deps, request, reply, CONSOLE_CATALOG_LIMIT);
    return listLegal(deps.pool, caller);
  });

  scope.post("/legal/:document/versions", publish, async (request, reply) => {
    const { document } = parse(documentParams, request.params);
    const checked = legalPublishSchema.safeParse(request.body);
    if (!checked.success) {
      throw refuseBody(checked.error.issues);
    }
    const caller = await throttled(deps, request, reply, CONSOLE_CATALOG_WRITE_LIMIT);
    const made = await publishLegal(deps.pool, caller, {
      document,
      input: checked.data,
      requestId: request.id,
    });
    return reply.code(201).send(made);
  });

  scope.get("/help", read, async (request, reply) => {
    const caller = await throttled(deps, request, reply, CONSOLE_CATALOG_LIMIT);
    return { articles: await listHelp(deps.pool, caller) };
  });

  scope.put("/help/:id", write, async (request, reply) => {
    const { id } = parse(articleParams, request.params);
    const checked = helpDocSchema.safeParse(request.body);
    if (!checked.success) {
      throw refuseBody(checked.error.issues);
    }
    const caller = await throttled(deps, request, reply, CONSOLE_CATALOG_WRITE_LIMIT);
    return {
      article: await saveHelp(deps.pool, caller, { id, doc: checked.data, requestId: request.id }),
    };
  });

  scope.post("/help/:id/revert", revert, async (request, reply) => {
    const { id } = parse(articleParams, request.params);
    parse(z.strictObject({}), request.body ?? {});
    const caller = await throttled(deps, request, reply, CONSOLE_CATALOG_WRITE_LIMIT);
    return { article: await revertHelp(deps.pool, caller, { id, requestId: request.id }) };
  });
}
