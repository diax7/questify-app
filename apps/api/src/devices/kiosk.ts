import type { Pool, PoolClient } from "pg";
import { deviceUnpaired, idempotencyKeyReused, platformFeatureOff } from "#src/auth/http-errors";
import type { AuthKeys } from "#src/auth/keys";
import type { Caller } from "#src/auth/sign-in";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { kiosksOn } from "#src/devices/live-code";
import { countOne, DEVICE_LIMITS, holdBack } from "#src/devices/limits";
import { verifyLiveCode, verifyMyCode, type LiveCodeKey, type MyCodeKey } from "#src/quests/qr";
import type { Ranking } from "#src/ranking/ranking";
import type { SettingsService } from "#src/settings/service";

export type KioskDeps = Readonly<{
  pool: Pool;
  liveKey: LiveCodeKey;
  myKey: MyCodeKey;
  keys: Pick<AuthKeys, "pairedDeviceKey">;
  settings: Pick<SettingsService, "forEvent">;
  ranking: Pick<Ranking, "afterCompletion">;
}>;

/**
 * Why the kiosk shows red (ADR-244): never a reason that describes the person; banned, paused, removed or left all read
 * `not_open`.
 */
export type KioskReason =
  | "invalid_code"
  | "needs_live_code"
  | "expired"
  | "method_off"
  | "not_in_event"
  | "not_open"
  | "self_scan"
  | "paused";

export type KioskPlayer = Readonly<{ username: string; avatar: string }>;

/** What `POST /v1/device/kiosk-scans` answers: green, orange, or red with the reason and no one named. */
export type KioskAnswer =
  | Readonly<{
      result: "completed";
      player: KioskPlayer | null;
      points: number;
      boosted: boolean;
      replayed: boolean;
    }>
  | Readonly<{ result: "already_completed"; player: KioskPlayer | null }>
  | Readonly<{ result: "refused"; reason: KioskReason }>;

type Reply = Readonly<{ header: (name: string, value: string) => unknown }>;
type Row = { completion_id: string; points: string; replayed: boolean; boosted: boolean };
type Judged =
  | Readonly<{ kind: "completed"; row: Row }>
  | Readonly<{ kind: "already_completed" }>
  | Readonly<{ kind: "refused"; reason: KioskReason; detail?: string }>;

const refused = (reason: KioskReason, detail?: string): Judged =>
  detail === undefined ? { kind: "refused", reason } : { kind: "refused", reason, detail };

/** kiosk_complete_quest's and record_completion's refusals (migration 0058); the detail goes to the log only. */
const REFUSALS: Readonly<Record<string, (detail: string | undefined) => Judged>> = {
  DV403: () => refused("paused"),
  OY409: () => refused("self_scan"),
  QV422: (detail) => refused(detail === "expired" ? "expired" : "method_off", detail),
  QC404: () => refused("not_in_event"),
  QC403: (detail) => refused("not_open", detail),
  QN403: (detail) => refused("not_open", detail),
  QP403: () => refused("not_open", "operator_not_playing"),
  QD409: () => ({ kind: "already_completed" }),
};

/** The kiosk's own throttle key, apart from its polls' so a poll never holds a scan back. */
const kioskKey = (deps: KioskDeps, deviceId: string): Buffer =>
  deps.keys.pairedDeviceKey(`${deviceId}:kiosk`);

/**
 * The door in a savepoint, so a refusal still lets the transaction read who was scanned. DV401 and QK422 are thrown as
 * their HTTP answers; anything unknown as it is.
 */
async function judge(
  client: PoolClient,
  scanned: Readonly<{ playerId: string; window: number }>,
  idempotencyKey: string,
): Promise<Judged> {
  await client.query("SAVEPOINT kiosk");
  try {
    const { rows } = await client.query<Row>(
      "SELECT completion_id, points, replayed, boosted FROM kiosk_complete_quest($1, $2, $3)",
      [scanned.playerId, scanned.window, idempotencyKey],
    );
    return { kind: "completed", row: rows[0] as Row };
  } catch (error) {
    const pg = error as { code?: string; detail?: string };
    if (pg.code === "DV401") {
      throw deviceUnpaired();
    }
    if (pg.code === "QK422") {
      throw idempotencyKeyReused();
    }
    const refusal = REFUSALS[pg.code ?? ""];
    if (refusal === undefined) {
      throw error;
    }
    await client.query("ROLLBACK TO SAVEPOINT kiosk");
    return refusal(pg.detail);
  }
}

