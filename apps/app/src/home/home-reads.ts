import type { Session } from "#src/api/session.ts";
import { readMyEvents, readRecent, type KeyValueStore, type MyEvent } from "#src/event/launch.ts";
import { fetchInvitations, type Invitation } from "#src/join/join-api.ts";

export type MyEventsRead = Readonly<{
  events: readonly MyEvent[];
  /** The event opened most recently on this phone, if any. */
  latest: string | undefined;
}>;

/**
 * The player's events and the one opened last on this phone (`GET /v1/me/events`), or null when the read fails: a
 * failed read is never an empty list.
 */
export async function loadMyEvents(
  session: Pick<Session, "request">,
  store: KeyValueStore,
): Promise<MyEventsRead | null> {
  // The phone's own note of what was opened last does not wait for the server's answer.
  const [answer, recent] = await Promise.all([
    session.request({ method: "GET", path: "/v1/me/events" }),
    readRecent(store),
  ]);
  const events = answer.kind === "ok" ? readMyEvents(answer.body) : undefined;
  if (events === undefined) {
    return null;
  }
  return { events, latest: Object.entries(recent).sort((a, b) => b[1] - a[1])[0]?.[0] };
}

/** The player's invitations (FR-133), or null when they cannot be read (Home then shows none). */
export async function loadInvitations(
  session: Pick<Session, "request">,
): Promise<readonly Invitation[] | null> {
  const answer = await fetchInvitations(session);
  return answer.kind === "list" ? answer.invitations : null;
}
