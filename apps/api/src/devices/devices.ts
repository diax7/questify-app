import type { Pool, PoolClient } from "pg";
import { generateToken, type AuthKeys } from "#src/auth/keys";
import { addressBucket } from "#src/auth/normalize";
import { deviceUnpaired, platformFeatureOff } from "#src/auth/http-errors";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { deviceErrorOf, inDevice } from "#src/devices/errors";
import { secretHashOf, type DeviceIdentity, type DeviceKind } from "#src/devices/guard";
import { DEVICE_LIMITS, holdBack } from "#src/devices/limits";
import { kiosksOn } from "#src/devices/live-code";
import { formatPairingCode, generatePairingCode } from "#src/devices/pairing-code";
import { screenCode, screenCodeUrl, type ScreenCodeKey } from "#src/quests/qr";
import type { SettingsService } from "#src/settings/service";

export type DeviceDeps = Readonly<{
  pool: Pool;
  keys: Pick<AuthKeys, "pairingCodeHash" | "pairedDeviceKey" | "addressKey" | "playerQuestKey">;
  screenKey: ScreenCodeKey;
  settings: Pick<SettingsService, "forEvent">;
  dashboardOrigin: string;
  /** An ops alarm line (the error tracker alerts on it): the request flood, the claim misses. */
  alarm: (event: string, fields: Readonly<Record<string, unknown>>) => void;
}>;

/** Where a reply's Retry-After goes. */
type Reply = Readonly<{ header: (name: string, value: string) => unknown }>;

/** A drawn code that is taken is drawn again this many times, then the answer is 503 busy (ADR-239). */
const CODE_TRIES = 3;

type Bilingual = Readonly<{ ar: string | null; en: string | null }>;

/** A pending page's answer: its code as shown (`ABCD-EFGH`), when it expires, and the kind asked for. */
export type PairingShown = Readonly<{
  state: "pending";
  kind: DeviceKind;
  code: string;
  expiresAt: string;
}>;

/** What `GET /v1/device` answers (API.md): nothing of an event until the device is paired and activated. */
export type DeviceState =
  | Readonly<{ state: "pending"; kind: DeviceKind; expiresAt: string }>
  | Readonly<{ state: "paired"; activated: false }>
  | Readonly<{
      state: "paired";
      activated: true;
      kind: DeviceKind;
      label: string;
      /**
       * Why it shows nothing now: paused, method_off, hidden, not_started, ended, event_ended, or feature_off (a kiosk
       * while the platform's `kiosks` switch is off); or null.
       */
      shut: string | null;
      event: Readonly<{ name: Bilingual }>;
      quest: Readonly<{ title: Bilingual; points: number }> | null;
      /** A big screen's running scenes, in order (T-504); null for a station, a kiosk or a shut screen. */
      scenes: readonly string[] | null;
      /** The event's own words as stored (a big screen shows its currency, FR-942); null for any other device. */
      terms: unknown;
    }>;

/** A code to show, or why none is shown (`shut`); the quest's title and points either way. */
export type ScreenCodeAnswer =
  | Readonly<{
      state: "open";
      code: string;
      url: string;
      changesInMs: number;
      quest: Readonly<{ title: Bilingual; points: number }>;
    }>
  | Readonly<{ state: string; quest: Readonly<{ title: Bilingual; points: number }> }>;

/** Whether the platform's `stations` switch is on (T-309); on unless a Questify admin switched it off. */
export async function stationsOn(settings: Pick<SettingsService, "forEvent">): Promise<boolean> {
  const config = await settings.forEvent(undefined);
  return config.kind === "ok" && config.config.features["stations"]?.enabled !== false;
}

/**
 * Draws codes until one is free (`code_taken`, up to 3 times, then busy): `sql` stores the drawn code's hash as its
 * second value and answers `at`, the code's expiry. The flood cap (DV503) alerts ops.
 */
