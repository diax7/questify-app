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
import { diff } from "#src/audit/entry";
import { recordAudit, type AuditMeta } from "#src/audit/record";
import {
  deleteEntitlement,
  insertEntitlement,
  lockEventSwitches,
  lockPlatformBlocks,
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
  savePlatformSettings: (
    admin: PublicAccount,
    input: unknown,
    meta?: AuditMeta,
  ) => Promise<SaveResult>;
  /** A member of the organizer replaces the feature switches of one of the organizer's events. */
  saveEventSwitches: (
    actor: Readonly<{ staffUserId: string; organizerId: string }>,
    eventId: string,
    input: unknown,
    meta?: AuditMeta,
  ) => Promise<SaveResult>;
  /**
   * A member of the organizer turns one feature of one event on or off, keeping the event's other switches (who may is
   * the route's rule: the ranking is the owner's, FR-607).
   */
  saveEventSwitch: (
    actor: Readonly<{ staffUserId: string; organizerId: string }>,
    eventId: string,
    feature: string,
    enabled: boolean,
    meta?: AuditMeta,
  ) => Promise<SaveResult>;
  /** A Questify admin unlocks an add-on for an event. */
  unlockFeature: (
    admin: PublicAccount,
    eventId: string,
    feature: string,
    meta?: AuditMeta,
  ) => Promise<SaveResult>;
  /** A Questify admin takes an unlocked add-on away from an event. */
  lockFeature: (
    admin: PublicAccount,
    eventId: string,
    feature: string,
    meta?: AuditMeta,
  ) => Promise<SaveResult>;
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

    savePlatformSettings: (admin, input, meta = {}) =>
      asAdmin(admin, async (client) => {
        const checked = validatePlatformSettings(registries, input);
        if (!checked.ok) {
          return { ok: false, reason: "invalid", issues: checked.issues };
        }
        const keys = (["features", "tuning"] as const).filter(
          (key) => checked.value[key] !== undefined,
        );
        const stored = await lockPlatformBlocks(client, keys);
        const changes = diff(
          Object.fromEntries(keys.map((key) => [key, stored[key] ?? null])),
          Object.fromEntries(keys.map((key) => [key, checked.value[key]])),
        );
        const changed = keys.filter((key) => key in changes.after);
        for (const key of changed) {
          await upsertPlatformBlock(client, key, checked.value[key], admin.id);
        }
        if (changed.length > 0) {
          await recordAudit(client, {
            actor: { type: "admin", id: admin.id },
            action: "platform_settings.update",
            target: { type: "platform_setting", id: changed.join(",") },
            ...changes,
            requestId: meta.requestId,
          });
        }
        return { ok: true };
      }),

    saveEventSwitches: async (actor, eventId, input, meta = {}) => {
      const checked = validateEventConfig(registries, input);
      if (!checked.ok) {
        return { ok: false, reason: "invalid", issues: checked.issues };
      }
      const next = checked.value.features ?? {};
      const found = await withConnection(options.pool, (client) =>
        withRequestContext(
          client,
          { organizerId: actor.organizerId, staffUserId: actor.staffUserId },
          async () => {
            const current = await lockEventSwitches(client, eventId);
            if (current === undefined) {
              return false;
            }
            const changes = diff({ features: current.features ?? {} }, { features: next });
            if ("features" in changes.after) {
              await writeEventSwitches(client, eventId, next);
              await recordAudit(client, {
                actor: { type: "staff", id: actor.staffUserId },
                action: "event.features.update",
                organizerId: current.organizerId,
                eventId,
                target: { type: "event", id: eventId },
                ...changes,
                requestId: meta.requestId,
              });
            }
            return true;
          },
        ),
      );
      forgetAll();
      return found ? { ok: true } : { ok: false, reason: "not_found" };
    },

    saveEventSwitch: async (actor, eventId, feature, enabled, meta = {}) => {
      const checked = validateEventConfig(registries, { features: { [feature]: enabled } });
      if (!checked.ok) {
        return { ok: false, reason: "invalid", issues: checked.issues };
      }
      const found = await withConnection(options.pool, (client) =>
        withRequestContext(
          client,
          { organizerId: actor.organizerId, staffUserId: actor.staffUserId },
          async () => {
            const current = await lockEventSwitches(client, eventId);
            if (current === undefined) {
              return false;
            }
            const before = readEventSwitches({ features: current.features });
            const next = { ...before, [feature]: enabled };
            const changes = diff({ features: before }, { features: next });
            if ("features" in changes.after) {
              await writeEventSwitches(client, eventId, next);
              await recordAudit(client, {
                actor: { type: "staff", id: actor.staffUserId },
                action: "event.features.update",
                organizerId: current.organizerId,
                eventId,
                target: { type: "event", id: eventId },
                ...changes,
                requestId: meta.requestId,
              });
            }
            return true;
          },
        ),
      );
      forgetAll();
      return found ? { ok: true } : { ok: false, reason: "not_found" };
    },

    unlockFeature: (admin, eventId, feature, meta = {}) =>
      asAdmin(admin, async (client) => {
        if (!isGatedFeature(registries, feature)) {
          return {
            ok: false,
            reason: "invalid",
            issues: [{ path: "feature", message: "is not a gated feature of the app" }],
          };
        }
        const change = await insertEntitlement(client, eventId, feature, admin.id);
        if (change.kind === "no_event") {
          return { ok: false, reason: "not_found" };
        }
        if (change.kind === "added") {
          await recordAudit(client, {
            actor: { type: "admin", id: admin.id },
            action: "event.addon.unlock",
            organizerId: change.organizerId,
            eventId,
            target: { type: "event", id: eventId },
            after: { feature },
            requestId: meta.requestId,
          });
        }
        return { ok: true };
      }),

    lockFeature: (admin, eventId, feature, meta = {}) =>
      asAdmin(admin, async (client) => {
        const organizerId = await deleteEntitlement(client, eventId, feature);
        if (organizerId === undefined) {
          return { ok: false, reason: "not_found" };
        }
        await recordAudit(client, {
          actor: { type: "admin", id: admin.id },
          action: "event.addon.lock",
          organizerId,
          eventId,
          target: { type: "event", id: eventId },
          before: { feature },
          requestId: meta.requestId,
        });
        return { ok: true };
      }),
  };
}
