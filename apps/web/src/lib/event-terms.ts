import { DEFAULT_TERMS, readEventTerms, type EventTerms } from "@questify/shared";
import { SESSION_COOKIE, readSuspension, type Suspension } from "#src/lib/staff-api.ts";

export type EventTermsRequest = Readonly<{
  apiOrigin: string;
  organizerId: string;
  eventId: string;
  sessionToken: string | undefined;
  /** The browser's chain as the edge sent it, so the API sees the real client here too. */
  forwardedFor: string | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}>;

/**
 * The event's own words for the dashboard's event pages (FR-942). Server to server with the staff session; anything
 * but a good answer (signed out, not a member, API down, slow) gives Questify's own words, since each page shows its
 * own refusal and a word is never worth blocking the page for.
 */
export async function fetchEventTerms(request: EventTermsRequest): Promise<EventTerms> {
  return (await fetchEventFrame(request)).terms;
}

/** What the event's frame shows: its words, and Questify's suspension of it with the reason (T-701, Q-372). */
export type EventFrame = Readonly<{ terms: EventTerms; suspension: Suspension | null }>;

const PLAIN_FRAME: EventFrame = { terms: DEFAULT_TERMS, suspension: null };

function frameOf(body: unknown): EventFrame {
  const event = (body as { event?: { terms?: unknown; suspension?: unknown } } | undefined)?.event;
  return { terms: readEventTerms(event?.terms), suspension: readSuspension(event?.suspension) };
}

/** The event's words and suspension in one read, falling back to the defaults and no banner as above. */
export async function fetchEventFrame(request: EventTermsRequest): Promise<EventFrame> {
  if (request.sessionToken === undefined || request.sessionToken === "") {
    return PLAIN_FRAME;
  }
  const headers = new Headers({ cookie: `${SESSION_COOKIE}=${request.sessionToken}` });
  if (request.forwardedFor !== null) {
    headers.set("x-forwarded-for", request.forwardedFor);
  }
  const path = `/v1/organizers/${encodeURIComponent(request.organizerId)}/events/${encodeURIComponent(request.eventId)}`;
  try {
    const response = await (request.fetchImpl ?? fetch)(`${request.apiOrigin}${path}`, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(request.timeoutMs ?? 5_000),
    });
    if (!response.ok) {
      // oxlint-disable-next-line no-console -- server log: the only trace of a page that fell back to the default words
      console.warn(`event words not read: event ${request.eventId} answered ${response.status}`);
      return PLAIN_FRAME;
    }
    return frameOf(await response.json().catch(() => undefined));
  } catch {
    // oxlint-disable-next-line no-console -- server log, as above
    console.warn(`event words not read: event ${request.eventId} could not be reached`);
    return PLAIN_FRAME;
  }
}
