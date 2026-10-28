import {
  notificationListSchema,
  notificationsUnreadSchema,
  pushTopicsSchema,
  type NotificationList,
  type NotificationsReadBody,
  type PushTopics,
  type PushTopicsBody,
} from "@questify/shared";
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

/** Marks rows (or all of them) read; the unread count after, or null when the call failed. */
export async function markNotificationsRead(
  session: Reader,
  body: NotificationsReadBody,
): Promise<number | null> {
  const answer = await session.request({ method: "POST", path: "/v1/me/notifications/read", body });
  const parsed = answer.kind === "ok" ? notificationsUnreadSchema.safeParse(answer.body) : null;
  return parsed?.success === true ? parsed.data.unread : null;
}

/** The four topics, true when on; null when unreadable. */
export const fetchTopics = (session: Reader): Promise<PushTopics | null> =>
  readOk(session, "/v1/me/push-topics", pushTopicsSchema);

/** Changes the topics named and answers all four; null when the call failed (nothing is assumed saved). */
export async function saveTopics(
  session: Reader,
  body: PushTopicsBody,
): Promise<PushTopics | null> {
  const answer = await session.request({ method: "PUT", path: "/v1/me/push-topics", body });
  const parsed = answer.kind === "ok" ? pushTopicsSchema.safeParse(answer.body) : null;
  return parsed?.success === true ? parsed.data : null;
}
