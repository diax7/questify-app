import {
  notificationListSchema,
  notificationsUnreadSchema,
  ownPushTopicsSchema,
  type NotificationList,
  type NotificationsReadBody,
  type OwnPushTopics,
  type PushTopicsBody,
} from "@questify/shared";
import { setUnreadIfRead } from "#src/push/unread-store.ts";
import { readOk, type Reader } from "#src/questify/questify-api.ts";

/** How many rows one page of the center asks for (the server allows 50; its default is 20). */
export const CENTER_PAGE_SIZE = 20;

/**
 * One page of the caller's center, newest first; `before` is the previous page's `nextBefore`. Null when the answer is
 * missing or odd, so a failed read is never shown as an empty center.
 */
export function fetchCenterPage(
  session: Reader,
  before: number | null,
): Promise<NotificationList | null> {
  const cursor = before === null ? "" : `&before=${before}`;
  return readOk(
    session,
    `/v1/me/notifications?limit=${CENTER_PAGE_SIZE}${cursor}`,
    notificationListSchema,
  );
}

/**
 * The unread count alone, from a one-row read of the center. The bell follows this on a resume or a foreground push
 * and never the whole profile: a failed profile read would blank `me` and unmount the screens that need it (a game in
 * progress, offline at a venue). Null when unreadable.
 */
export async function fetchUnread(session: Reader): Promise<number | null> {
  const page = await readOk(session, "/v1/me/notifications?limit=1", notificationListSchema);
  return page?.unread ?? null;
}

/** Brings the bell's count up to date; a failed read leaves it, and everything else, as it was. */
export async function refreshUnread(session: Reader): Promise<void> {
  setUnreadIfRead(await fetchUnread(session));
}

/** Marks rows (or all of them) read; the unread count after, or null when the call failed. */
export async function markNotificationsRead(
  session: Reader,
  body: NotificationsReadBody,
): Promise<number | null> {
  const answer = await session.request({ method: "POST", path: "/v1/me/notifications/read", body });
  const parsed = answer.kind === "ok" ? notificationsUnreadSchema.safeParse(answer.body) : null;
  return parsed?.success === true ? parsed.data.unread : null;
}

/** The four topics, true when on, and the ones an event started off; null when unreadable. */
export const fetchTopics = (session: Reader): Promise<OwnPushTopics | null> =>
  readOk(session, "/v1/me/push-topics", ownPushTopicsSchema);

/** Changes the topics named and answers all four; null when the call failed (nothing is assumed saved). */
export async function saveTopics(
  session: Reader,
  body: PushTopicsBody,
): Promise<OwnPushTopics | null> {
  const answer = await session.request({ method: "PUT", path: "/v1/me/push-topics", body });
  const parsed = answer.kind === "ok" ? ownPushTopicsSchema.safeParse(answer.body) : null;
  return parsed?.success === true ? parsed.data : null;
}
