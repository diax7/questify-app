import {
  JOIN_CODE,
  PUSH_TOPICS,
  renderNotice,
  type Language,
  type NotificationItem,
  type NotificationList,
  type PushDeviceBody,
  type OwnPushTopics,
  type PushTopicsBody,
} from "@questify/shared";
import type { PoolClient } from "pg";
import { invalidPushDevice, invalidRequest, unauthenticated } from "#src/auth/http-errors";
import { refIds } from "#src/push/message";

/**
 * The calling player's side of push (T-501, migration 0076): this sign-in's device, the notification center and the
 * topic mutes. Every door binds the caller from the request context and checks an active player again; the device
 * doors also take the hash of the request's own access token, so a device is always this sign-in's.
 */

type PgError = Readonly<{ code?: string; detail?: string }>;

/** Turns the doors' SQLSTATEs into HTTP errors; anything else is a server fault and is rethrown. */
export function pushRefusal(error: unknown): never {
  const { code, detail } = error as PgError;
  if (code === "PN401") throw unauthenticated();
  if (
    code === "PN422" &&
    ["platform", "token", "environment", "language", "appVersion"].includes(detail ?? "")
  ) {
    throw invalidPushDevice({ field: detail });
  }
  if (code === "PN422") throw invalidRequest();
  throw error;
}

async function one<T>(client: PoolClient, sql: string, values: unknown[] = []): Promise<T> {
  try {
    const { rows } = await client.query<{ r: T }>(sql, values);
    return rows[0]?.r as T;
  } catch (error) {
    return pushRefusal(error);
  }
}

/** Registers this sign-in's device; `session` is the sha256 of the request's bearer token. */
export async function registerDevice(
  client: PoolClient,
  session: Buffer,
  body: PushDeviceBody,
): Promise<void> {
  await one(client, "SELECT push_device_register($1, $2, $3, $4, $5, $6) AS r", [
    session,
    body.platform,
    body.token,
    body.environment ?? null,
    body.language,
    body.appVersion,
  ]);
}

/** Removes this sign-in's device (before sign-out); nothing to remove is fine. */
export async function removeDevice(client: PoolClient, session: Buffer): Promise<void> {
  await one(client, "SELECT push_device_remove($1) AS r", [session]);
}

/** A center row as own_notifications answers it. */
type CenterRow = Readonly<{
  id: number;
  kind: string;
  class: "personal" | "event" | "promo";
  topic: NotificationItem["topic"];
  eventId: string | null;
  refs: unknown;
  params: unknown;
  createdAt: string;
  read: boolean;
  terms: unknown;
  timezone: string | null;
}>;

/**
 * An invitation's public event code from its frozen params (ADR-356 (6)), else null: only the invitation kind carries
 * one, and only a code shaped like `event.join_code` leaves the server.
 */
function joinCodeOf(row: Pick<CenterRow, "kind" | "params">): string | null {
  if (row.kind !== "invitation" || typeof row.params !== "object" || row.params === null)
    return null;
  const code = (row.params as Record<string, unknown>)["code"];
  return typeof code === "string" && JOIN_CODE.test(code) ? code : null;
}

/** One center row in the request's language: the same template the push used, or the generic text. */
export function centerItem(row: CenterRow, language: Language): NotificationItem {
  const text = renderNotice({
    kind: row.kind,
    params: row.params,
    terms: row.terms,
    timezone: row.timezone,
    language,
  });
  return {
    id: row.id,
    kind: row.kind,
    topic: row.topic,
    eventId: row.eventId,
    refs: refIds(row.refs),
    title: text.title,
    body: text.body,
    createdAt: new Date(row.createdAt).toISOString(),
    read: row.read,
    optOut: row.class === "promo",
    joinCode: joinCodeOf(row),
  };
}

/** The caller's unread center rows, counted up to 100. */
export const readUnread = async (client: PoolClient): Promise<number> =>
  (await one<number | null>(client, "SELECT own_unread_notifications() AS r")) ?? 0;

/** One page of the caller's center, newest first, with the next page's cursor and the unread count. */
export async function readCenter(
  client: PoolClient,
  query: Readonly<{ before: number | null; limit: number }>,
  language: Language,
): Promise<NotificationList> {
  const rows = await one<CenterRow[]>(client, "SELECT own_notifications($1, $2) AS r", [
    query.before,
    query.limit,
  ]);
  const items = rows.map((row) => centerItem(row, language));
  const last = items.at(-1);
  return {
    items,
    nextBefore: items.length === query.limit && last !== undefined ? last.id : null,
    unread: await readUnread(client),
  };
}

/** Marks the named rows (or all) of the caller's center read; answers the unread count after. */
export async function markRead(client: PoolClient, ids: readonly number[] | null): Promise<number> {
  return one<number>(client, "SELECT mark_notifications_read($1::bigint[]) AS r", [
    ids === null ? null : [...ids],
  ]);
}

/** The caller's four topics, true when on, and the ones an event they joined started off (T-510). */
export const readTopics = (client: PoolClient): Promise<OwnPushTopics> =>
  one<OwnPushTopics>(client, "SELECT own_push_topics() AS r");

/** The topics of a body that are set to `wanted`. */
export const topicsSetTo = (body: PushTopicsBody, wanted: boolean): string[] =>
  PUSH_TOPICS.filter((topic) => body[topic] === wanted);

/**
 * Changes the topics named and keeps the others; answers all four. A topic set here is the player's own choice from now
 * on, so an event's default never overrules it (T-510).
 */
export const setTopics = (client: PoolClient, body: PushTopicsBody): Promise<OwnPushTopics> =>
  one<OwnPushTopics>(client, "SELECT set_push_topics($1::text[], $2::text[]) AS r", [
    topicsSetTo(body, true),
    topicsSetTo(body, false),
  ]);
