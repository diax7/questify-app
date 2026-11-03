import {
  isOrganizerOverridable,
  organizerFeaturesView,
  readPlatformSettings,
  type OrganizerFeaturesView,
  type Registries,
} from "@questify/shared";
import type { Pool, PoolClient } from "pg";
import { recordAudit, type AuditMeta } from "#src/audit/record";
import type { PublicAccount } from "#src/auth/staff-store";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import {
  deleteOverride,
  lockOverride,
  readOrganizerOverrides,
  readStoredPlatform,
  upsertOverride,
} from "#src/settings/store";

export type OverrideResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: "forbidden" | "not_found" | "not_overridable" }>;

export type OrganizerOverrideService = Readonly<{
  /** The console's list for one organizer; undefined for anyone but an active platform admin or an unknown organizer. */
  view: (admin: PublicAccount, organizerId: string) => Promise<OrganizerFeaturesView | undefined>;
  /** Sets one feature On or Off for the organizer, or back to the platform's switch with null (T-711, FR-1826). */
  set: (
    admin: PublicAccount,
    organizerId: string,
    feature: string,
    enabled: boolean | null,
    meta?: AuditMeta,
  ) => Promise<OverrideResult>;
}>;

export type OrganizerOverridesOptions = Readonly<{
  pool: Pool;
  registries: Registries;
  /** Drops the settings service's cached readings, so a change reaches the apps at once. */
  forget: () => void;
}>;

const isActiveAdmin = (admin: PublicAccount): boolean =>
  admin.platformRole === "admin" && admin.status === "active";

/** Changes one override under its lock and audits it with the value before and after (nothing when it did not change). */
async function change(
  client: PoolClient,
  admin: PublicAccount,
  target: Readonly<{ organizerId: string; feature: string; enabled: boolean | null }>,
  meta: AuditMeta,
): Promise<OverrideResult> {
  const { organizerId, feature, enabled } = target;
  const { organizerFound, current } = await lockOverride(client, organizerId, feature);
  if (!organizerFound) {
    return { ok: false, reason: "not_found" };
  }
  if ((current ?? null) === enabled) {
    return { ok: true };
  }
  if (enabled === null) {
    await deleteOverride(client, organizerId, feature);
  } else {
    await upsertOverride(client, { organizerId, feature, enabled, adminId: admin.id });
  }
  await recordAudit(client, {
    actor: { type: "admin", id: admin.id },
    action:
      enabled === null ? "organizer.feature_override.clear" : "organizer.feature_override.set",
    organizerId,
    target: { type: "organizer", id: organizerId },
    before: { [feature]: current ?? null },
    after: { [feature]: enabled },
    requestId: meta.requestId,
  });
  return { ok: true };
}

/**
 * The console's per-organizer feature overrides (T-711, FR-1826). Each runs as the admin, so the table's policies ask
 * `app_admin_id()` again; a caller who is not an active admin is refused before the database is touched. One feature per
 * call, so two admins on two features never overwrite each other.
 */
export function createOrganizerOverrides(
  options: OrganizerOverridesOptions,
): OrganizerOverrideService {
  const { pool, registries, forget } = options;
  const asAdmin = <R>(admin: PublicAccount, work: (client: PoolClient) => Promise<R>): Promise<R> =>
    withConnection(pool, (client) =>
      withRequestContext(client, { isAdmin: true, staffUserId: admin.id }, () => work(client)),
    );
  return {
    view: async (admin, organizerId) => {
      if (!isActiveAdmin(admin)) {
        return undefined;
      }
      return asAdmin(admin, async (client) => {
        const known = await client.query("SELECT 1 FROM organizer WHERE id = $1", [organizerId]);
        if (known.rowCount === 0) {
          return undefined;
        }
        const platform = readPlatformSettings(await readStoredPlatform(client));
        const overrides = await readOrganizerOverrides(client, organizerId);
        return organizerFeaturesView(registries, platform, overrides);
      });
    },

    set: async (admin, organizerId, feature, enabled, meta = {}) => {
      if (!isActiveAdmin(admin)) {
        return { ok: false, reason: "forbidden" };
      }
      const definition = Object.hasOwn(registries.features, feature)
        ? registries.features[feature]
        : undefined;
      if (definition === undefined || !isOrganizerOverridable(definition)) {
        return { ok: false, reason: "not_overridable" };
      }
      try {
        return await asAdmin(admin, (client) =>
          change(client, admin, { organizerId, feature, enabled }, meta),
        );
      } finally {
        forget();
      }
    },
  };
}
