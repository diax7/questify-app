import type { Pool, PoolClient } from "pg";
import type { AuthKeys } from "#src/auth/keys";
import { unknownPairingCode } from "#src/auth/http-errors";
import { withConnection } from "#src/db/connection";
import { withRequestContext, type RequestContext } from "#src/db/context";
import { deviceErrorOf, inDevice } from "#src/devices/errors";
import type { DeviceKind } from "#src/devices/guard";
import { DEVICE_LIMITS, countOne, holdBack } from "#src/devices/limits";
import { normalizePairingCode } from "#src/devices/pairing-code";

export type ClaimDeps = Readonly<{
  pool: Pool;
  keys: Pick<AuthKeys, "pairingCodeHash" | "playerKey" | "userKey" | "eventKey" | "organizerKey">;
  alarm: (event: string, fields: Readonly<Record<string, unknown>>) => void;
}>;

/** Who claims or revokes: an operator in staff mode, or an owner or editor on the Devices page. */
export type Actor =
  | Readonly<{ type: "operator"; playerId: string }>
  | Readonly<{ type: "team"; organizerId: string; staffUserId: string }>;

type Reply = Readonly<{ header: (name: string, value: string) => unknown }>;
type Bilingual = Readonly<{ ar: string | null; en: string | null }>;

/** A device as the lists show it: never a secret or a code. */
export type DeviceView = Readonly<{
  id: string;
  kind: DeviceKind;
  label: string;
  questId: string | null;
  quest: Bilingual | null;
  client: string;
  pairedBy: Readonly<{ type: "operator" | "staff"; name: string | null }> | null;
  pairedAt: string;
  lastSeenAt: string;
  activated: boolean;
  /** `ended`: active but past its event's end + 24 h or 30 idle days, so it shows nothing. */
  status: "active" | "revoked" | "ended";
  paused: boolean;
  revokedAt: string | null;
}>;

type Json = Record<string, unknown>;

const contextOf = (actor: Actor): RequestContext =>
  actor.type === "operator"
    ? { playerId: actor.playerId }
    : { organizerId: actor.organizerId, staffUserId: actor.staffUserId };

const isoOrNull = (value: unknown): string | null =>
  value === null || value === undefined ? null : new Date(String(value)).toISOString();

export const viewOf = (row: Json): DeviceView => {
  const by = row["pairedBy"] as { type?: string; name?: unknown } | null;
  return {
    id: String(row["id"]),
    kind: row["kind"] as DeviceKind,
    label: String(row["label"]),
    questId: (row["questId"] as string | null) ?? null,
    quest:
      row["questId"] === null || row["questId"] === undefined
        ? null
        : {
            ar: (row["questTitleAr"] as string | null) ?? null,
            en: (row["questTitleEn"] as string | null) ?? null,
          },
    client: String(row["client"] ?? ""),
    pairedBy:
      by === null || by === undefined
        ? null
        : {
            type: by.type === "operator" ? "operator" : "staff",
            name: typeof by.name === "string" ? by.name : null,
          },
    pairedAt: new Date(String(row["pairedAt"])).toISOString(),
    lastSeenAt: new Date(String(row["lastSeenAt"])).toISOString(),
    activated: row["activated"] === true,
    status: row["status"] as DeviceView["status"],
    paused: row["paused"] === true,
    revokedAt: isoOrNull(row["revokedAt"]),
  };
};

/**
 * Holds a claim or preview against the actor's 10 a minute, and the unknown codes already tried against the event (and
 * the organizer, for the team) this hour, 30 each (CTO 8).
 */
async function holdClaim(deps: ClaimDeps, actor: Actor, eventId: string, reply: Reply) {
  const actorKey =
    actor.type === "operator"
      ? deps.keys.playerKey(actor.playerId)
      : deps.keys.userKey(actor.staffUserId);
  await holdBack(deps.pool, [{ limit: DEVICE_LIMITS.claimsPerActor, key: actorKey }], true, reply);
  await holdBack(
    deps.pool,
    [
      { limit: DEVICE_LIMITS.missesPerEvent, key: deps.keys.eventKey(eventId) },
      ...(actor.type === "team"
        ? [
            {
              limit: DEVICE_LIMITS.missesPerOrganizer,
              key: deps.keys.organizerKey(actor.organizerId),
            },
          ]
        : []),
    ],
    false,
    reply,
  );
}

/** Counts an unknown code against the event, its organizer and the platform; above 200 an hour ops are alerted. */
async function countMiss(deps: ClaimDeps, eventId: string, organizerId: string): Promise<void> {
  await countOne(deps.pool, DEVICE_LIMITS.missesPerEvent, deps.keys.eventKey(eventId));
  await countOne(deps.pool, DEVICE_LIMITS.missesPerOrganizer, deps.keys.organizerKey(organizerId));
  const platform = await countOne(
    deps.pool,
    DEVICE_LIMITS.missesPlatformAlert,
    deps.keys.eventKey("platform"),
  );
  if (platform > DEVICE_LIMITS.missesPlatformAlert.max) {
    deps.alarm("device.claim_misses_high", { lastHour: platform });
  }
}

/**
 * Runs a claim or preview with a typed code: the limits are held, the code is normalised (a malformed one is
 * unknown_code, as any unknown one), and an unknown code (DV404, which names the event's organizer) is counted before
 * it is answered.
 */
