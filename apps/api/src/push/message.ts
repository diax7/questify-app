import { REF_KEY, REF_VALUE, renderNotice, type Language, type PushTexts } from "@questify/shared";
import type { PushMessage } from "#src/push/provider";

/** A claimed send as push_claim answers it (migration 0076). */
export type ClaimedSend = Readonly<{
  send_id: string;
  lease: string;
  lease_until: Date;
  target: string;
  token: string;
  language: Language;
  kind: string;
  class: "personal" | "event" | "promo";
  topic: string | null;
  notification_id: string;
  event_id: string | null;
  refs: unknown;
  params: unknown;
  expires_at: Date;
  priority: number;
  attempts: number;
  terms: unknown;
  timezone: string | null;
}>;

/** A reference's value as id text, or null when it is not an id. */
function idText(value: unknown): string | null {
  const text = typeof value === "number" ? String(value) : value;
  return typeof text === "string" && REF_VALUE.test(text) ? text : null;
}

/** The notice's reference ids, and nothing else: a key that is not a name or a value that is not an id is dropped. */
export function refIds(refs: unknown): Readonly<Record<string, string>> {
  if (typeof refs !== "object" || refs === null || Array.isArray(refs)) return {};
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(refs)) {
    const text = idText(value);
    if (REF_KEY.test(key) && text !== null) kept[key] = text;
  }
  return kept;
}

/**
 * The message for one claimed send (ADR-346): the kind's fixed template in the device's language, the same collapse id
 * on every attempt, high priority except promotions, the Android channel of the kind's topic (else `personal` or
 * `offers`), and ids only in `data` (`n` notification, `k` kind, `e` event, `r` reference ids). Null when the kind has
 * no template: it is never pushed.
 */
export function pushMessageOf(claim: ClaimedSend, texts?: PushTexts): PushMessage | null {
  const text = renderNotice(
    {
      kind: claim.kind,
      params: claim.params,
      terms: claim.terms,
      timezone: claim.timezone,
      language: claim.language,
    },
    texts,
  );
  if (!text.pushable) return null;
  return {
    token: claim.token,
    collapseId: `n${claim.notification_id}`,
    priority: claim.class === "promo" ? "normal" : "high",
    expiresAt: claim.expires_at,
    title: text.title,
    body: text.body,
    channel: claim.topic ?? (claim.class === "promo" ? "offers" : "personal"),
    threadId: claim.event_id ?? "questify",
    data: {
      n: claim.notification_id,
      k: claim.kind,
      e: claim.event_id ?? "",
      r: JSON.stringify(refIds(claim.refs)),
    },
  };
}

/** Whole seconds from `now` to the message's expiry, never below 0. */
export const secondsLeft = (message: PushMessage, now: Date): number =>
  Math.max(0, Math.ceil((message.expiresAt.getTime() - now.getTime()) / 1000));

/**
 * The APNs request for a message (T-501b sends it over HTTP/2): an alert push to the app's bundle id, priority 10 or 5,
 * the expiry as a Unix time, the collapse id; the body is `aps` and the ids under `q`.
 */
export function apnsRequest(
  message: PushMessage,
  topic: string,
): Readonly<{ headers: Readonly<Record<string, string>>; body: string }> {
  return {
    headers: {
      "apns-push-type": "alert",
      "apns-topic": topic,
      "apns-priority": message.priority === "high" ? "10" : "5",
      "apns-expiration": String(Math.floor(message.expiresAt.getTime() / 1000)),
      "apns-collapse-id": message.collapseId,
    },
    body: JSON.stringify({
      aps: {
        alert: { title: message.title, body: message.body },
        sound: "default",
        "thread-id": message.threadId,
      },
      q: message.data,
    }),
  };
}

/**
 * The FCM HTTP v1 request body for a message (T-501b posts it): a notification with the ids in `data`, the Android
 * priority, the time left as `ttl` and the collapse id as the notification's tag on the kind's channel.
 */
export function fcmRequest(message: PushMessage, now: Date): string {
  return JSON.stringify({
    message: {
      token: message.token,
      notification: { title: message.title, body: message.body },
      data: message.data,
      android: {
        priority: message.priority === "high" ? "HIGH" : "NORMAL",
        ttl: `${secondsLeft(message, now)}s`,
        notification: { tag: message.collapseId, channel_id: message.channel },
      },
    },
  });
}