/** Who the kiosk paid, for green and orange only (`kiosk_scan_subject`: a player of the kiosk's own event). */
async function subjectOf(client: PoolClient, playerId: string): Promise<KioskPlayer | null> {
  const { rows } = await client.query<KioskPlayer>(
    "SELECT username, avatar FROM kiosk_scan_subject($1)",
    [playerId],
  );
  return rows[0] ?? null;
}

/**
 * Opens the code a kiosk read: a live code goes to the door; the fixed My QR (or later a pass) is `needs_live_code`;
 * anything else is `invalid_code`, counted against the kiosk's 10 bad codes a minute and logged.
 */
async function openCode(
  deps: KioskDeps,
  deviceId: string,
  code: string,
  caller: Caller,
): Promise<Readonly<{ playerId: string; window: number }> | KioskAnswer> {
  const live = verifyLiveCode(deps.liveKey, code);
  if (live.kind === "valid") {
    return { playerId: live.playerId, window: live.window };
  }
  if (verifyMyCode(deps.myKey, code).kind === "valid") {
    caller.log("kiosk.scan_refused", { reason: "needs_live_code" });
    return { result: "refused", reason: "needs_live_code" };
  }
  await countOne(deps.pool, DEVICE_LIMITS.kioskBadCodes, kioskKey(deps, deviceId));
  caller.log("kiosk.scan_refused", { reason: "invalid_code", problem: live.kind });
  return { result: "refused", reason: "invalid_code" };
}

/**
 * A kiosk scan (`POST /v1/device/kiosk-scans`, T-309b, FR-315): the platform's `kiosks` switch, the kiosk's 10 bad codes
 * and 30 scans a minute, the code opened here, then `kiosk_complete_quest` pays the player of the device's own quest in
 * one transaction and the kiosk reads who it paid. The ranking moves after a fresh completion. The code, the player id
 * and the username never reach a log line.
 *
 * @throws HttpError feature_off, too_many_attempts, device_unpaired, idempotency_key_reused.
 */
export async function kioskScan(
  deps: KioskDeps,
  request: Readonly<{
    deviceId: string;
    questId: string | null;
    code: string;
    idempotencyKey: string;
  }>,
  caller: Caller,
  reply: Reply,
): Promise<KioskAnswer> {
  if (!(await kiosksOn(deps.settings))) {
    throw platformFeatureOff();
  }
  const key = kioskKey(deps, request.deviceId);
  await holdBack(deps.pool, [{ limit: DEVICE_LIMITS.kioskBadCodes, key }], false, reply);
  await holdBack(deps.pool, [{ limit: DEVICE_LIMITS.kioskScans, key }], true, reply);
  const opened = await openCode(deps, request.deviceId, request.code, caller);
  if ("result" in opened) {
    return opened;
  }
  const { judged, player } = await withConnection(deps.pool, (client) =>
    withRequestContext(client, { deviceId: request.deviceId }, async () => {
      const result = await judge(client, opened, request.idempotencyKey);
      return {
        judged: result,
        player: result.kind === "refused" ? null : await subjectOf(client, opened.playerId),
      };
    }),
  );
  return answerOf(deps, judged, {
    player,
    playerId: opened.playerId,
    questId: request.questId,
    caller,
  });
}

async function answerOf(
  deps: KioskDeps,
  judged: Judged,
  context: Readonly<{
    player: KioskPlayer | null;
    playerId: string;
    questId: string | null;
    caller: Caller;
  }>,
): Promise<KioskAnswer> {
  switch (judged.kind) {
    case "completed": {
      context.caller.log("kiosk.scan_completed", {
        questId: context.questId ?? "",
        replayed: String(judged.row.replayed),
      });
      if (!judged.row.replayed) {
        // A ranking failure never fails the scan (afterCompletion logs and answers null).
        await deps.ranking.afterCompletion(context.playerId, judged.row.completion_id);
      }
      return {
        result: "completed",
        player: context.player,
        points: Number(judged.row.points),
        boosted: judged.row.boosted,
        replayed: judged.row.replayed,
      };
    }
    case "already_completed":
      return { result: "already_completed", player: context.player };
    case "refused":
      context.caller.log("kiosk.scan_refused", {
        reason: judged.reason,
        ...(judged.detail === undefined ? {} : { detail: judged.detail }),
      });
      return { result: "refused", reason: judged.reason };
  }
}