async function withFreeCode(
  deps: DeviceDeps,
  sql: string,
  values: Readonly<{ secretHash: Buffer; rest: readonly unknown[]; kind: DeviceKind }>,
): Promise<PairingShown> {
  for (let attempt = 1; ; attempt += 1) {
    const code = generatePairingCode();
    try {
      const at = await withConnection(deps.pool, (client) =>
        withRequestContext(client, {}, async () => {
          const { rows } = await client.query<{ at: Date }>(sql, [
            values.secretHash,
            deps.keys.pairingCodeHash(code),
            ...values.rest,
          ]);
          return (rows[0] as { at: Date }).at;
        }),
      );
      return {
        state: "pending",
        kind: values.kind,
        code: formatPairingCode(code),
        expiresAt: at.toISOString(),
      };
    } catch (error) {
      const pg = error as { code?: string; detail?: string };
      const taken = pg.code === "DV409" && pg.detail === "code_taken";
      if (!taken || attempt >= CODE_TRIES) {
        if (pg.code === "DV503") {
          deps.alarm("device.request_flood", { kind: values.kind });
        }
        throw deviceErrorOf(pg) ?? error;
      }
    }
  }
}

/**
 * A browser asks to be paired (`POST /v1/device/pairing`, public): a new secret (the cookie) and code, stored as hashes
 * (ADR-239). 60 a 10 minutes per address bucket. At the flood cap the answer is 503 busy and ops are alerted
 * (`device.request_flood`, CTO 9).
 *
 * @throws HttpError too_many_attempts, busy, invalid_device.
 */
export async function openPairing(
  deps: DeviceDeps,
  request: Readonly<{ kind: DeviceKind; client: string; address: string }>,
  reply: Reply,
): Promise<Readonly<{ token: string; shown: PairingShown }>> {
  const key = deps.keys.addressKey(addressBucket(request.address));
  await holdBack(deps.pool, [{ limit: DEVICE_LIMITS.requestsPerAddress, key }], true, reply);
  const secret = generateToken();
  const shown = await withFreeCode(
    deps,
    "SELECT expires_at AS at FROM open_device_request($1, $2, $3, $4)",
    {
      secretHash: secretHashOf(secret.token),
      rest: [request.kind, request.client],
      kind: request.kind,
    },
  );
  return { token: secret.token, shown };
}

/** A fresh code for a pending browser, under the same secret (its code expired, or the page was reloaded). */
export function renewPairing(
  deps: DeviceDeps,
  device: Extract<DeviceIdentity, { state: "pending" }>,
): Promise<PairingShown> {
  return withFreeCode(deps, "SELECT renew_device_request($1, $2) AS at", {
    secretHash: device.secretHash,
    rest: [],
    kind: device.kind,
  });
}

const deviceIdOf = (device: DeviceIdentity): string =>
  device.state === "paired" ? device.id : device.secretHash.toString("hex");

/** A device's polls: 30 a minute (API.md). */
export const holdPoll = (deps: DeviceDeps, device: DeviceIdentity, reply: Reply) =>
  holdBack(
    deps.pool,
    [{ limit: DEVICE_LIMITS.pollsPerDevice, key: deps.keys.pairedDeviceKey(deviceIdOf(device)) }],
    true,
    reply,
  );

/** A device's renews and activations: 10 a minute (CTO code review 1). */
export const holdWrite = (deps: DeviceDeps, device: DeviceIdentity, reply: Reply) =>
  holdBack(
    deps.pool,
    [{ limit: DEVICE_LIMITS.writesPerDevice, key: deps.keys.pairedDeviceKey(deviceIdOf(device)) }],
    true,
    reply,
  );

type View = {
  kind: DeviceKind;
  label: string;
  shut: string | null;
  event: { nameAr: string | null; nameEn: string | null };
  quest: { titleAr: string | null; titleEn: string | null; points: number } | null;
  scenes: string[] | null;
  terms: unknown;
};

/**
 * The device's own state (`GET /v1/device`): pending, paired and waiting to activate, or its view (`device_view`). A
 * kiosk is shut `feature_off` while the platform's `kiosks` switch is off (T-309b).
 */
export async function deviceState(deps: DeviceDeps, device: DeviceIdentity): Promise<DeviceState> {
  if (device.state === "pending") {
    return { state: "pending", kind: device.kind, expiresAt: device.expiresAt };
  }
  if (!device.activated) {
    return { state: "paired", activated: false };
  }
  const view = await inDevice(deps.pool, { deviceId: device.id }, async (client) => {
    const { rows } = await client.query<{ view: View }>("SELECT device_view() AS view");
    return (rows[0] as { view: View }).view;
  });
  const off = view.kind === "kiosk" && !(await kiosksOn(deps.settings));
  return {
    state: "paired",
    activated: true,
    kind: view.kind,
    label: view.label,
    shut: off ? "feature_off" : view.shut,
    event: { name: { ar: view.event.nameAr, en: view.event.nameEn } },
    quest:
      view.quest === null
        ? null
        : { title: { ar: view.quest.titleAr, en: view.quest.titleEn }, points: view.quest.points },
    scenes: view.scenes,
    terms: view.terms,
  };
}

