/** The phone's plain key-value storage (AsyncStorage in the app, a map in tests). */
export type KeyValueStore = Readonly<{
  getItem: (key: string) => Promise<string | null>;
  setItem: (key: string, value: string) => Promise<void>;
}>;

/** An event of the player's, as `GET /v1/me/events` lists it (T-111), newest join first. */
export type MyEvent = Readonly<{
  id: string;
  joinCode: string;
  name: Readonly<{ ar: string | null; en: string | null }>;
  statusNow: string;
  status: "active" | "pending";
  /** The event's IANA zone, for its times. */
  timezone?: string;
}>;

/** When each event was last opened on this phone (FR-1610): one map, cleared at every sign-out. */
export const RECENT_KEY = "questify.recentEvents";

export type Recent = Readonly<Record<string, number>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The stored map, or an empty one for anything unreadable: a broken entry must never block the launch. */
export function parseRecent(stored: string | null): Recent {
  try {
    const value: unknown = JSON.parse(stored ?? "{}");
    return isRecord(value)
      ? Object.fromEntries(
          Object.entries(value).filter(
            (entry): entry is [string, number] =>
              typeof entry[1] === "number" && Number.isFinite(entry[1]),
          ),
        )
      : {};
  } catch {
    return {};
  }
}

export async function readRecent(store: KeyValueStore): Promise<Recent> {
  return parseRecent(await store.getItem(RECENT_KEY).catch(() => null));
}

/** Notes that the player opened this event now; a failed write only loses the ordering. */
export async function markOpened(
  store: KeyValueStore,
  eventId: string,
  now: number,
): Promise<void> {
  const recent = await readRecent(store);
  await store
    .setItem(RECENT_KEY, JSON.stringify({ ...recent, [eventId]: now }))
    .catch(() => undefined);
}

/** Forgets an event the server says is no longer the player's (403 or 404), so the launch stops choosing it. */
export async function forget(store: KeyValueStore, eventId: string): Promise<void> {
  const { [eventId]: _gone, ...rest } = await readRecent(store);
  await store.setItem(RECENT_KEY, JSON.stringify(rest)).catch(() => undefined);
}

/**
 * Where the app opens (FR-624, FR-1610): the player's active event that is live now and was opened most recently on
 * this phone; one never opened here comes after those, in the list's order (newest join first). None live: null, and
 * the app opens on Questify home.
 */
export function chooseLaunchEvent(events: readonly MyEvent[], recent: Recent): string | null {
  const live = events.filter((event) => event.status === "active" && event.statusNow === "live");
  const ranked = live
    .map((event, order) => ({ id: event.id, order, at: recent[event.id] ?? -1 }))
    .toSorted((a, b) => b.at - a.at || a.order - b.order);
  return ranked[0]?.id ?? null;
}

/** The list's events, checked one by one: an entry of another shape is left out rather than breaking the screen. */
export function readMyEvents(body: unknown): MyEvent[] | undefined {
  if (!isRecord(body) || !Array.isArray(body["events"])) {
    return undefined;
  }
  return body["events"].filter(
    (item): item is MyEvent =>
      isRecord(item) &&
      typeof item["id"] === "string" &&
      typeof item["joinCode"] === "string" &&
      typeof item["statusNow"] === "string" &&
      (item["status"] === "active" || item["status"] === "pending") &&
      (item["timezone"] === undefined || typeof item["timezone"] === "string") &&
      isRecord(item["name"]),
  );
}
