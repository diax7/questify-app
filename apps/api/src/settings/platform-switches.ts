import {
  buildSwitchesView,
  readPlatformSettings,
  validatePlatformSettings,
  type FeatureSwitchBody,
  type Registries,
  type SwitchesView,
} from "@questify/shared";
import type { Pool, PoolClient } from "pg";
import { diff } from "#src/audit/entry";
import { recordAudit, type AuditMeta } from "#src/audit/record";
import type { PublicAccount } from "#src/auth/staff-store";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { SaveResult } from "#src/settings/service";
import { lockPlatformBlocks, readStoredPlatform, upsertPlatformBlock } from "#src/settings/store";

export type PlatformSwitches = Readonly<{
  /** What the console's Switches page shows (T-703); undefined for anyone but an active platform admin. */
  view: (admin: PublicAccount) => Promise<SwitchesView | undefined>;
  /**
   * Sets one platform feature switch, or puts it back to the app's own with null (T-703, FR-1769). Only that key
   * changes, so two admins on two switches never overwrite each other.
   */
  setFeature: (
    admin: PublicAccount,
    key: string,
    setting: FeatureSwitchBody | null,
    meta?: AuditMeta,
  ) => Promise<SaveResult>;
  /** Sets one tuning number inside its range, or puts it back to the default with null (T-703, FR-1770). */
  setTuning: (
    admin: PublicAccount,
    key: string,
    value: number | null,
    meta?: AuditMeta,
  ) => Promise<SaveResult>;
}>;

export type PlatformSwitchesOptions = Readonly<{
  pool: Pool;
  registries: Registries;
  /** Drops the settings service's cached readings, so a change reaches the apps at once. */
  forget: () => void;
}>;

type Block = "features" | "tuning";

const isActiveAdmin = (admin: PublicAccount): boolean =>
  admin.platformRole === "admin" && admin.status === "active";

/** Changes one key of one stored block under its row lock, validates the block, writes it and audits that key. */
async function changeKey(
  client: PoolClient,
  registries: Registries,
  admin: PublicAccount,
  change: Readonly<{ block: Block; key: string; value: unknown }>,
  meta: AuditMeta,
): Promise<SaveResult> {
  const { block, key, value } = change;
  const locked = await lockPlatformBlocks(client, [block]);
  const current = readPlatformSettings({ [block]: locked[block] })[block] ?? {};
  const { [key]: before, ...others } = current as Record<string, unknown>;
  const checked = validatePlatformSettings(registries, {
    [block]: value === null ? others : { ...others, [key]: value },
  });
  if (!checked.ok) {
    return { ok: false, reason: "invalid", issues: checked.issues };
  }
  const name = `${block}.${key}`;
  const changes = diff({ [name]: before ?? null }, { [name]: value });
  if (Object.keys(changes.after).length > 0) {
    await upsertPlatformBlock(client, block, checked.value[block], admin.id);
    await recordAudit(client, {
      actor: { type: "admin", id: admin.id },
      action: "platform_settings.update",
      target: { type: "platform_setting", id: block },
      ...changes,
      requestId: meta.requestId,
    });
  }
  return { ok: true };
}

/**
 * The console's one-key writes of the platform switches and tuning numbers (T-703). Each runs as the admin, so the
 * policies of `platform_setting` ask `app_admin_id()` again; a caller who is not an active admin is refused before the
 * database is touched.
 */
export function createPlatformSwitches(options: PlatformSwitchesOptions): PlatformSwitches {
  const { pool, registries, forget } = options;
  const asAdmin = async (
    admin: PublicAccount,
    work: (client: PoolClient) => Promise<SaveResult>,
  ): Promise<SaveResult> => {
    if (!isActiveAdmin(admin)) {
      return { ok: false, reason: "forbidden" };
    }
    try {
      return await withConnection(pool, (client) =>
        withRequestContext(client, { isAdmin: true, staffUserId: admin.id }, () => work(client)),
      );
    } finally {
      forget();
    }
  };
  return {
    view: async (admin) => {
      if (!isActiveAdmin(admin)) {
        return undefined;
      }
      const stored = await withConnection(pool, (client) =>
        withRequestContext(client, { isAdmin: true, staffUserId: admin.id }, () =>
          readStoredPlatform(client),
        ),
      );
      return buildSwitchesView(registries, readPlatformSettings(stored));
    },

    setFeature: (admin, key, setting, meta = {}) => {
      const value =
        setting === null
          ? null
          : {
              enabled: setting.enabled,
              ...(setting.message === null ? {} : { message: setting.message }),
            };
      return asAdmin(admin, (client) =>
        changeKey(client, registries, admin, { block: "features", key, value }, meta),
      );
    },

    setTuning: (admin, key, value, meta = {}) =>
      asAdmin(admin, (client) =>
        changeKey(client, registries, admin, { block: "tuning", key, value }, meta),
      ),
  };
}
