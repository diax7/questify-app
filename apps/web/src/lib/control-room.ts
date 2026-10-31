import type { MessageKey } from "@questify/shared";
import type { Bilingual } from "#src/lib/quests.ts";

/** How often the control room asks for its numbers and feed (ADR-365's polling, no stream). */
export const CONTROL_REFRESH_MS = 5000;

/** One completion on the feed (T-603): who, which quest, how, when. No contact detail, no points. */
export type FeedItem = Readonly<{
  id: string;
  at: string;
  questId: string;
  title: Bilingual;
  method: string;
  username: string;
  avatar: string;
}>;

/** The counters of FR-1028. */
export type ControlCounts = Readonly<{
  players: number;
  online: number;
  lowStock: number;
  inbox: number;
  flags: number;
}>;

/** One answer of `GET …/events/{id}/control`. */
export type ControlView = Readonly<{
  counts: ControlCounts;
  feed: readonly FeedItem[];
  /** Players who completed each quest at least once, by quest id; a quest nobody completed has no key. */
  done: Readonly<Record<string, number>>;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isText = (value: unknown): value is Bilingual =>
  isRecord(value) &&
  (value["ar"] === null || typeof value["ar"] === "string") &&
  (value["en"] === null || typeof value["en"] === "string");

const isFeedItem = (value: unknown): value is FeedItem =>
  isRecord(value) &&
  typeof value["id"] === "string" &&
  typeof value["at"] === "string" &&
  typeof value["questId"] === "string" &&
  isText(value["title"]) &&
  typeof value["method"] === "string" &&
  typeof value["username"] === "string" &&
  typeof value["avatar"] === "string";

const COUNT_KEYS = ["players", "online", "lowStock", "inbox", "flags"] as const;

function countsOf(value: unknown): ControlCounts | undefined {
  if (!isRecord(value) || !COUNT_KEYS.every((key) => typeof value[key] === "number")) {
    return undefined;
  }
  return {
    players: value["players"] as number,
    online: value["online"] as number,
    lowStock: value["lowStock"] as number,
    inbox: value["inbox"] as number,
    flags: value["flags"] as number,
  };
}

/** The room's answer, or undefined when the body is not that shape. */
export function controlViewOf(body: unknown): ControlView | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  const counts = countsOf(body["counts"]);
  const feed = body["feed"];
  const done = body["done"];
  if (
    counts === undefined ||
    !Array.isArray(feed) ||
    !feed.every(isFeedItem) ||
    !isRecord(done) ||
    !Object.values(done).every((count) => typeof count === "number")
  ) {
    return undefined;
  }
  return { counts, feed, done: done as Readonly<Record<string, number>> };
}

/**
 * A quest's completion rate as a whole percent of the event's active players, 0 when nobody has joined and never over
 * 100 (a member removed after completing still counts as a completion).
 */
export function completionRate(done: number | undefined, players: number): number {
  if (players <= 0 || done === undefined || done <= 0) {
    return 0;
  }
  return Math.min(100, Math.round((done / players) * 100));
}

const METHOD_LABELS: Readonly<Record<string, MessageKey>> = {
  qr: "control.method.qr",
  code: "control.method.code",
  my_qr: "control.method.operator",
  nfc: "control.method.nfc",
  screen_qr: "control.method.screen",
  kiosk: "control.method.kiosk",
  manual: "control.method.manual",
};

/** How a completion happened, in words: a scan or a typed code at a station, a staff award, else an action in the app. */
export const methodLabelOf = (method: string): MessageKey =>
  METHOD_LABELS[method] ?? "control.method.app";

/** What the room needs to know about the event it controls: its clock, whether it is over, and its two switches. */
export type RoomEvent = Readonly<{
  timeZone: string;
  /** Ended or archived: the numbers stay, the buttons go. */
  closed: boolean;
  flashOn: boolean;
  boostsOn: boolean;
}>;

/** The event as the room reads it; before it has loaded, the Riyadh clock and every switch on. */
export function roomEventOf(
  event: Readonly<{
    timezone: string;
    statusNow: string;
    flashQuests: boolean;
    boosts: boolean;
  }> | null,
): RoomEvent {
  return {
    timeZone: event?.timezone ?? "Asia/Riyadh",
    closed: event?.statusNow === "ended" || event?.statusNow === "archived",
    flashOn: event?.flashQuests !== false,
    boostsOn: event?.boosts !== false,
  };
}
