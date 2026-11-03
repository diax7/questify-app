import { z } from "zod";
import type { LocalizedText } from "#src/errors";
import { messageSchema } from "#src/switches/switches";

/**
 * Maintenance mode (T-703b, FR-1771): the message players see while play is paused, for every event or for single events.
 * A message present means paused; stored as the `maintenance` block of `platform_setting`.
 */
export type MaintenanceSettings = Readonly<{
  global?: LocalizedText | undefined;
  /** Event id to the message of that event only. */
  events: Readonly<Record<string, LocalizedText>>;
}>;

/** The banner Questify scheduled for Questify Home (FR-1772): shown from `startsAt` until `endsAt`, both ISO instants. */
export type BannerSetting = Readonly<{ message: LocalizedText; startsAt: string; endsAt: string }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A message with both languages filled, or undefined: a half message is not shown. */
export function readNoticeMessage(value: unknown): LocalizedText | undefined {
  const parsed = messageSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** Reads the stored maintenance block tolerantly: whatever is well formed is kept, the rest is dropped. */
export function readMaintenance(stored: unknown): MaintenanceSettings {
  if (!isRecord(stored)) {
    return { events: {} };
  }
  const global = readNoticeMessage(stored["global"]);
  const events = isRecord(stored["events"])
    ? Object.fromEntries(
        Object.entries(stored["events"]).flatMap(([eventId, value]) => {
          const message = readNoticeMessage(value);
          return message === undefined || !UUID.test(eventId) ? [] : [[eventId, message]];
        }),
      )
    : {};
  return { ...(global === undefined ? {} : { global }), events };
}

const instant = (value: unknown): number =>
  typeof value === "string" ? Date.parse(value) : Number.NaN;

/** Reads a banner (stored or received) tolerantly: undefined unless it has a message and a start before its end. */
export function readBanner(stored: unknown): BannerSetting | undefined {
  if (!isRecord(stored)) {
    return undefined;
  }
  const message = readNoticeMessage(stored["message"]);
  const starts = instant(stored["startsAt"]);
  const ends = instant(stored["endsAt"]);
  if (message === undefined || !(starts < ends)) {
    return undefined;
  }
  return {
    message,
    startsAt: new Date(starts).toISOString(),
    endsAt: new Date(ends).toISOString(),
  };
}

/**
 * The message that pauses play for a request: the event's own, else the platform-wide one, else none. Without an event
 * only the platform-wide message applies.
 */
export function maintenanceFor(
  settings: MaintenanceSettings | undefined,
  eventId: string | undefined,
): LocalizedText | null {
  const own = eventId === undefined ? undefined : settings?.events[eventId];
  return own ?? settings?.global ?? null;
}

/** True while `now` is inside the banner's window: the start is included, the end is not (FR-1772). */
export function bannerActive(banner: BannerSetting | null | undefined, now: number): boolean {
  return banner !== null && banner !== undefined
    ? Date.parse(banner.startsAt) <= now && now < Date.parse(banner.endsAt)
    : false;
}

/** What `PUT /v1/admin/switches/maintenance/global` takes. */
export const maintenanceBodySchema = z.strictObject({ message: messageSchema });
export type MaintenanceBody = z.infer<typeof maintenanceBodySchema>;

/** What `PUT /v1/admin/switches/maintenance/events` takes: the event by its join code. */
export const eventMaintenanceBodySchema = z.strictObject({
  joinCode: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{4,12}$/),
  message: messageSchema,
});
export type EventMaintenanceBody = z.infer<typeof eventMaintenanceBodySchema>;

/** What `PUT /v1/admin/switches/banner` takes: the message and the window, which must end after it starts. */
export const bannerBodySchema = z
  .strictObject({
    message: messageSchema,
    startsAt: z.iso.datetime(),
    endsAt: z.iso.datetime(),
  })
  .refine((body) => Date.parse(body.startsAt) < Date.parse(body.endsAt), {
    path: ["endsAt"],
    message: "must be after the start",
  });
export type BannerBody = z.infer<typeof bannerBodySchema>;

const bannerSchema = z.strictObject({
  message: messageSchema,
  startsAt: z.string(),
  endsAt: z.string(),
});

/** What `GET /v1/admin/switches/notices` answers. */
export const noticesViewSchema = z.strictObject({
  maintenance: z.strictObject({
    global: messageSchema.nullable(),
    events: z.array(
      z.strictObject({
        eventId: z.string(),
        joinCode: z.string(),
        name: z.strictObject({ ar: z.string().nullable(), en: z.string().nullable() }),
        message: messageSchema,
      }),
    ),
  }),
  banner: bannerSchema.nullable(),
});
export type NoticesView = z.infer<typeof noticesViewSchema>;
