import type { Pool, PoolClient } from "pg";
import {
  REGISTRIES,
  composeConfig,
  isGatedFeature,
  platformForOrganizer,
  readBranding,
  readEventLayout,
  readEventSwitches,
  readEventTerms,
  readEventTexts,
  readPlatformSettings,
  readStoredBranding,
  readStoredLayout,
  readStoredTerms,
  readStoredTexts,
  validateEventConfig,
  validatePlatformSettings,
  withLegal,
  type ComposedBody,
  type ComposedConfig,
  type ConfigIssue,
  type EventConfig,
  type EventLayers,
  type EventLayout,
  type EventTexts,
  type LegalInForce,
  type PlatformSettings,
  type Registries,
} from "@questify/shared";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { etagOf } from "#src/etag";
import { readInForce } from "#src/legal/in-force";
import { createTtlCache } from "#src/settings/cache";
import { diff } from "#src/audit/entry";
import { recordAudit, type AuditMeta } from "#src/audit/record";
import {
  deleteEntitlement,
  insertEntitlement,
  lockPlatformBlocks,
  readEntitlements,
  readEventOverrides,
  readStoredEventConfig,
  readStoredPlatform,
  upsertPlatformBlock,
} from "#src/settings/store";
import { saveBranding, saveLayout, saveTerms, saveTexts } from "#src/settings/save-event-config";
import {
  readOwnerLayers,
  saveSwitches,
  type SwitchActor,
  type SwitchChange,
} from "#src/settings/save-event-switches";
import { closeOpenRequests } from "#src/settings/feature-requests";
import { runAsAdmin } from "#src/settings/platform-switches";
import type { PublicAccount } from "#src/auth/staff-store";

export type ConfigResult =
  | Readonly<{ kind: "ok"; config: ComposedConfig; etag: string }>
  | Readonly<{ kind: "event_not_found" }>;

export type SaveResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: "invalid"; issues: readonly ConfigIssue[] }>
  | Readonly<{ ok: false; reason: "forbidden" | "not_found" | "archived" | "not_allowed" }>;

/** A layout save answers with the layout it stored (a preset is laid over the event's cards, so the caller cannot know it). */
export type LayoutSaveResult =
  | Readonly<{ ok: true; layout: EventLayout }>
  | Exclude<SaveResult, Readonly<{ ok: true }>>;

/** A labels save answers with the labels it stored, cleaned (the caller cannot know what cleaning made of its text). */
export type TextsSaveResult =
  | Readonly<{ ok: true; texts: EventTexts }>
  | Exclude<SaveResult, Readonly<{ ok: true }>>;

/** The composed configuration with the legal block, and its ETag. */
function answerOf(body: ComposedBody, inForce: LegalInForce): ConfigResult {
  const config = withLegal(body, inForce);
  return { kind: "ok", config, etag: etagOf(config) };
}

/** The event's stored config as the composer reads it: each block tolerantly, so a damaged one is the default. */
function eventConfigOf(eventId: string, stored: unknown, unlocked: readonly string[]): EventConfig {
  return {
    id: eventId,
    features: readEventSwitches(stored),
    unlocked,
    terms: readEventTerms(readStoredTerms(stored)),
    texts: readEventTexts(readStoredTexts(stored)),
    branding: readBranding(readStoredBranding(stored)),
    layout: readEventLayout(readStoredLayout(stored)),
  };
}

