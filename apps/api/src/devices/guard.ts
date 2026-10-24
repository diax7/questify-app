import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { deviceUnpaired } from "#src/auth/http-errors";
import { readCookie } from "#src/auth/session";
import { checkOrigin } from "#src/auth/staff-guard";
import { DEVICE_GUARD } from "#src/route-access";

/** The browser's own secret (ADR-239): HttpOnly, never read by page scripts, never in a URL, a log or an audit row. */
export const DEVICE_COOKIE = "__Host-qs_device";
/** 400 days, the longest a browser keeps a cookie; the device ends long before by its event or by Revoke. */
const COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;
/** 32 random bytes in base64url, as every token the API makes. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export type DeviceKind = "station" | "kiosk" | "screen";

/**
 * Who a device cookie is (CTO 5): a pending request (shown its pairing code), or a paired device of one event; a paired
 * device is `activated` once its secret was replaced (CTO 2). `secretHash` is the cookie's SHA-256, kept for renew and
 * activate; never logged.
 */
export type DeviceIdentity =
  | Readonly<{ state: "pending"; kind: DeviceKind; expiresAt: string; secretHash: Buffer }>
  | Readonly<{
      state: "paired";
      id: string;
      kind: DeviceKind;
      eventId: string;
      questId: string | null;
      activated: boolean;
      secretHash: Buffer;
    }>;

type SessionRow = {
  state: "pending" | "paired";
  device_id: string | null;
  kind: DeviceKind;
  event_id: string | null;
  quest_id: string | null;
  activated: boolean;
  expires_at: Date | null;
};

/** The SHA-256 of a device token, as the database stores it. */
export const secretHashOf = (token: string): Buffer => createHash("sha256").update(token).digest();

/** The Set-Cookie value that gives a browser its device secret. `__Host-` needs Secure, Path=/ and no Domain. */
export function deviceCookie(token: string): string {
  return `${DEVICE_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_SECONDS}`;
}

/** The device a token opens (`device_session`), or undefined: not a token, unknown, revoked or ended. */
export async function deviceOfToken(
  pool: Pool,
  token: string | undefined,
): Promise<DeviceIdentity | undefined> {
  if (token === undefined || !TOKEN.test(token)) {
    return undefined;
  }
  const secretHash = secretHashOf(token);
  const { rows } = await pool.query<SessionRow>("SELECT * FROM device_session($1)", [secretHash]);
  const row = rows[0];
  if (row === undefined) {
    return undefined;
  }
  if (row.state === "pending") {
    return {
      state: "pending",
      kind: row.kind,
      expiresAt: (row.expires_at as Date).toISOString(),
      secretHash,
    };
  }
  return {
    state: "paired",
    id: row.device_id as string,
    kind: row.kind,
    eventId: row.event_id as string,
    questId: row.quest_id,
    activated: row.activated,
    secretHash,
  };
}

/** The device behind a request's cookie, for the public pairing route that reads it without requiring it. */
export const deviceOfCookie = (pool: Pool, cookieHeader: string | undefined) =>
  deviceOfToken(pool, readCookie(cookieHeader, DEVICE_COOKIE));

/**
 * The check behind every route marked `device` (T-309, ADR-239), on the route's access kind, never its path: the
 * `__Host-qs_device` cookie of a live device, else 401 device_unpaired. Only routes with `config.anyDevice` take a pending
 * or not yet activated device; every other needs it paired and activated. Writes need the dashboard's Origin (the staff
 * routes' CSRF rule). Every answer is `no-store`. It sets the device and, once paired, the idempotency principal
 * `device:{id}`.
 */
export function registerDeviceGuard(
  app: FastifyInstance,
  deps: Readonly<{ pool: Pool; dashboardOrigin: string }>,
): void {
  app.decorate(DEVICE_GUARD, true);
  app.addHook("onRequest", async (request, reply) => {
    if (request.routeOptions.config.access !== "device") {
      return;
    }
    reply.header("cache-control", "no-store");
    checkOrigin(request, deps.dashboardOrigin, true);
    const device = await deviceOfCookie(deps.pool, request.headers.cookie);
    const ready = device?.state === "paired" && device.activated;
    if (device === undefined || (!ready && request.routeOptions.config.anyDevice !== true)) {
      throw deviceUnpaired();
    }
    request.device = device;
    if (device.state === "paired") {
      request.principalId = `device:${device.id}`;
    }
  });
}
