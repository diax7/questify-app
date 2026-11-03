import { organizerDocuments } from "@questify/shared";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { acceptanceRequired, ownerOnly } from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { readInForce } from "#src/legal/in-force";
import { organizerContextOf } from "#src/organizers/context";
import { teamSeat } from "#src/organizers/store";

const ORGANIZER_DOCUMENT = z.enum(["organizer_terms", "organizer_dpa", "organizer_content_rules"]);
const acceptBody = z.strictObject({
  documents: z
    .array(z.strictObject({ document: ORGANIZER_DOCUMENT, version: z.string().max(20) }))
    .min(1)
    .max(3),
});

const owner = { config: { access: "owner" }, bodyLimit: 1024 } as const;

/**
 * `POST /v1/organizers/:organizerId/legal/accept` (FR-1781): the owner accepts the organizer documents in force on behalf
 * of the organizer, which lifts the hold on the team's writes. Each document must be named at the version in force, or
 * nothing is recorded and the answer lists the versions in force (422 `acceptance_required`). The database lets only
 * the organizer's owner record it.
 */
export function registerOrganizerLegalRoutes(
  scope: FastifyInstance,
  deps: Readonly<{ pool: Pool }>,
): void {
  scope.post("/legal/accept", owner, async (request, reply) => {
    const body = parse(acceptBody, request.body);
    const context = organizerContextOf(request);
    try {
      await withConnection(deps.pool, (client) =>
        withRequestContext(client, teamSeat(context), () =>
          client.query("SELECT accept_organizer_documents($1, $2)", [
            context.organizerId,
            JSON.stringify(body.documents),
          ]),
        ),
      );
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === "QE403") {
        throw ownerOnly();
      }
      if (code === "LG412") {
        const inForce = organizerDocuments(await readInForce(deps.pool));
        throw acceptanceRequired({
          documents: inForce.map(({ id, version }) => ({ id, version })),
        });
      }
      throw error;
    }
    return reply.code(204).send();
  });
}
