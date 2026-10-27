import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { notFound } from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import { readConsentHistory } from "#src/marketing/marketing";

const playerParams = z.object({ playerId: z.uuid() });

/**
 * A platform admin's read of one player's marketing consent (T-407, FR-1113): where each channel stands and the dated
 * log. Registered inside the console scope, whose hook answers 404 to anyone but an active platform admin and sets
 * `no-store`; the database checks the admin again and audits every read. It shows no contact, only channels and dates.
 */
export function registerConsoleMarketingRoutes(
  scope: FastifyInstance,
  deps: Readonly<{ pool: Pool }>,
): void {
  scope.get(
    "/players/:playerId/marketing-consent",
    { config: { access: "admin" }, bodyLimit: 1024 },
    async (request) => {
      const { playerId } = parse(playerParams, request.params);
      const account = request.staff?.account;
      // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the console hook sets it or answers
      if (account === undefined) throw notFound();
      return readConsentHistory(deps.pool, account.id, playerId, request.id);
    },
  );
}
