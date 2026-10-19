import type { Pool, PoolClient } from "pg";
import {
  REGISTRIES,
  composeConfig,
  isGatedFeature,
  readEventSwitches,
  readPlatformSettings,
  validateEventConfig,
  validatePlatformSettings,
  type ComposedConfig,
  type ConfigIssue,
  type PlatformSettings,
  type Registries,
} from "@questify/shared";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { etagOf } from "#src/etag";
import { createTtlCache } from "#src/settings/cache";
import {
  deleteEntitlement,
  insertEntitlement,
  readEntitlements,
  readStoredEventConfig,
  readStoredPlatform,
  upsertPlatformBlock,
  writeEventSwitches,
} from "#src/settings/store";
import type { PublicAccount } from "#src/auth/staff-store";

export type ConfigResult =
  | Readonly<{ kind: "ok"; config: ComposedConfig; etag: string }>
  | Readonly<{ kind: "event_not_found" }>;

export type SaveResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: "invalid"; issues: readonly ConfigIssue[] }>
  | Readonly<{ ok: false; reason: "forbidden" | "not_found" }>;

export type SettingsService = Readonly<{
  /** The configuration an app receives; `undefined` means no event (the platform level only). */
  forEvent: (eventId: string | undefined) => Promise<ConfigResult>;
  /** A Questify admin replaces the feature switches and/or tuning numbers. */
  savePlatformSettings: (admin: PublicAccount, input: unknown) => Promise<SaveResult>;
  /** An organizer replaces the feature switches of one of their own events. */
  saveEventSwitches: (organizerId: string, eventId: string, input: unknown) => Promise<SaveResult>;
  /** A Questify admin unlocks an add-on for an event. */
  unlockFeature: (admin: PublicAccount, eventId: string, feature: string) => Promise<SaveResult>;
  /** A Questify admin takes an unlocked add-on away from an event. */
  lockFeature: (admin: PublicAccount, eventId: string, feature: string) => Promise<SaveResult>;
}>;

export type SettingsOptions = Readonly<{
  pool: Pool;
  registries?: Registries;
  /** How long a reading may be reused. A change reaches every app within this time. */
  ttlMs?: number;
  now?: () => number;
}>;

const DEFAULT_TTL_MS = 15_000;
const MAX_CACHED = 1000;

/** Reads, composes, and saves the platform and event configuration (F-277 to F-282, FR-1503, FR-1504). */
export function createSettingsService(options: SettingsOptions): SettingsService {
  const registries = options.registries ?? REGISTRIES;
  const cacheOptions = {
    ttlMs: options.ttlMs ?? DEFAULT_TTL_MS,
    maxEntries: MAX_CACHED,
    ...(options.now === undefined ? {} : { now: options.now }),
  };
  const platformCache = createTtlCache<PlatformSettings>(cacheOptions);
  const composedCache = createTtlCache<ConfigResult>(cacheOptions);
  const forgetAll = (): void => {
    platformCache.clear();
    composedCache.clear();
  };

  const loadPlatform = async (client: PoolClient): Promise<PlatformSettings> => {
    const cached = platformCache.get("platform");
    if (cached !== undefined) {
      return cached;
    }
    const platform = readPlatformSettings(await readStoredPlatform(client));
    platformCache.set("platform", platform);
    return platform;
  };

  const load = (eventId: string | undefined): Promise<ConfigResult> =>
    withConnection(options.pool, (client) =>
      withRequestContext(client, {}, async () => {
        const platform = await loadPlatform(client);
        if (eventId === undefined) {
          const config = composeConfig(registries, platform, undefined);
          return { kind: "ok", config, etag: etagOf(config) } as const;
        }
        const stored = await readStoredEventConfig(client, eventId);
        if (stored === undefined) {
          return { kind: "event_not_found" } as const;
        }
        const unlocked = await readEntitlements(client, eventId);
        const config = composeConfig(registries, platform, {
          features: readEventSwitches(stored),
          unlocked,
        });
        return { kind: "ok", config, etag: etagOf(config) } as const;
      }),
    );

  const asAdmin = async (
    admin: PublicAccount,
    work: (client: PoolClient) => Promise<SaveResult>,
  ): Promise<SaveResult> => {
    if (admin.platformRole !== "admin" || admin.status !== "active") {
      return { ok: false, reason: "forbidden" };
    }
    const result = await withConnection(options.pool, (client) =>
      withRequestContext(client, { isAdmin: true, staffUserId: admin.id }, () => work(client)),
    );
    forgetAll();
    return result;
  };

  return {
    forEvent: async (eventId) => {
      const key = eventId ?? "platform";
      const cached = composedCache.get(key);
      if (cached !== undefined) {
        return cached;
      }
      const fresh = await load(eventId);
      composedCache.set(key, fresh);
      return fresh;
    },

    savePlatformSettings: (admin, input) =>
      asAdmin(admin, async (client) => {
        const checked = validatePlatformSettings(registries, input);
        if (!checked.ok) {
          return { ok: false, reason: "invalid", issues: checked.issues };
        }
        for (const key of ["features", "tuning"] as const) {
          const block = checked.value[key];
          if (block !== undefined) {
            await upsertPlatformBlock(client, key, block, admin.id);
          }
        }
        return { ok: true };
      }),

    saveEventSwitches: async (organizerId, eventId, input) => {
      const checked = validateEventConfig(registries, input);
      if (!checked.ok) {
        return { ok: false, reason: "invalid", issues: checked.issues };
      }
      const written = await withConnection(options.pool, (client) =>
        withRequestContext(client, { organizerId }, () =>
          writeEventSwitches(client, eventId, checked.value.features ?? {}),
        ),
      );
      forgetAll();
      return written ? { ok: true } : { ok: false, reason: "not_found" };
    },

    unlockFeature: (admin, eventId, feature) =>
      asAdmin(admin, async (client) => {
        if (!isGatedFeature(registries, feature)) {
          return {
            ok: false,
            reason: "invalid",
            issues: [{ path: "feature", message: "is not a gated feature of the app" }],
          };
        }
        const done = await insertEntitlement(client, eventId, feature, admin.id);
        return done ? { ok: true } : { ok: false, reason: "not_found" };
      }),

    lockFeature: (admin, eventId, feature) =>
      asAdmin(admin, async (client) =>
        (await deleteEntitlement(client, eventId, feature))
          ? { ok: true }
          : { ok: false, reason: "not_found" },
      ),
  };
}
