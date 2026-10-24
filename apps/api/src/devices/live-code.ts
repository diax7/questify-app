import type { Pool } from "pg";
import type { AuthKeys } from "#src/auth/keys";
import { platformFeatureOff } from "#src/auth/http-errors";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { DEVICE_LIMITS, holdBack } from "#src/devices/limits";
import { liveCode, type LiveCodeKey } from "#src/quests/qr";
import type { SettingsService } from "#src/settings/service";

export type LiveCodeDeps = Readonly<{
  pool: Pool;
  liveKey: LiveCodeKey;
  keys: Pick<AuthKeys, "playerKey">;
  settings: Pick<SettingsService, "forEvent">;
}>;

/** What `GET /v1/me/live-code` answers: the code to show and the milliseconds until its window changes. */
export type LiveCodeAnswer = Readonly<{ code: string; changesInMs: number }>;

type Reply = Readonly<{ header: (name: string, value: string) => unknown }>;

/** Whether the platform's `kiosks` switch is on (T-309b, ADR-245); on unless a Questify admin switched it off. */
export async function kiosksOn(settings: Pick<SettingsService, "forEvent">): Promise<boolean> {
  const config = await settings.forEvent(undefined);
  return config.kind === "ok" && config.config.features["kiosks"]?.enabled !== false;
}

/**
 * The signed-in player's live code for kiosks (T-309b, ADR-242): their id and the window of the database clock, signed
 * here. 6 a minute per player; 403 feature_off while the `kiosks` switch is off. A read: nothing is written, and the code
 * never reaches a log line.
 *
 * @throws HttpError feature_off, too_many_attempts.
 */
export async function playerLiveCode(
  deps: LiveCodeDeps,
  playerId: string,
  reply: Reply,
): Promise<LiveCodeAnswer> {
  if (!(await kiosksOn(deps.settings))) {
    throw platformFeatureOff();
  }
  await holdBack(
    deps.pool,
    [{ limit: DEVICE_LIMITS.liveCodesPerPlayer, key: deps.keys.playerKey(playerId) }],
    true,
    reply,
  );
  const window = await withConnection(deps.pool, (client) =>
    withRequestContext(client, { playerId }, async () => {
      const { rows } = await client.query<{ window_number: number; ms_to_next: number }>(
        "SELECT * FROM live_code_window()",
      );
      return rows[0] as { window_number: number; ms_to_next: number };
    }),
  );
  return {
    code: liveCode(deps.liveKey, playerId, window.window_number),
    changesInMs: window.ms_to_next,
  };
}
