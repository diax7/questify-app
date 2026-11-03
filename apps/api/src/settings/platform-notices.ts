import {
  readBanner,
  readMaintenance,
  type BannerBody,
  type LocalizedText,
  type NoticesView,
} from "@questify/shared";
import type { Pool, PoolClient } from "pg";
import { diff } from "#src/audit/entry";
import { recordAudit, type AuditMeta } from "#src/audit/record";
import type { PublicAccount } from "#src/auth/staff-store";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { isActiveAdmin, runAsAdmin } from "#src/settings/platform-switches";
import type { SaveResult } from "#src/settings/service";
import {
  lockPlatformBlocks,
  readStoredPlatform,
  upsertPlatformBlock,
  type PlatformBlock,
} from "#src/settings/store";

export type PlatformNotices = Readonly<{
  /** What the console's Maintenance and banner tab shows; undefined for anyone but an active platform admin. */
  view: (admin: PublicAccount) => Promise<NoticesView | undefined>;
  /** Pauses play everywhere with this message, or lets it run again with null (T-703b, FR-1771). */
  setGlobalMaintenance: (
    admin: PublicAccount,
    message: LocalizedText | null,
    meta?: AuditMeta,
  ) => Promise<SaveResult>;
  /** Pauses play for the event with this join code; `not_found` when no event has the code. */
  pauseEvent: (
    admin: PublicAccount,
    input: Readonly<{ joinCode: string; message: LocalizedText }>,
    meta?: AuditMeta,
  ) => Promise<SaveResult>;
  /** Lets one event play again; nothing to do when it was not paused. */
  resumeEvent: (admin: PublicAccount, eventId: string, meta?: AuditMeta) => Promise<SaveResult>;
  /** Schedules the banner for Questify Home (FR-1772), replacing the one before, or removes it with null. */
  setBanner: (
    admin: PublicAccount,
    banner: BannerBody | null,
    meta?: AuditMeta,
  ) => Promise<SaveResult>;
}>;

export type PlatformNoticesOptions = Readonly<{
  pool: Pool;
  /** Drops the settings service's cached readings, so a change reaches the apps and the wall at once. */
  forget: () => void;
}>;

type Maintenance = ReturnType<typeof readMaintenance>;

/** The block as it is stored: the global message when there is one, and the events with a message. */
const maintenanceBlock = (settings: Maintenance): Record<string, unknown> => ({
  ...(settings.global === undefined ? {} : { global: settings.global }),
  events: settings.events,
});

/**
 * Replaces one block under its row lock and audits the change with the value before and after
 * (`platform_settings.update`). Nothing is written, or audited, when the block would not change.
 */
async function replaceBlock(
  client: PoolClient,
  admin: PublicAccount,
  change: Readonly<{
    block: PlatformBlock;
    next: (stored: unknown) => unknown;
  }>,
  meta: AuditMeta,
): Promise<SaveResult> {
  const { block } = change;
  const stored = (await lockPlatformBlocks(client, [block]))[block];
  const next = change.next(stored);
  const changes = diff({ [block]: stored ?? null }, { [block]: next });
  if (Object.keys(changes.after).length > 0) {
    await upsertPlatformBlock(client, block, next, admin.id);
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

async function eventNames(
  client: PoolClient,
  ids: readonly string[],
): Promise<Map<string, { joinCode: string; name: { ar: string | null; en: string | null } }>> {
  const { rows } = await client.query<{
    id: string;
    join_code: string;
    name_ar: string | null;
    name_en: string | null;
  }>("SELECT id, join_code, name_ar, name_en FROM event WHERE id = ANY($1::uuid[])", [ids]);
  return new Map(
    rows.map((row) => [
      row.id,
      { joinCode: row.join_code, name: { ar: row.name_ar, en: row.name_en } },
    ]),
  );
}

async function viewOf(client: PoolClient): Promise<NoticesView> {
  const stored = await readStoredPlatform(client);
  const maintenance = readMaintenance(stored.maintenance);
  const paused = Object.entries(maintenance.events);
  const known = await eventNames(
    client,
    paused.map(([eventId]) => eventId),
  );
  return {
    maintenance: {
      global: maintenance.global ?? null,
      events: paused.flatMap(([eventId, message]) => {
        const event = known.get(eventId);
        return event === undefined
          ? []
          : [{ eventId, joinCode: event.joinCode, name: event.name, message }];
      }),
    },
    banner: readBanner(stored.banner) ?? null,
  };
}

/**
 * The console's maintenance mode and banner (T-703b, FR-1771, FR-1772). Every write runs as the admin, so the policies of
 * `platform_setting` ask `app_admin_id()` again, and a caller who is not an active admin is refused before the database
 * is touched. A cleared banner is stored as an empty object, since rows are never deleted.
 */
export function createPlatformNotices(options: PlatformNoticesOptions): PlatformNotices {
  const asAdmin = (admin: PublicAccount, work: (client: PoolClient) => Promise<SaveResult>) =>
    runAsAdmin(options, admin, work);
  const editMaintenance = (
    admin: PublicAccount,
    edit: (settings: Maintenance) => Maintenance,
    meta: AuditMeta,
  ) =>
    asAdmin(admin, (client) =>
      replaceBlock(
        client,
        admin,
        { block: "maintenance", next: (stored) => maintenanceBlock(edit(readMaintenance(stored))) },
        meta,
      ),
    );
  return {
    view: async (admin) =>
      isActiveAdmin(admin)
        ? withConnection(options.pool, (client) =>
            withRequestContext(client, { isAdmin: true, staffUserId: admin.id }, () =>
              viewOf(client),
            ),
          )
        : undefined,

    setGlobalMaintenance: (admin, message, meta = {}) =>
      editMaintenance(
        admin,
        (settings) => ({
          events: settings.events,
          ...(message === null ? {} : { global: message }),
        }),
        meta,
      ),

    pauseEvent: (admin, input, meta = {}) =>
      asAdmin(admin, async (client) => {
        const { rows } = await client.query<{ id: string }>(
          "SELECT id FROM event WHERE lower(join_code) = lower($1)",
          [input.joinCode],
        );
        const eventId = rows[0]?.id;
        if (eventId === undefined) {
          return { ok: false, reason: "not_found" };
        }
        return replaceBlock(
          client,
          admin,
          {
            block: "maintenance",
            next: (stored) => {
              const settings = readMaintenance(stored);
              return maintenanceBlock({
                ...settings,
                events: { ...settings.events, [eventId]: input.message },
              });
            },
          },
          meta,
        );
      }),

    resumeEvent: (admin, eventId, meta = {}) =>
      editMaintenance(
        admin,
        (settings) => ({
          ...settings,
          events: Object.fromEntries(
            Object.entries(settings.events).filter(([id]) => id !== eventId),
          ),
        }),
        meta,
      ),

    setBanner: (admin, banner, meta = {}) =>
      asAdmin(admin, (client) =>
        replaceBlock(
          client,
          admin,
          {
            block: "banner",
            next: () =>
              banner === null
                ? {}
                : {
                    message: banner.message,
                    startsAt: new Date(banner.startsAt).toISOString(),
                    endsAt: new Date(banner.endsAt).toISOString(),
                  },
          },
          meta,
        ),
      ),
  };
}
