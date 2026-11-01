import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { notFound } from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import { listUsage, readOrganizerUsage } from "#src/usage/admin";

const read = { config: { access: "admin" }, bodyLimit: 1024 } as const;
const organizerParams = z.object({ organizerId: z.uuid() });

/** The id of the admin the console hook set on the request. */
function adminOf(account: Readonly<{ id: string }> | undefined): string {
  // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the console hook sets it or answers
  if (account === undefined) throw notFound();
  return account.id;
}

/**
 * The console's usage view (T-609, FR-1730): registered inside the console scope, whose hook answers 404 to anyone but
 * an active platform admin and sets `no-store`. Read only, counts only, nothing audited (no personal data).
 */
export function registerConsoleUsageRoutes(
  scope: FastifyInstance,
  deps: Readonly<{ pool: Pool }>,
): void {
  scope.get("/usage", read, async (request) =>
    listUsage(deps.pool, adminOf(request.staff?.account)),
  );
  scope.get("/usage/organizers/:organizerId", read, async (request) => {
    const { organizerId } = parse(organizerParams, request.params);
    return readOrganizerUsage(deps.pool, adminOf(request.staff?.account), organizerId);
  });
}
