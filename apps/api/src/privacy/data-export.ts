import { dataExportFileName } from "@questify/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import { notFound, tooManyAttempts, unauthenticated } from "#src/auth/http-errors";
import type { AuthKeys } from "#src/auth/keys";
import { parse } from "#src/auth/request";
import { BUCKETS } from "#src/auth/throttle";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { holdBack, type DeviceLimit } from "#src/devices/limits";

/** 5 downloads an hour per player at the HTTP layer; the database allows 3 a day (ADR-485). */
export const DATA_EXPORT_OWN_LIMIT = {
  bucket: BUCKETS.dataExportOwn,
  max: 5,
  windowSeconds: 3600,
} as const satisfies DeviceLimit;

export type DataExportDeps = Readonly<{ pool: Pool; keys: Pick<AuthKeys, "playerKey"> }>;

const emptyBody = z.strictObject({});

/**
 * Sends a built export as a download that nothing keeps: no cache, no sniffing, an attachment named by the date. The
 * file's size is logged, never its content.
 */
export function sendDataFile(request: FastifyRequest, reply: FastifyReply, file: unknown): string {
  const text = JSON.stringify(file);
  reply
    .header("cache-control", "no-store")
    .header("x-content-type-options", "nosniff")
    .header("content-disposition", `attachment; filename="${dataExportFileName(new Date())}"`)
    .type("application/json; charset=utf-8");
  request.log.info({ event: "data.exported", bytes: Buffer.byteLength(text) });
  return text;
}

/** The database's refusals of the player's own export: DR404 (not an active account), DR429 with the seconds to wait. */
function refusalOf(error: unknown, reply: FastifyReply): unknown {
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (code === "DR404") {
    return notFound();
  }
  if (code === "DR429") {
    const wait = Math.max(1, Number.parseInt(String(message), 10) || 1);
    reply.header("retry-after", String(wait));
    return tooManyAttempts({ retryAfterSeconds: wait });
  }
  return error;
}

/**
 * The player's own data (FR-1418, ADR-480): `POST /v1/me/data-export` builds the file in the database at this moment and
 * sends it straight back. POST keeps it out of every URL; the route is not idempotent, so no copy lands in the
 * idempotency store. Each download is audited and counted, and the player gets a notice.
 */
export function registerDataExportRoutes(app: FastifyInstance, deps: DataExportDeps): void {
  const route = { config: { access: "player" }, bodyLimit: 256 } as const;
  app.post("/v1/me/data-export", route, async (request, reply) => {
    parse(emptyBody, request.body ?? {});
    const player = request.player?.id;
    if (player === undefined) {
      throw unauthenticated();
    }
    await holdBack(
      deps.pool,
      [{ limit: DATA_EXPORT_OWN_LIMIT, key: deps.keys.playerKey(player) }],
      true,
      reply,
    );
    const file = await withConnection(deps.pool, (client) =>
      withRequestContext(client, { playerId: player }, async () => {
        const { rows } = await client.query<{ r: unknown }>("SELECT own_data_export($1) AS r", [
          request.id,
        ]);
        return rows[0]?.r;
      }),
    ).catch((error: unknown) => {
      throw refusalOf(error, reply);
    });
    return reply.send(sendDataFile(request, reply, file));
  });
}
