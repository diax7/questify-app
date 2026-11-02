import {
  helpPublicSchema,
  isLegalDocumentId,
  legalTextSchema,
  type HelpPublic,
  type LegalText,
} from "@questify/shared";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { notFound } from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import { readInForce } from "#src/legal/in-force";

const documentParams = z.object({ document: z.string().refine(isLegalDocumentId) });
const open = { config: { access: "public" } } as const;

/** What a signed-out reader may keep for a minute: the legal texts and the help are public, and a minute is a change's delay. */
const SHARED_CACHE = "public, max-age=60";

/**
 * The public reads of T-707: the version in force of every legal document (the sign-up screens need them before anyone
 * has an account), one document in force with its text, and the published help articles (FR-1782). Each is read from a
 * closed table through a definer function that returns only what the pages show.
 */
export function registerLegalRoutes(app: FastifyInstance, deps: Readonly<{ pool: Pool }>): void {
  app.get("/v1/legal", open, async (_request, reply) => {
    reply.header("cache-control", SHARED_CACHE);
    return { documents: await readInForce(deps.pool) };
  });

  app.get("/v1/legal/:document", open, async (request, reply): Promise<LegalText> => {
    const { document } = parse(documentParams, request.params);
    const { rows } = await deps.pool.query<{ r: unknown }>("SELECT legal_text($1) AS r", [
      document,
    ]);
    const found = legalTextSchema.safeParse(rows[0]?.r);
    if (!found.success) {
      throw notFound();
    }
    reply.header("cache-control", SHARED_CACHE);
    return found.data;
  });

  app.get("/v1/help", open, async (_request, reply): Promise<HelpPublic> => {
    const { rows } = await deps.pool.query<{ r: unknown }>("SELECT help_articles() AS r");
    reply.header("cache-control", SHARED_CACHE);
    return helpPublicSchema.parse({ articles: rows[0]?.r });
  });
}
