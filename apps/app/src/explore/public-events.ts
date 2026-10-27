import type { ApiRequest, ApiResult } from "#src/api/client.ts";
import type { ListedEvent } from "#src/home/EventRow.tsx";

const isText = (value: unknown): value is ListedEvent["name"] =>
  typeof value === "object" && value !== null && "ar" in value && "en" in value;

/** The listed events that have the fields a row needs; an entry of another shape is left out. */
export const listedEvents = (value: unknown): ListedEvent[] =>
  Array.isArray(value)
    ? value.filter(
        (item): item is ListedEvent =>
          typeof item === "object" &&
          item !== null &&
          typeof (item as ListedEvent).id === "string" &&
          typeof (item as ListedEvent).joinCode === "string" &&
          isText((item as ListedEvent).name),
      )
    : [];

export type PublicPage =
  | Readonly<{ kind: "page"; events: ListedEvent[]; next: string | null }>
  | Readonly<{ kind: "failed" }>;

/**
 * One page of `GET /v1/public/events` (FR-104). The cursor is opaque (API.md): sent back as it came; a stale one
 * starts again from the first page. A failed read is not an empty list.
 */
export async function fetchPublicPage(
  client: Readonly<{ request: (request: ApiRequest) => Promise<ApiResult> }>,
  cursor: string | null,
): Promise<PublicPage> {
  const path =
    cursor === null
      ? "/v1/public/events"
      : `/v1/public/events?cursor=${encodeURIComponent(cursor)}`;
  const answer = await client.request({ method: "GET", path });
  if (answer.kind !== "ok" || typeof answer.body !== "object" || answer.body === null) {
    return { kind: "failed" };
  }
  const body = answer.body as { events?: unknown; nextCursor?: unknown };
  return {
    kind: "page",
    events: listedEvents(body.events),
    next: typeof body.nextCursor === "string" && body.nextCursor !== "" ? body.nextCursor : null,
  };
}

/**
 * The cursor Retry asks for: the first page when nothing has loaded yet, else the page that failed (the cursor the last
 * good page ended with), so a failed later page never restarts the list or skips a page.
 */
export const retryCursor = (loaded: readonly ListedEvent[] | undefined, next: string | null) =>
  loaded === undefined ? null : next;
