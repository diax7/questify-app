import {
  MESSAGE_TEMPLATE_KEYS,
  messageTemplateDocSchema,
  supportContactSchema,
  templateIssues,
  type MessageTemplateDoc,
  type MessageTemplateKey,
} from "@questify/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { invalidCatalog } from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import { CONSOLE_CATALOG_LIMIT, CONSOLE_CATALOG_WRITE_LIMIT } from "#src/console/catalog-routes";
import {
  listTemplates,
  readSupportContact,
  revertTemplate,
  saveSupportContact,
  saveTemplate,
} from "#src/console/messaging";
import { throttled, type ConsolePlatformDeps } from "#src/console/platform-routes";

const read = { config: { access: "admin" }, bodyLimit: 1024 } as const;
const write = { config: { access: "admin" }, bodyLimit: 32 * 1024 } as const;
const revert = { config: { access: "admin", idempotent: true }, bodyLimit: 1024 } as const;

const templateParams = z.object({ key: z.enum(MESSAGE_TEMPLATE_KEYS) });

type Issue = Readonly<{ path: readonly PropertyKey[] | string; message: string }>;

/** What a body that fails its checks answers: the named fields, as the catalog editors do. */
function refuseBody(issues: readonly Issue[]) {
  return invalidCatalog({
    issues: issues.map((issue) => ({
      path: typeof issue.path === "string" ? issue.path : issue.path.map(String).join("."),
      message: issue.message,
    })),
  });
}

/** Throws the refusal naming every CST or structure rule the template breaks, if it breaks any. */
function requireAllowed(key: MessageTemplateKey, doc: MessageTemplateDoc): void {
  const issues = templateIssues(key, doc);
  if (issues.length > 0) {
    throw refuseBody(issues);
  }
}

/**
 * The console's message templates and support contact (T-706, FR-1780, FR-1731), registered inside the console scope
 * whose hook answers 404 to anyone but an active platform admin; every door re-reads the admin in the database. A
 * template that breaks a CST rule (no purpose, no opt-out, too many SMS parts) is refused with the fields named.
 */
export function registerConsoleMessagingRoutes(
  scope: FastifyInstance,
  deps: Pick<ConsolePlatformDeps, "pool" | "keys">,
): void {
  scope.get("/message-templates", read, async (request, reply) => {
    const caller = await throttled(deps, request, reply, CONSOLE_CATALOG_LIMIT);
    return { templates: await listTemplates(deps.pool, caller) };
  });

  scope.put("/message-templates/:key", write, async (request, reply) => {
    const { key } = parse(templateParams, request.params);
    const checked = messageTemplateDocSchema.safeParse(request.body);
    if (!checked.success) {
      throw refuseBody(checked.error.issues);
    }
    requireAllowed(key, checked.data);
    const caller = await throttled(deps, request, reply, CONSOLE_CATALOG_WRITE_LIMIT);
    return {
      template: await saveTemplate(deps.pool, caller, {
        key,
        doc: checked.data,
        requestId: request.id,
      }),
    };
  });

  scope.post("/message-templates/:key/revert", revert, async (request, reply) => {
    const { key } = parse(templateParams, request.params);
    parse(z.strictObject({}), request.body ?? {});
    const caller = await throttled(deps, request, reply, CONSOLE_CATALOG_WRITE_LIMIT);
    return {
      template: await revertTemplate(deps.pool, caller, {
        key,
        requestId: request.id,
        check: (doc) => requireAllowed(key, doc),
      }),
    };
  });

  scope.get("/support-contact", read, async (request, reply) => {
    const caller = await throttled(deps, request, reply, CONSOLE_CATALOG_LIMIT);
    return { contact: await readSupportContact(deps.pool, caller) };
  });

  scope.put("/support-contact", write, async (request, reply) => {
    const checked = supportContactSchema.safeParse(request.body);
    if (!checked.success) {
      throw refuseBody(checked.error.issues);
    }
    const caller = await throttled(deps, request, reply, CONSOLE_CATALOG_WRITE_LIMIT);
    return {
      contact: await saveSupportContact(deps.pool, caller, {
        contact: checked.data,
        requestId: request.id,
      }),
    };
  });
}