/**
 * Replaces a paired device's secret (`POST /v1/device/activate`, CTO 2): the new token for the cookie, or null when the
 * device is already activated under its current secret (nothing changes).
 *
 * @throws HttpError device_unpaired when the device is pending, revoked or ended.
 */
export async function activateDevice(
  deps: DeviceDeps,
  device: DeviceIdentity,
): Promise<string | null> {
  if (device.state !== "paired") {
    throw deviceUnpaired();
  }
  const fresh = generateToken();
  const rotated = await inDevice(deps.pool, {}, async (client) => {
    const { rows } = await client.query<{ rotated: boolean }>(
      "SELECT activate_device($1, $2) AS rotated",
      [device.secretHash, secretHashOf(fresh.token)],
    );
    return rows[0]?.rotated === true;
  });
  return rotated ? fresh.token : null;
}

type CodeRow = {
  quest_id: string;
  shut: string | null;
  window_number: number | null;
  ms_to_next: number | null;
  title_ar: string | null;
  title_en: string | null;
  points: number;
};

/** A code row as the answer: signed by the API (the quest id and the window), or the reason none is shown. */
function codeAnswer(deps: DeviceDeps, row: CodeRow): ScreenCodeAnswer {
  const quest = { title: { ar: row.title_ar, en: row.title_en }, points: row.points };
  if (row.shut !== null || row.window_number === null || row.ms_to_next === null) {
    return { state: row.shut ?? "hidden", quest };
  }
  const code = screenCode(deps.screenKey, row.quest_id, row.window_number);
  return {
    state: "open",
    code,
    url: screenCodeUrl(deps.dashboardOrigin, code),
    changesInMs: row.ms_to_next,
    quest,
  };
}

async function readCode(client: PoolClient, sql: string, values: unknown[]): Promise<CodeRow> {
  const { rows } = await client.query<CodeRow>(sql, values);
  return rows[0] as CodeRow;
}

/**
 * A station's code (`GET /v1/device/screen-code`, FR-314): 6 a minute per device; 403 feature_off while the platform's
 * `stations` switch is off. A read: nothing is written per code.
 */
export async function deviceScreenCode(
  deps: DeviceDeps,
  device: Extract<DeviceIdentity, { state: "paired" }>,
  reply: Reply,
): Promise<ScreenCodeAnswer> {
  if (!(await stationsOn(deps.settings))) {
    throw platformFeatureOff();
  }
  await holdBack(
    deps.pool,
    [{ limit: DEVICE_LIMITS.codesPerDevice, key: deps.keys.pairedDeviceKey(device.id) }],
    true,
    reply,
  );
  const row = await inDevice(deps.pool, { deviceId: device.id }, (client) =>
    readCode(client, "SELECT * FROM screen_code_for_device()", []),
  );
  return codeAnswer(deps, row);
}

/** The operator's own phone showing a quest's code (FR-922): 6 a minute per operator and quest. */
export async function operatorScreenCode(
  deps: DeviceDeps,
  target: Readonly<{ operatorId: string; eventId: string; questId: string }>,
  reply: Reply,
): Promise<ScreenCodeAnswer> {
  if (!(await stationsOn(deps.settings))) {
    throw platformFeatureOff();
  }
  await holdBack(
    deps.pool,
    [
      {
        limit: DEVICE_LIMITS.codesPerOperatorQuest,
        key: deps.keys.playerQuestKey(target.operatorId, target.questId),
      },
    ],
    true,
    reply,
  );
  const row = await inDevice(deps.pool, { playerId: target.operatorId }, (client) =>
    readCode(client, "SELECT * FROM screen_code_for_operator($1, $2)", [
      target.eventId,
      target.questId,
    ]),
  );
  return codeAnswer(deps, row);
}
