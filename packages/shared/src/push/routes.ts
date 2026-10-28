import { REF_VALUE } from "#src/push/push";

/**
 * Where a tap on a push or a center row goes (ADR-349 (4), T-501c). The server never sends a link: a payload carries
 * ids only, and the app maps the kind and those ids to its own screens through this fixed table, so a payload can never
 * open an arbitrary address. A kind the table does not know (an older app meeting a newer kind), a promotional kind
 * and every id that does not check out open the center row.
 */

type Target = "center" | "event" | "quests" | "rewards" | "ranking" | "info" | "home" | "requests";

/**
 * The kind of every owed push (the plan's table in `docs/plans/2026-10-28-t-501-push.md`) and where it opens. T-501d to
 * T-501g add their `notice_kind` rows and templates; a test requires every kind with a template to appear here, so a
 * slice that adds a kind adds its route (or `center`) in the same change.
 */
export const NOTIFICATION_TARGETS: ReadonlyMap<string, Target> = new Map<string, Target>([
  ["join_accepted", "event"],
  ["join_declined", "center"],
  ["help_answered", "requests"],
  ["rank_prize", "rewards"],
  ["submission_approved", "quests"],
  ["submission_rejected", "quests"],
  ["reward_ready", "rewards"],
  ["reward_ending", "rewards"],
  ["flash_quest", "quests"],
  ["boost_start", "quests"],
  ["poll_sent", "event"],
  ["community_step", "quests"],
  ["category_open", "quests"],
  ["event_soon", "event"],
  ["streak_reminder", "home"],
  ["shop_closing", "rewards"],
  ["invitation", "center"],
  ["hint", "quests"],
  ["announcement", "event"],
  ["rank_top_ten", "ranking"],
  ["session_reminder", "info"],
  ["operator_invite", "center"],
]);

const EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Whether the text is an event id (a UUID), the only thing a route is ever built from besides a numeric id. */
export const isEventId = (value: unknown): value is string =>
  typeof value === "string" && EVENT_ID.test(value);

export type NotificationRoute =
  | Readonly<{ kind: "route"; href: string }>
  | Readonly<{ kind: "center" }>;

const CENTER: NotificationRoute = { kind: "center" };

/** The route inside one event; `quest` (a quest id) opens that quest's sheet on the quests tab. */
function eventRoute(
  target: Exclude<Target, "center" | "home" | "requests">,
  eventId: string,
  refs: Readonly<Record<string, string>>,
): string {
  const base = `/event/${eventId}`;
  if (target === "event") return base;
  if (target !== "quests") return `${base}/${target}`;
  const quest = refs["quest"];
  return quest !== undefined && REF_VALUE.test(quest)
    ? `${base}/quests?quest=${quest}`
    : `${base}/quests`;
}

/**
 * The app route for a notification, or `center`. `eventId` is the notification's event (null for none), `refs` its
 * reference ids; both are checked here, so only an event UUID and a quest id are ever put in a route.
 */
export function notificationRoute(
  kind: string,
  eventId: string | null,
  refs: Readonly<Record<string, string>>,
): NotificationRoute {
  const target = NOTIFICATION_TARGETS.get(kind);
  if (target === undefined || target === "center") return CENTER;
  if (target === "home") return { kind: "route", href: "/home" };
  if (target === "requests") return { kind: "route", href: "/requests" };
  if (!isEventId(eventId)) return CENTER;
  return { kind: "route", href: eventRoute(target, eventId, refs) };
}
