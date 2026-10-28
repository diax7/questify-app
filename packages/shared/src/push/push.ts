import { z } from "zod";

/**
 * Push notifications, the notification center and per-topic mute (T-501, ADR-343 to ADR-350): the request and answer
 * shapes of `PUT`/`DELETE /v1/me/push-device`, `GET /v1/me/notifications`, `POST /v1/me/notifications/read` and
 * `GET`/`PUT /v1/me/push-topics`. No route takes a player id: each is the caller's own.
 */

/** The four topics a player can mute (FR-1115); a kind without one cannot be muted in the app. */
export const PUSH_TOPICS = ["announcements", "rank", "community", "reminders"] as const;
export type PushTopic = (typeof PUSH_TOPICS)[number];

/** The most rows one page of the center holds, and the default. */
export const NOTIFICATION_PAGE_MAX = 50;
export const NOTIFICATION_PAGE_DEFAULT = 20;
/** The unread count is shown up to this many (the bell's dot and `GET /v1/me`). */
export const NOTIFICATION_UNREAD_CAP = 100;
/** At most this many ids in one mark-read call. */
export const NOTIFICATION_READ_MAX = 100;

const IOS_TOKEN = /^[0-9A-Fa-f]{64,200}$/;
const ANDROID_TOKEN = /^[A-Za-z0-9_:-]{20,2048}$/;

/**
 * `PUT /v1/me/push-device`: this sign-in's device. An iOS token is hex (sent lower-case) and names the device's APNs
 * environment (read from the build, ADR-344 (5)); an Android (FCM) token names none.
 */
export const pushDeviceBodySchema = z
  .strictObject({
    platform: z.enum(["ios", "android"]),
    token: z.string().max(2048),
    environment: z.enum(["sandbox", "production"]).optional(),
    language: z.enum(["ar", "en"]),
    appVersion: z.string().regex(/^[0-9A-Za-z.+-]{1,20}$/),
  })
  .refine((body) => (body.platform === "ios") === (body.environment !== undefined), {
    path: ["environment"],
    message: "an iOS device names its APNs environment; an Android one names none",
  })
  .refine((body) => (body.platform === "ios" ? IOS_TOKEN : ANDROID_TOKEN).test(body.token), {
    path: ["token"],
    message: "not a device token",
  });
export type PushDeviceBody = z.infer<typeof pushDeviceBodySchema>;

/** `GET /v1/me/push-topics`: each topic, true when on (not muted). */
export const pushTopicsSchema = z.strictObject({
  announcements: z.boolean(),
  rank: z.boolean(),
  community: z.boolean(),
  reminders: z.boolean(),
});
export type PushTopics = z.infer<typeof pushTopicsSchema>;

/** `PUT /v1/me/push-topics`: the topics named change; the others stay as they are. */
export const pushTopicsBodySchema = pushTopicsSchema
  .partial()
  .refine((topics) => Object.keys(topics).length > 0, "name at least one topic");
export type PushTopicsBody = z.infer<typeof pushTopicsBodySchema>;

const pageNumber = z.string().regex(/^[1-9][0-9]{0,14}$/);

/** `GET /v1/me/notifications?before=&limit=`: rows with an id below `before` (none: the newest), 1 to 50 of them. */
export const notificationsQuerySchema = z
  .strictObject({ before: pageNumber.optional(), limit: pageNumber.optional() })
  .transform((query) => ({
    before: query.before === undefined ? null : Number(query.before),
    limit: query.limit === undefined ? NOTIFICATION_PAGE_DEFAULT : Number(query.limit),
  }))
  .refine((query) => query.limit <= NOTIFICATION_PAGE_MAX, "at most 50 a page");
export type NotificationsQuery = z.infer<typeof notificationsQuerySchema>;

const notificationId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** `POST /v1/me/notifications/read`: 1 to 100 of the caller's rows, or all of them. */
export const notificationsReadBodySchema = z
  .strictObject({ ids: z.array(notificationId).min(1).max(NOTIFICATION_READ_MAX) })
  .or(z.strictObject({ all: z.literal(true) }));
export type NotificationsReadBody = z.infer<typeof notificationsReadBodySchema>;

/** A reference's name in a center row or a push payload (`quest`, `category`, `reward`, ...). */
export const REF_KEY = /^[a-z][A-Za-z]{0,30}$/;
/** A reference's value: a UUID or a whole number, as text. Nothing else about a notice leaves the server. */
export const REF_VALUE =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9]{1,18})$/;

/** An event's join code (`event.join_code`), the only text besides ids a center row may carry. */
export const JOIN_CODE = /^[A-Za-z0-9]{4,12}$/;

/**
 * One center row as the app shows it: the text rendered in the request's language (the same fixed template as the
 * push), ids only besides: `refs` holds the notice's reference ids, which the app maps to its own routes (ADR-349 (4)).
 * `optOut` marks a promotional row, which carries the way to Settings → Offers and notifications (FR-1114). `joinCode`
 * is an invitation's public event code (ADR-356 (6)): the row's "See the event" opens the join screen with it.
 */
export const notificationItemSchema = z.strictObject({
  id: notificationId,
  kind: z.string().regex(/^[a-z][a-z_]{0,39}$/),
  topic: z.enum(PUSH_TOPICS).nullable(),
  eventId: z.uuid().nullable(),
  refs: z.record(z.string().regex(REF_KEY), z.string().regex(REF_VALUE)),
  title: z.string().min(1),
  body: z.string().min(1),
  createdAt: z.string(),
  read: z.boolean(),
  optOut: z.boolean(),
  joinCode: z.string().regex(JOIN_CODE).nullable(),
});
export type NotificationItem = z.infer<typeof notificationItemSchema>;

const unreadCount = z.number().int().min(0).max(NOTIFICATION_UNREAD_CAP);

/** `GET /v1/me/notifications`: newest first; `nextBefore` asks for the next page (null on the last). */
export const notificationListSchema = z.strictObject({
  items: z.array(notificationItemSchema).max(NOTIFICATION_PAGE_MAX),
  nextBefore: notificationId.nullable(),
  unread: unreadCount,
});
export type NotificationList = z.infer<typeof notificationListSchema>;

/** `POST /v1/me/notifications/read`'s answer, and `GET /v1/me`'s `notifications`. */
export const notificationsUnreadSchema = z.strictObject({ unread: unreadCount });
export type NotificationsUnread = z.infer<typeof notificationsUnreadSchema>;

/** The fields a 422 `invalid_push_device` can name. */
export const invalidPushDeviceSchema = z.strictObject({
  field: z.enum(["platform", "token", "environment", "language", "appVersion"]),
});