async function withCode<T>(
  deps: ClaimDeps,
  target: Readonly<{ actor: Actor; eventId: string; code: string }>,
  reply: Reply,
  work: (client: PoolClient, codeHash: Buffer) => Promise<T>,
): Promise<T> {
  await holdClaim(deps, target.actor, target.eventId, reply);
  const code = normalizePairingCode(target.code);
  if (code === undefined) {
    throw unknownPairingCode();
  }
  try {
    return await withConnection(deps.pool, (client) =>
      withRequestContext(client, contextOf(target.actor), () =>
        work(client, deps.keys.pairingCodeHash(code)),
      ),
    );
  } catch (error) {
    const pg = error as { code?: string; detail?: string };
    if (pg.code === "DV404" && pg.detail !== undefined) {
      await countMiss(deps, target.eventId, pg.detail);
    }
    throw deviceErrorOf(pg) ?? error;
  }
}

export type Preview = Readonly<{ kind: DeviceKind; client: string; expiresAt: string }>;

/** What a code's page told the API (`preview_device`), shown before staff confirm. */
export function previewDevice(
  deps: ClaimDeps,
  target: Readonly<{ actor: Actor; eventId: string; code: string }>,
  reply: Reply,
): Promise<Preview> {
  return withCode(deps, target, reply, async (client, codeHash) => {
    const { rows } = await client.query<{ kind: DeviceKind; client: string; expires_at: Date }>(
      "SELECT * FROM preview_device($1, $2)",
      [codeHash, target.eventId],
    );
    const row = rows[0] as { kind: DeviceKind; client: string; expires_at: Date };
    return { kind: row.kind, client: row.client, expiresAt: row.expires_at.toISOString() };
  });
}

export type Claim = Readonly<{
  actor: Actor;
  eventId: string;
  code: string;
  kind: DeviceKind;
  questId: string | null;
  label: string;
  requestId: string;
}>;

/**
 * Claims a code (`operator_claim_device` or `team_claim_device`): the device is paired and answers `paired` at its next
 * poll; it shows nothing of the event until it activates. Answers the device's id.
 */
export function claimDevice(deps: ClaimDeps, claim: Claim, reply: Reply): Promise<string> {
  const door =
    claim.actor.type === "operator"
      ? "SELECT operator_claim_device($1, $2, $3, $4, $5, $6) AS id"
      : "SELECT team_claim_device($1, $2, $3, $4, $5, $6) AS id";
  return withCode(deps, claim, reply, async (client, codeHash) => {
    const { rows } = await client.query<{ id: string }>(door, [
      codeHash,
      claim.eventId,
      claim.kind,
      claim.questId,
      claim.label,
      claim.requestId,
    ]);
    return (rows[0] as { id: string }).id;
  });
}

/** The event's Devices page (owners and editors). */
export function eventDevices(
  deps: ClaimDeps,
  actor: Actor,
  eventId: string,
): Promise<DeviceView[]> {
  return inDevice(deps.pool, contextOf(actor), async (client) => {
    const { rows } = await client.query<{ list: Json[] }>("SELECT event_devices($1) AS list", [
      eventId,
    ]);
    return (rows[0]?.list ?? []).map(viewOf);
  });
}

export type OperatorDevices = Readonly<{
  devices: DeviceView[];
  /** Scan quests with the screen QR the operator may show or pair a station for. */
  quests: ReadonlyArray<Readonly<{ id: string; title: Bilingual; points: number }>>;
}>;

/** Staff mode's devices page: the operator's own devices and their station quests. */
export function operatorDevices(
  deps: ClaimDeps,
  operatorId: string,
  eventId: string,
): Promise<OperatorDevices> {
  return inDevice(deps.pool, { playerId: operatorId }, async (client) => {
    const { rows } = await client.query<{ page: { devices: Json[]; quests: Json[] } }>(
      "SELECT operator_devices($1) AS page",
      [eventId],
    );
    const page = rows[0]?.page ?? { devices: [], quests: [] };
    return {
      devices: page.devices.map(viewOf),
      quests: page.quests.map((row) => ({
        id: String(row["id"]),
        title: {
          ar: (row["titleAr"] as string | null) ?? null,
          en: (row["titleEn"] as string | null) ?? null,
        },
        points: Number(row["points"]),
      })),
    };
  });
}

/** Revokes one device: the team's any, an operator's only their own. The page goes blank at its next request. */
export async function revokeDevice(
  deps: ClaimDeps,
  actor: Actor,
  target: Readonly<{ eventId: string; deviceId: string; requestId: string }>,
): Promise<void> {
  await inDevice(deps.pool, contextOf(actor), (client) =>
    client.query("SELECT revoke_device($1, $2, $3)", [
      target.eventId,
      target.deviceId,
      target.requestId,
    ]),
  );
}

/** Revoke all, or all of one kind ("Revoke all big screens", ADR-241); the team's only. Answers how many. */
export function revokeDevices(
  deps: ClaimDeps,
  actor: Extract<Actor, { type: "team" }>,
  target: Readonly<{ eventId: string; kind: DeviceKind | null; requestId: string }>,
): Promise<number> {
  return inDevice(deps.pool, contextOf(actor), async (client) => {
    const { rows } = await client.query<{ revoked: number }>(
      "SELECT revoke_devices($1, $2, $3) AS revoked",
      [target.eventId, target.kind, target.requestId],
    );
    return rows[0]?.revoked ?? 0;
  });
}
