import type { Session } from "#src/api/session.ts";
import { randomUuid } from "#src/api/uuid.ts";

/** One photo of the event's wall (T-504b): a short signed read, and its owner's username for Block (never a full name). */
export type WallPhoto = Readonly<{ mediaId: string; url: string; username: string | null }>;

export type WallRead =
  | Readonly<{ kind: "photos"; photos: readonly WallPhoto[] }>
  /** The wall is not running now (the scene is not picked, the screen is shut): 404. */
  | Readonly<{ kind: "off" }>
  | Readonly<{ kind: "failed" }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** The photos in an answer: only those with an id and an https URL; anything else is left out. */
export function wallPhotosOf(body: unknown): readonly WallPhoto[] | undefined {
  if (!isRecord(body) || !Array.isArray(body["photos"])) return undefined;
  return body["photos"]
    .filter(
      (one): one is Record<string, unknown> =>
        isRecord(one) &&
        typeof one["mediaId"] === "string" &&
        typeof one["url"] === "string" &&
        one["url"].startsWith("https://"),
    )
    .map((one) => ({
      mediaId: one["mediaId"] as string,
      url: one["url"] as string,
      username: typeof one["username"] === "string" ? one["username"] : null,
    }));
}

/** The event's photo wall now. */
export async function fetchPhotoWall(
  session: Pick<Session, "request">,
  eventId: string,
): Promise<WallRead> {
  const answer = await session.request({
    method: "GET",
    path: `/v1/events/${encodeURIComponent(eventId)}/photo-wall`,
  });
  if (answer.kind === "error" && answer.status === 404) return { kind: "off" };
  const photos = answer.kind === "ok" ? wallPhotosOf(answer.body) : undefined;
  return photos === undefined ? { kind: "failed" } : { kind: "photos", photos };
}

/** Allows or withdraws one of the player's own photos on screen (M6); true when the server saved it. */
export async function saveOnScreen(
  session: Pick<Session, "request">,
  eventId: string,
  submissionId: string,
  onScreen: boolean,
): Promise<boolean> {
  const answer = await session.request({
    method: "PUT",
    path: `/v1/events/${encodeURIComponent(eventId)}/submissions/${encodeURIComponent(submissionId)}/on-screen`,
    body: { onScreen },
    headers: { "idempotency-key": randomUuid() },
  });
  return answer.kind === "ok";
}
