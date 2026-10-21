import type { LocalizedText } from "@questify/shared";

type Text = Readonly<{ ar: string | null; en: string | null }>;

/** An event as its join card shows it (`GET /v1/public/events/{joinCode}`, T-111). */
export type CardEvent = Readonly<{
  id: string;
  joinCode: string;
  name: Text;
  venue: Text;
  kind: string;
  timezone: string;
  startsAt: string;
  endsAt: string;
  statusNow: "scheduled" | "live" | "ended";
  access: "public" | "unlisted" | "private";
}>;

export type JoinCard = Readonly<{ title: LocalizedText; receives: readonly LocalizedText[] }>;

export type CardResult =
  | Readonly<{ kind: "found"; event: CardEvent; card: JoinCard }>
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "throttled" }>
  | Readonly<{ kind: "unavailable" }>;

const CODE = /^[A-Za-z0-9]{4,12}$/;
const STATUSES = new Set(["scheduled", "live", "ended"]);
const ACCESS = new Set(["public", "unlisted", "private"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isText = (value: unknown): value is Text =>
  isRecord(value) &&
  (value["ar"] === null || typeof value["ar"] === "string") &&
  (value["en"] === null || typeof value["en"] === "string");

const isLocalized = (value: unknown): value is LocalizedText =>
  isRecord(value) && typeof value["ar"] === "string" && typeof value["en"] === "string";

/** Checks the answer's shape, so a changed API shows the "couldn't load" state instead of a broken page. */
export function readCard(
  body: unknown,
): Readonly<{ event: CardEvent; card: JoinCard }> | undefined {
  if (!isRecord(body) || !isRecord(body["event"]) || !isRecord(body["card"])) {
    return undefined;
  }
  const event = body["event"];
  const card = body["card"];
  const strings = ["id", "joinCode", "kind", "timezone", "startsAt", "endsAt"] as const;
  if (
    strings.some((key) => typeof event[key] !== "string") ||
    !isText(event["name"]) ||
    !isText(event["venue"]) ||
    !STATUSES.has(String(event["statusNow"])) ||
    !ACCESS.has(String(event["access"])) ||
    !isLocalized(card["title"]) ||
    !Array.isArray(card["receives"]) ||
    !card["receives"].every(isLocalized)
  ) {
    return undefined;
  }
  return {
    event: event as unknown as CardEvent,
    card: { title: card["title"], receives: card["receives"] as LocalizedText[] },
  };
}

export type CardRequest = Readonly<{
  apiOrigin: string;
  code: string;
  /** The browser's chain as the edge sent it, so the API counts a wrong code against the visitor, not this server. */
  forwardedFor: string | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}>;

/** Reads one event's join card by its code. Server to server, never cached; a malformed code asks nothing. */
export async function fetchCard(request: CardRequest): Promise<CardResult> {
  if (!CODE.test(request.code)) {
    return { kind: "not_found" };
  }
  const headers = new Headers();
  if (request.forwardedFor !== null) {
    headers.set("x-forwarded-for", request.forwardedFor);
  }
  try {
    const response = await (request.fetchImpl ?? fetch)(
      `${request.apiOrigin}/v1/public/events/${encodeURIComponent(request.code)}`,
      { headers, cache: "no-store", signal: AbortSignal.timeout(request.timeoutMs ?? 5000) },
    );
    if (response.status === 404) {
      return { kind: "not_found" };
    }
    if (response.status === 429) {
      return { kind: "throttled" };
    }
    const read = response.ok ? readCard(await response.json().catch(() => undefined)) : undefined;
    return read === undefined ? { kind: "unavailable" } : { kind: "found", ...read };
  } catch {
    return { kind: "unavailable" };
  }
}

/** The Play link with the install referrer that opens this event's card after install (FR-113). */
export function playStoreLink(playStoreUrl: string, code: string): string {
  const url = new URL(playStoreUrl);
  url.searchParams.set("referrer", `join=${code.toUpperCase()}`);
  return url.toString();
}
