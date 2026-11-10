import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { currentDevice, notFound, reauthRequired, unauthenticated } from "#src/auth/http-errors";
import type { AuthKeys } from "#src/auth/keys";
import { parse } from "#src/auth/request";
import { reasonOf, say, type Caller } from "#src/auth/sign-in";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { sessionHashOf } from "#src/players/guard";

/** The label a model may carry (the column's own check, migration 0155): anything else is dropped, not refused. */
const DEVICE_MODEL = /^[A-Za-z0-9 ._()+-]{1,40}$/;

/**
 * The platforms a signed-in device may carry (migration 0188): `web` is set by the web app's forwarder for a browser
 * sign-in (ADR-820). The API cannot verify the label, and any client may call itself `web`, which is harmless.
 */
const DEVICE_PLATFORMS = ["ios", "android", "web"] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

/** The optional `device` of a sign-in or sign-up body: the platform and the `expo-device` model, nothing else. */
export const deviceLabelBody = z.strictObject({
  platform: z.enum(DEVICE_PLATFORMS),
  model: z.string().max(200).optional(),
});
export type DeviceLabel = z.infer<typeof deviceLabelBody>;

/** The model as stored: spaces folded, kept only when it fits the column's shape; else null (shown as the platform). */
export function cleanModel(model: string | undefined): string | null {
  const folded = model?.trim().replace(/\s+/g, " ");
  return folded !== undefined && DEVICE_MODEL.test(folded) ? folded : null;
}

/**
 * Labels the family of a refresh token just issued (`label_player_device`): once, and only for a live token, so no one
 * labels another's device. A failure never fails the sign-in; the log line holds only the error's class, never the
 * platform or the model (plan review item 6).
 */
export async function labelDevice(
  deps: Readonly<{ pool: Pool; keys: AuthKeys }>,
  refreshHash: Buffer,
  label: DeviceLabel | undefined,
  caller: Caller,
): Promise<void> {
  if (label === undefined) {
    return;
  }
  try {
    await withConnection(deps.pool, (client) =>
      withRequestContext(client, {}, () =>
        client.query("SELECT label_player_device($1, $2, $3)", [
          refreshHash,
          label.platform,
          // A browser carries no model, never a user agent (ADR-710, ADR-820).
          label.platform === "web" ? null : cleanModel(label.model),
        ]),
      ),
    );
  } catch (error) {
    say(deps, caller, "player.device_label_failed", { reason: reasonOf(error) });
  }
}

export type PlayerDevice = Readonly<{
  id: string;
  platform: DevicePlatform | null;
  model: string | null;
  signedInAt: Date;
  lastUsedAt: Date;
  current: boolean;
}>;

export type DeviceList = Readonly<{ devices: PlayerDevice[]; freshUntil: Date | null }>;

type DevicesDeps = Readonly<{ pool: Pool }>;

const ownPlayer = (request: FastifyRequest): string => {
  // Stryker disable next-line all: the player guard has already refused a request without a player
  if (request.player === undefined) throw unauthenticated();
  return request.player.id;
};

/** The hash of the request's own access token; the guard let it through, so it is always there. */
export const ownSession = (request: FastifyRequest): Buffer => {
  const hash = sessionHashOf(request.headers.authorization);
  // Stryker disable next-line all: the player guard has already refused a request without a bearer token
  if (hash === undefined) throw unauthenticated();
  return hash;
};

/** Runs a device door as the player; PN401 (no live session of the caller) is a 401. */
export async function asDevicePlayer<T>(
  pool: Pool,
  playerId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  try {
    return await withConnection(pool, (client) =>
      withRequestContext(client, { playerId }, () => work(client)),
    );
  } catch (error) {
    if ((error as { code?: unknown }).code === "PN401") {
      throw unauthenticated();
    }
    throw error;
  }
}

/** The caller's live devices (`player_devices`): this one first, then by last use; freshUntil for this one. */
export async function listDevices(client: PoolClient, session: Buffer): Promise<DeviceList> {
  const { rows } = await client.query<{
    id: string;
    platform: DevicePlatform | null;
    model: string | null;
    signed_in_at: Date;
    last_used_at: Date;
    is_current: boolean;
    fresh_until: Date | null;
  }>("SELECT * FROM player_devices($1)", [session]);
  return {
    devices: rows.map((row) => ({
      id: row.id,
      platform: row.platform,
      model: row.model,
      signedInAt: row.signed_in_at,
      lastUsedAt: row.last_used_at,
      current: row.is_current,
    })),
    freshUntil: rows.find((row) => row.is_current)?.fresh_until ?? null,
  };
}

type EndOutcome = "ended" | "already_ended" | "not_found" | "current" | "reauth_required";

/** Ending another device's answer: 204 when it is ended (also when it already was), else its refusal. */
function endAnswer(outcome: EndOutcome, reply: FastifyReply): FastifyReply {
  switch (outcome) {
    case "ended":
    case "already_ended":
      return reply.code(204).send();
    case "not_found":
      throw notFound();
    case "current":
      throw currentDevice();
    case "reauth_required":
      throw reauthRequired();
  }
}

const deviceParams = z.object({ id: z.uuid() });
const emptyBody = z.strictObject({});

/**
 * The player's signed-in devices (T-810c, FR-140, ASVS V7.5.2): `GET /v1/me/devices`, and ending another device or
 * every other one after a fresh code (`/v1/me/reauth/*`; a sign-in or a contact change in the last 10 minutes counts).
 * Every rule lives in the database doors (migration 0155), bound to the request's own access token: no route takes a
 * player id, and another person's device answers as an unknown one (404).
 */
export function registerSignedInDeviceRoutes(app: FastifyInstance, deps: DevicesDeps): void {
  const read = { config: { access: "player" } } as const;
  const write = { config: { access: "player", idempotent: true }, bodyLimit: 256 } as const;

  app.get("/v1/me/devices", read, async (request) =>
    asDevicePlayer(deps.pool, ownPlayer(request), (client) =>
      listDevices(client, ownSession(request)),
    ),
  );

  app.post("/v1/me/devices/:id/end", write, async (request, reply) => {
    const { id } = parse(deviceParams, request.params);
    parse(emptyBody, request.body ?? {});
    const outcome = await asDevicePlayer(deps.pool, ownPlayer(request), async (client) => {
      const { rows } = await client.query<{ outcome: EndOutcome }>(
        "SELECT end_player_device($1, $2, $3) AS outcome",
        [ownSession(request), id, request.id],
      );
      return rows[0]?.outcome ?? "not_found";
    });
    return endAnswer(outcome, reply);
  });

  app.post("/v1/me/devices/end-others", write, async (request) => {
    parse(emptyBody, request.body ?? {});
    const row = await asDevicePlayer(deps.pool, ownPlayer(request), async (client) => {
      const { rows } = await client.query<{ outcome: "ended" | "reauth_required"; ended: number }>(
        "SELECT outcome, ended FROM end_other_player_devices($1, $2)",
        [ownSession(request), request.id],
      );
      return rows[0];
    });
    if (row?.outcome !== "ended") {
      throw reauthRequired();
    }
    return { ended: row.ended };
  });
}
