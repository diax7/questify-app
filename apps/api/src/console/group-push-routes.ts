import { checkGroupPushText, groupPushBodySchema, type GroupPushBody } from "@questify/shared";
import type { FastifyInstance } from "fastify";
import { BUCKETS } from "#src/auth/throttle";
import { CONSOLE_CATALOG_LIMIT } from "#src/console/catalog-routes";
import { listGroupPushes, previewGroupPush, sendGroupPush } from "#src/console/group-push";
import { throttled, type ConsolePlatformDeps } from "#src/console/platform-routes";
import { refuseInvalid } from "#src/console/switches-routes";
import type { DeviceLimit } from "#src/devices/limits";

const read = { config: { access: "admin" }, bodyLimit: 1024 } as const;
const preview = { config: { access: "admin" }, bodyLimit: 16 * 1024 } as const;
const send = { config: { access: "admin", idempotent: true }, bodyLimit: 16 * 1024 } as const;

/** 10 group pushes an hour per admin; the database also holds the platform to 20 an hour. */
export const CONSOLE_GROUP_PUSH_LIMIT = {
  bucket: BUCKETS.consoleGroupPush,
  max: 10,
  windowSeconds: 3600,
} as const satisfies DeviceLimit;

/**
 * Checks a body with the shared schema and the text rules (the promotional push's template rules and the name rule),
 * or answers 422 naming every field that fails. What comes back carries the cleaned text, which is what is sent.
 */
function checkedBody(raw: unknown): GroupPushBody {
  const parsed = groupPushBodySchema.safeParse(raw);
  if (!parsed.success) {
    throw refuseInvalid(
      parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message,
      })),
    );
  }
  const text = checkGroupPushText(parsed.data);
  if (!text.ok) {
    throw refuseInvalid(text.issues);
  }
  return { ...parsed.data, ...text.text };
}

/**
 * The console's push to a group (T-706b, FR-1777), registered inside the console scope whose hook answers 404 to anyone
 * but an active platform admin; every door re-reads the admin in the database. A preview says who a send would reach, a
 * send needs an Idempotency-Key, and the list shows the last 50 sends with how far each has got.
 */
export function registerConsoleGroupPushRoutes(
  scope: FastifyInstance,
  deps: Pick<ConsolePlatformDeps, "pool" | "keys">,
): void {
  scope.get("/group-pushes", read, async (request, reply) => {
    const caller = await throttled(deps, request, reply, CONSOLE_CATALOG_LIMIT);
    return { pushes: await listGroupPushes(deps.pool, caller) };
  });

  scope.post("/group-pushes/preview", preview, async (request, reply) => {
    const body = checkedBody(request.body);
    const caller = await throttled(deps, request, reply, CONSOLE_CATALOG_LIMIT);
    return { preview: await previewGroupPush(deps.pool, caller, body) };
  });

  scope.post("/group-pushes", send, async (request, reply) => {
    const body = checkedBody(request.body);
    const caller = await throttled(deps, request, reply, CONSOLE_GROUP_PUSH_LIMIT);
    const push = await sendGroupPush(deps.pool, caller, { body, requestId: request.id });
    return reply.code(201).send({ push });
  });
}
