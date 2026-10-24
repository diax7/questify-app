import { DEFAULT_TERMS, readEventTerms, type EventTerms } from "@questify/shared";
import { SESSION_COOKIE } from "#src/lib/staff-api.ts";

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
  if (request.sessionToken === undefined || request.sessionToken === "") {
    return DEFAULT_TERMS;
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
      return DEFAULT_TERMS;
    }
    const body: unknown = await response.json().catch(() => undefined);
    const event = (body as { event?: { terms?: unknown } } | undefined)?.event;
    return readEventTerms(event?.terms);
  } catch {
    // oxlint-disable-next-line no-console -- server log, as above
    console.warn(`event words not read: event ${request.eventId} could not be reached`);
    return DEFAULT_TERMS;
  }
}
