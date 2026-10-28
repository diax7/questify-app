import { REF_KEY, REF_VALUE, isEventId, notificationRoute } from "@questify/shared";

/**
 * What a tap on a push carries (ADR-346, ADR-349): the server sends `{n, k, e, r}` (notification id, kind, event id,
 * reference ids as JSON text) and nothing else, never a link. The app trusts none of it: the kind and every id are
 * checked here before `notificationRoute` maps them to a screen of the app's own.
 *
 * Where `expo-notifications` puts those fields depends on the platform and the sender. A direct APNs push keeps the
 * whole payload in `trigger.payload` (`content.data` is only the `body` key of an Expo-service push, so it is empty
 * here) and the fields sit under `q`. An FCM push has them flat in `content.data` and in `trigger.remoteMessage.data`.
 * The reader looks in all three; the RUNBOOK's go-live checklist (line 6) confirms the placement on real phones.
 */
export type Tap = Readonly<{
  notificationId: number | null;
  kind: string;
  eventId: string | null;
  refs: Readonly<Record<string, string>>;
}>;

/** The action id `expo-notifications` reports for the tap on the notification itself. */
const DEFAULT_ACTION = "expo.modules.notifications.actions.DEFAULT";
const KIND = /^[a-z][a-z_]{0,39}$/;
const ROW_ID = /^[1-9][0-9]{0,14}$/;

type Fields = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A value that is an object, or JSON text holding one (FCM data is text only); else null. */
function recordOf(value: unknown): Fields | null {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function notificationIdOf(value: unknown): number | null {
  const text = typeof value === "number" ? String(value) : value;
  return typeof text === "string" && ROW_ID.test(text) && Number.isSafeInteger(Number(text))
    ? Number(text)
    : null;
}

/** Reference ids only: a name and a UUID or a whole number; anything else is dropped. */
function refsOf(value: unknown): Readonly<Record<string, string>> {
  const refs: Record<string, string> = {};
  for (const [key, raw] of Object.entries(recordOf(value) ?? {})) {
    const text = typeof raw === "number" ? String(raw) : raw;
    if (REF_KEY.test(key) && typeof text === "string" && REF_VALUE.test(text)) refs[key] = text;
  }
  return refs;
}

/** The tap in one place's fields (`q` inside them, else the fields themselves), or null without a valid kind. */
function tapIn(source: unknown): Tap | null {
  const outer = recordOf(source);
  if (outer === null) return null;
  const fields = recordOf(outer["q"]) ?? outer;
  const kind = fields["k"];
  if (typeof kind !== "string" || !KIND.test(kind)) return null;
  const eventId = fields["e"];
  return {
    notificationId: notificationIdOf(fields["n"]),
    kind,
    eventId: isEventId(eventId) ? eventId : null,
    refs: refsOf(fields["r"]),
  };
}

/** The value at a path of object keys, or undefined as soon as the path leaves an object. */
function at(value: unknown, ...path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

const REQUEST = ["notification", "request"] as const;

/** The tap a notification response holds, or null for anything else (another app's push, a dismissal, odd data). */
export function tapOf(response: unknown): Tap | null {
  const action = at(response, "actionIdentifier");
  if (typeof action === "string" && action !== DEFAULT_ACTION) return null;
  const places = [
    at(response, ...REQUEST, "trigger", "payload"),
    at(response, ...REQUEST, "trigger", "remoteMessage", "data"),
    at(response, ...REQUEST, "content", "data"),
  ];
  for (const place of places) {
    const tap = tapIn(place);
    if (tap !== null) return tap;
  }
  return null;
}

/** A stable id for a response, so the same tap (kept as the "last response") is never acted on twice. */
export function responseKey(response: unknown): string | null {
  const identifier = at(response, ...REQUEST, "identifier");
  const date = at(response, "notification", "date");
  return typeof identifier === "string" ? `${identifier}@${String(date ?? "")}` : null;
}

/** What opening a tap needs from the app: the router and the read call (injected, so the choice runs in tests). */
export type TapIo = Readonly<{
  open: (href: string) => void;
  openCenter: (row: number | null) => void;
  markRead: (id: number) => void;
}>;

/**
 * Acts on a tap: the row is marked read, then the screen the kind's fixed route names opens; a promotion, an unknown
 * kind or an id that does not check out opens the center, on that row.
 */
export function openTap(tap: Tap, io: TapIo): void {
  if (tap.notificationId !== null) io.markRead(tap.notificationId);
  const route = notificationRoute(tap.kind, tap.eventId, tap.refs);
  if (route.kind === "route") io.open(route.href);
  else io.openCenter(tap.notificationId);
}

/** Where the app is for a tap that wants to open a screen: the player's state and the path on screen. */
export type TapPlace = Readonly<{
  status: "loading" | "signed_in" | "signed_out";
  pathname: string;
}>;

/** The launch screen's path. It decides where the app opens and then replaces itself (`app/index.tsx`). */
export const LAUNCH_PATH = "/";

/**
 * What to do with a tap now: open it, hold it, or drop it. A tap opens only for a signed-in player and only once the
 * launch screen has left: its own `router.replace` would otherwise land on the tap's screen and cancel it (a cold start
 * is the common case). A tap held while the player signs out is dropped, so it never opens for the next account. A
 * newer tap replaces one still held.
 *
 * @param waiting The tap held so far.
 * @param place Where the app is now.
 * @param arrived A tap that has just arrived, if any.
 */
export function settleTap(
  waiting: Tap | null,
  place: TapPlace,
  arrived: Tap | null = null,
): Readonly<{ open: Tap | null; waiting: Tap | null }> {
  if (place.status === "signed_out") return { open: null, waiting: null };
  const tap = arrived ?? waiting;
  if (tap === null) return { open: null, waiting: null };
  if (place.status === "signed_in" && place.pathname !== LAUNCH_PATH) {
    return { open: tap, waiting: null };
  }
  return { open: null, waiting: tap };
}
