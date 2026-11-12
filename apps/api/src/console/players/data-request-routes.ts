import type { ObjectStore } from "#src/storage/client";
import { isCaseReference, isDataRequestReason } from "@questify/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { handoverPending, invalidRequest } from "#src/auth/http-errors";
import { parse } from "#src/auth/request";
import { BUCKETS } from "#src/auth/throttle";
import {
  erasePlayer,
  exportPlayerData,
  readPendingHandovers,
  type CaseOf,
} from "#src/console/players/data-request-doors";
import { CONSOLE_PLAYER_READ_LIMIT, type ConsolePlayerDeps } from "#src/console/players/routes";
import { throttled } from "#src/console/throttle";
import type { DeviceLimit } from "#src/devices/limits";
import type { IdempotencyStore } from "#src/idempotency-store";
import { sendDataFile } from "#src/privacy/data-export";

/** 10 legal exports an hour per admin. */
export const CONSOLE_DATA_EXPORT_LIMIT = {
  bucket: BUCKETS.consoleDataExport,
  max: 10,
  windowSeconds: 3600,
} as const satisfies DeviceLimit;
/** 10 legal erasures an hour per admin. */
export const CONSOLE_DATA_ERASE_LIMIT = {
  bucket: BUCKETS.consoleDataErase,
  max: 10,
  windowSeconds: 3600,
} as const satisfies DeviceLimit;

export type ConsoleDataRequestDeps = ConsolePlayerDeps &
  Readonly<{
    /** An erased player's remembered answers are dropped with the account, as the self-deletion does. */
    idempotencyStore: IdempotencyStore;
    /** The photo bucket: a reported wall photo's report page shows it through a short signed URL (T-504b). */
    storage?: ObjectStore | undefined;
  }>;

const playerParams = z.object({ playerId: z.uuid() });
const caseFields = { reasonCode: z.string().max(32), reference: z.string().max(64) };
const exportBody = z.strictObject(caseFields);
const eraseBody = z.strictObject({
  ...caseFields,
  username: z.string().max(120),
  forfeit: z.boolean().default(false),
});

/**
 * The reason and the case reference, checked by the shared rules before the door checks them again.
 *
 * @throws HttpError invalid_request naming the field.
 */
function caseOf(body: Readonly<{ reasonCode: string; reference: string }>): CaseOf {
  if (!isDataRequestReason(body.reasonCode)) {
    throw invalidRequest({ field: "reasonCode" });
  }
  if (!isCaseReference(body.reference)) {
    throw invalidRequest({ field: "reference" });
  }
  return { reasonCode: body.reasonCode, reference: body.reference };
}

/**
 * The console's legal data requests (T-708, FR-1778, ADR-483): export one player's data as a download, list the
 * handovers still pending, and erase the account with the username typed. The export is a POST that is never
 * idempotent (no copy of the file is kept); the erase takes an Idempotency-Key, since its answer holds no personal data.
 * Every door re-reads the admin, checks the case and writes the audit entry; there is no restore anywhere.
 */
export function registerConsoleDataRequestRoutes(
  scope: FastifyInstance,
  deps: ConsoleDataRequestDeps,
): void {
  const personalRead = { config: { access: "admin" }, bodyLimit: 1024 } as const;
  const read = { config: { access: "admin" }, bodyLimit: 1024 } as const;
  const change = { config: { access: "admin", idempotent: true }, bodyLimit: 1024 } as const;

  scope.post("/players/:playerId/data-export", personalRead, async (request, reply) => {
    const { playerId } = parse(playerParams, request.params);
    const legal = caseOf(parse(exportBody, request.body));
    const who = await throttled(deps, request, reply, CONSOLE_DATA_EXPORT_LIMIT);
    const file = await exportPlayerData(deps.pool, who, { ...legal, playerId }, request.id);
    return reply.send(sendDataFile(request, reply, file));
  });

  scope.get("/players/:playerId/pending", read, async (request, reply) => {
    const { playerId } = parse(playerParams, request.params);
    const who = await throttled(deps, request, reply, CONSOLE_PLAYER_READ_LIMIT);
    return { pending: await readPendingHandovers(deps.pool, who, playerId) };
  });

  scope.post("/players/:playerId/erase", change, async (request, reply) => {
    const { playerId } = parse(playerParams, request.params);
    const body = parse(eraseBody, request.body);
    const legal = caseOf(body);
    const who = await throttled(deps, request, reply, CONSOLE_DATA_ERASE_LIMIT);
    const result = await erasePlayer(
      deps.pool,
      who,
      { ...legal, playerId, username: body.username, forfeit: body.forfeit },
      request.id,
    );
    if (result.outcome === "handover_pending") {
      throw handoverPending({ pending: result.pending });
    }
    if (result.outcome === "erased") {
      await deps.idempotencyStore.forget(`player:${playerId}`);
      request.log.info({ event: "player.deleted", player: playerId, source: "admin" });
    }
    return result;
  });
}
