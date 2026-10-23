import type { FastifyRequest } from "fastify";
import type { z } from "zod";
import { invalidRequest } from "#src/auth/http-errors";
import type { Caller } from "#src/auth/sign-in";

/**
 * Reads a request part with its schema.
 *
 * @throws HttpError `invalid_request` when the value does not match.
 */
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw invalidRequest();
  }
  return result.data;
}

/** Who is asking, for the flows: the client address, a shortened user agent, the request's own log and id. */
export function callerOf(request: FastifyRequest): Caller {
  const agent = request.headers["user-agent"];
  return {
    address: request.ip,
    userAgent: typeof agent === "string" ? agent.slice(0, 300) : null,
    log: (event, fields) => request.log.info({ event, ...fields }),
    requestId: request.id,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The app's install id (`x-device-id`), when it is one; anything else is ignored, never trusted. */
export const deviceOf = (header: unknown): string | undefined =>
  typeof header === "string" && UUID.test(header) ? header.toLowerCase() : undefined;