export type SettingsService = Readonly<{
  /**
   * The configuration an app receives; `undefined` means no event (the platform level only). Without a player it is
   * what anyone may see (a public event); with one, also the events that player joined (unlisted and private ones).
   */
  forEvent: (eventId: string | undefined, playerId?: string) => Promise<ConfigResult>;
  /** The platform settings as the apps get them (cached for the service's time), for the maintenance wall (T-703b). */
  platform: () => Promise<PlatformSettings>;
  /** A Questify admin replaces the feature switches and/or tuning numbers. */
  savePlatformSettings: (
    admin: PublicAccount,
    input: unknown,
    meta?: AuditMeta,
  ) => Promise<SaveResult>;
  /**
   * What a member of the organizer sees of an event's features (FR-1826, FR-1827): the ones the platform leaves on for this
   * organizer, each on, off or (an add-on Questify has not allowed) locked. Undefined when the event is not theirs.
   */
  eventLayers: (
    actor: Readonly<{ staffUserId: string; organizerId: string }>,
    eventId: string,
  ) => Promise<EventLayers | undefined>;
  /**
   * A member of the organizer replaces the feature switches of one of the organizer's events. A feature the platform or
   * Questify keeps off for it cannot be switched on (`not_allowed`).
   */
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
  /**
   * A member of the organizer replaces the event's words (FR-404, FR-940): a word left out returns to the default.
   * Any status but archived, since a name can be fixed after the event.
   */
  saveEventTerms: (
    actor: Readonly<{ staffUserId: string; organizerId: string }>,
    eventId: string,
    input: unknown,
    meta?: AuditMeta,
  ) => Promise<SaveResult>;
  /**
   * A member of the organizer replaces the labels the event renamed (FR-1843): approved labels only, a blank one back to the
   * platform's text. Any status but archived, as the words.
   */
  saveEventTexts: (
    actor: Readonly<{ staffUserId: string; organizerId: string }>,
    eventId: string,
    input: unknown,
    meta?: AuditMeta,
  ) => Promise<TextsSaveResult>;
  /**
   * A member of the organizer picks the event's accent colour from the curated list, or null for the brand colour
   * (FR-1023). Any status but archived, as the words.
   */
  saveEventBranding: (
    actor: Readonly<{ staffUserId: string; organizerId: string }>,
    eventId: string,
    input: unknown,
    meta?: AuditMeta,
  ) => Promise<SaveResult>;
  /**
   * A member of the organizer replaces the event's layout (FR-1749, FR-1764): an approved preset by name, or the order and
   * hidden set of the bar and Home. Protected items cannot be hidden. Any status but archived.
   */
  saveEventLayout: (
    actor: Readonly<{ staffUserId: string; organizerId: string }>,
    eventId: string,
    input: unknown,
    meta?: AuditMeta,
  ) => Promise<LayoutSaveResult>;
  /** A Questify admin unlocks an add-on for an event, closing the owner's open Ask Questify request for it (T-711b). */
  unlockFeature: (
    admin: PublicAccount,
    eventId: string,
    feature: string,
    meta?: AuditMeta,
  ) => Promise<SaveResult>;
  /** Drops every cached reading, after a change made outside this service (activation, T-210). */
  forget: () => void;
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
/** Unlocks an add-on for an event as the admin, audited when new, and closes the owner's open request for it. */
async function unlockAddon(
  client: PoolClient,
  registries: Registries,
  admin: PublicAccount,
  target: Readonly<{ eventId: string; feature: string }>,
  meta: AuditMeta,
): Promise<SaveResult> {
  const { eventId, feature } = target;
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
  // Allow on the console's Requests list is this unlock: it closes the owner's open request (T-711b, ADR-545).
  await closeOpenRequests(client, admin, { eventId, feature }, meta);
  return { ok: true };
}

/** The cached readers of the platform and event configuration, and the call that drops every cached reading. */
function createReaders(options: SettingsOptions, registries: Registries) {
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

  const load = (eventId: string | undefined, playerId: string | undefined): Promise<ConfigResult> =>
    withConnection(options.pool, (client) =>
      withRequestContext(client, playerId === undefined ? {} : { playerId }, async () => {
        const platform = await loadPlatform(client);
        const inForce = await readInForce(client);
        if (eventId === undefined) {
          return answerOf(composeConfig(registries, platform, undefined), inForce);
        }
        const stored = await readStoredEventConfig(client, eventId);
        if (stored === undefined) {
          return { kind: "event_not_found" } as const;
        }
        const unlocked = await readEntitlements(client, eventId);
        const overrides = await readEventOverrides(client, eventId);
        const body = composeConfig(
          registries,
          platformForOrganizer(registries, platform, overrides),
          eventConfigOf(eventId, stored, unlocked),
        );
        return answerOf(body, inForce);
      }),
    );

  const reading = async (
    eventId: string | undefined,
    playerId: string | undefined,
  ): Promise<ConfigResult> => {
    const key = `${eventId ?? "platform"}:${playerId ?? ""}`;
    const cached = composedCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const fresh = await load(eventId, playerId);
    composedCache.set(key, fresh);
    return fresh;
  };

  return {
    forgetAll,
    platform: async () =>
      platformCache.get("platform") ??
      (await withConnection(options.pool, (client) =>
        withRequestContext(client, {}, () => loadPlatform(client)),
      )),
    forEvent: async (eventId: string | undefined, playerId?: string): Promise<ConfigResult> => {
      // The document depends only on the event; who may see it is what differs. A public event is read once for
      // everyone, and only an event hidden from anyone is read again as the player, cached for that player alone.
      const shared = await reading(eventId, undefined);
      if (playerId === undefined || shared.kind === "ok") {
        return shared;
      }
      return reading(eventId, playerId);
    },
  };
}

/** A Questify admin replaces the feature switches and/or tuning numbers; one audit entry names the blocks that changed. */
async function savePlatform(
  client: PoolClient,
  registries: Registries,
  admin: PublicAccount,
  input: unknown,
  meta: AuditMeta,
): Promise<SaveResult> {
  const checked = validatePlatformSettings(registries, input);
  if (!checked.ok) {
    return { ok: false, reason: "invalid", issues: checked.issues };
  }
  const keys = (["features", "tuning"] as const).filter((key) => checked.value[key] !== undefined);
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
}

/** Takes an unlocked add-on away from an event as the admin, audited. */
async function lockAddon(
  client: PoolClient,
  admin: PublicAccount,
  target: Readonly<{ eventId: string; feature: string }>,
  meta: AuditMeta,
): Promise<SaveResult> {
  const { eventId, feature } = target;
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
}

export function createSettingsService(options: SettingsOptions): SettingsService {
  const registries = options.registries ?? REGISTRIES;
  const { forgetAll, platform, forEvent } = createReaders(options, registries);

  const thenForget = <R>(saving: Promise<R>): Promise<R> => saving.finally(forgetAll);

  const asAdmin = (admin: PublicAccount, work: (client: PoolClient) => Promise<SaveResult>) =>
    runAsAdmin({ pool: options.pool, forget: forgetAll }, admin, work);

  const changeSwitches = (
    actor: SwitchActor,
    eventId: string,
    meta: AuditMeta,
    change: (before: Readonly<Record<string, boolean>>) => SwitchChange,
  ): Promise<SaveResult> =>
    thenForget(saveSwitches(options.pool, registries, actor, eventId, change, meta));

  return {
    platform,

    forEvent,

    savePlatformSettings: (admin, input, meta = {}) =>
      asAdmin(admin, (client) => savePlatform(client, registries, admin, input, meta)),

    eventLayers: (actor, eventId) => readOwnerLayers(options.pool, registries, actor, eventId),

    saveEventSwitches: async (actor, eventId, input, meta = {}) => {
      const checked = validateEventConfig(registries, input);
      if (!checked.ok) {
        return { ok: false, reason: "invalid", issues: checked.issues };
      }
      const next = checked.value.features ?? {};
      return changeSwitches(actor, eventId, meta, (before) => ({
        next,
        requested: Object.fromEntries(
          Object.entries(next).filter(([key, enabled]) => enabled && before[key] !== true),
        ),
      }));
    },

    saveEventSwitch: async (actor, eventId, feature, enabled, meta = {}) => {
      const checked = validateEventConfig(registries, { features: { [feature]: enabled } });
      if (!checked.ok) {
        return { ok: false, reason: "invalid", issues: checked.issues };
      }
      return changeSwitches(actor, eventId, meta, (before) => ({
        next: { ...before, [feature]: enabled },
        requested: { [feature]: enabled },
      }));
    },

    saveEventTerms: (actor, eventId, input, meta = {}) =>
      thenForget(saveTerms(options.pool, actor, eventId, input, meta)),

    saveEventTexts: (actor, eventId, input, meta = {}) =>
      thenForget(saveTexts(options.pool, actor, eventId, input, meta)),

    saveEventBranding: (actor, eventId, input, meta = {}) =>
      thenForget(saveBranding(options.pool, actor, eventId, input, meta)),

    saveEventLayout: (actor, eventId, input, meta = {}) =>
      thenForget(saveLayout(options.pool, actor, eventId, input, meta)),

    forget: forgetAll,

    unlockFeature: (admin, eventId, feature, meta = {}) =>
      asAdmin(admin, (client) =>
        unlockAddon(client, registries, admin, { eventId, feature }, meta),
      ),

    lockFeature: (admin, eventId, feature, meta = {}) =>
      asAdmin(admin, (client) => lockAddon(client, admin, { eventId, feature }, meta)),
  };
}
