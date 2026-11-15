import type { Session } from "#src/api/session.ts";
import { randomUuid } from "#src/api/uuid.ts";

/** One photo of the event's wall (T-504b): a short signed read, and its owner's username for Block (never a full name). */
export type WallPhoto = Readonly<{
  mediaId: string;
  url: string;
  username: string | null;
  /** When the link stops working (ISO time); absent in an older API's answer. */
  expiresAt?: string;
}>;

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
      ...(typeof one["expiresAt"] === "string" ? { expiresAt: one["expiresAt"] } : {}),
    }));
}

/** A kept link must last at least this much longer, or the newest one is taken. */
const KEEP_MARGIN_MS = 15_000;

/**
 * The wall read again (T-814, plan review 86 MINOR 7): a photo that was shown keeps the link it loaded with while that
 * link still has time left, so a newly signed link does not load the picture again; anything else is the new answer.
 */
export function keptWall(before: WallRead | undefined, next: WallRead, nowMs: number): WallRead {
  if (before?.kind !== "photos" || next.kind !== "photos") return next;
  const kept = new Map(
    before.photos
      .filter(
        (one) => one.expiresAt !== undefined && Date.parse(one.expiresAt) - nowMs > KEEP_MARGIN_MS,
      )
      .map((one) => [one.mediaId, one]),
  );
  return {
    kind: "photos",
    photos: next.photos.map((one) => {
      const old = kept.get(one.mediaId);
      return old === undefined ? one : { ...old, username: one.username };
    }),
  };
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
