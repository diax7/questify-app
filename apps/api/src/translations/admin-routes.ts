import { MATRIX_MAX_LIMIT, MATRIX_SHOWS } from "@questify/shared";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { invalidTranslation, notFound, textLocked } from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import type { PublicAccount } from "#src/auth/staff-store";
import type { TranslationService } from "#src/translations/service";

const read = { config: { access: "admin" }, bodyLimit: 1024 } as const;
// Two texts of at most 1000 characters each, and the JSON around them.
const write = { config: { access: "admin" }, bodyLimit: 16 * 1024 } as const;

const listQuery = z.strictObject({
  q: z.string().trim().max(100).optional(),
  area: z
    .string()
    .regex(/^[a-z][a-zA-Z0-9]*$/)
    .max(64)
    .optional(),
  show: z.enum(MATRIX_SHOWS).default("all"),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  limit: z.coerce.number().int().min(1).max(MATRIX_MAX_LIMIT).default(50),
});
const keyParams = z.object({ key: z.string().min(1).max(200) });

/** The admin of a request that passed the console hook (activation/routes.ts). */
function adminOf(request: FastifyRequest): PublicAccount {
  const account = request.staff?.account;
  // Stryker disable next-line ConditionalExpression,BlockStatement: unreachable: the console hook sets it or answers
  if (account === undefined) {
    throw notFound();
  }
  return account;
}

/**
 * The console's translation matrix (T-702, FR-1765, FR-1766): registered inside the console scope, whose hook answers
 * 404 to anyone but an active platform admin and sets `no-store`. `GET /translations` lists the keys (search, area,
 * filter, page); `PUT /translations/:key` saves one or both languages, a blank value returning that language to the
 * shipped text. The save is audited with the key and both values, and the database checks the admin again.
 */
export function registerConsoleTranslationRoutes(
  scope: FastifyInstance,
  service: TranslationService,
): void {
  scope.get("/translations", read, async (request) =>
    service.matrix(parse(listQuery, request.query)),
  );

  scope.put("/translations/:key", write, async (request) => {
    const { key } = parse(keyParams, request.params);
    const saved = await service.save(adminOf(request), key, request.body, {
      requestId: request.id,
    });
    if (saved.ok) {
      return { row: saved.row };
    }
    switch (saved.reason) {
      case "invalid":
        throw invalidTranslation({ issues: saved.issues });
      case "locked":
        throw textLocked();
      default:
        throw notFound();
    }
  });
}
