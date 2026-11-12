import { eventImagePath } from "@questify/shared";
import type { AuthedResult } from "#src/api/session.ts";

/** How long before its end a signed URL is read again: an image that starts loading keeps a working link. */
const MARGIN_MS = 30_000;
const MOST_KEPT = 200;

export type SignedImage = Readonly<{ url: string; expiresAt: number }>;

type Request = (request: Readonly<{ method: "GET"; path: string }>) => Promise<AuthedResult>;

const answerOf = (result: AuthedResult): SignedImage | null => {
  if (result.kind !== "ok") return null;
  const body = result.body as { url?: unknown; expiresAt?: unknown } | undefined;
  const expiresAt = typeof body?.expiresAt === "string" ? Date.parse(body.expiresAt) : Number.NaN;
  return typeof body?.url === "string" &&
    body.url.startsWith("https://") &&
    !Number.isNaN(expiresAt)
    ? { url: body.url, expiresAt }
    : null;
};

/**
 * The signed URLs of organizer images (ADR-829), one read per image while its URL lasts: the app asks the event's image
 * door for JSON (never following a redirect with its token) and draws the bucket's URL itself. A refusal, no bucket or
 * no network gives null, and the caller draws Questify's own art.
 */
export function createImageUrls(request: Request, now: () => number = Date.now) {
  const kept = new Map<string, SignedImage>();
  const pending = new Map<string, Promise<SignedImage | null>>();
  const fresh = (key: string): SignedImage | undefined => {
    const found = kept.get(key);
    return found !== undefined && found.expiresAt - MARGIN_MS > now() ? found : undefined;
  };
  return {
    /** A URL still good now, without asking: what a screen draws at once on a second visit. */
    known: (eventId: string, imageId: string): SignedImage | undefined =>
      fresh(`${eventId}/${imageId}`),
    read: (eventId: string, imageId: string): Promise<SignedImage | null> => {
      const key = `${eventId}/${imageId}`;
      const found = fresh(key);
      if (found !== undefined) return Promise.resolve(found);
      const waiting = pending.get(key);
      if (waiting !== undefined) return waiting;
      const asked = request({ method: "GET", path: eventImagePath(eventId, imageId) })
        .then(answerOf, () => null)
        .then((answer) => {
          pending.delete(key);
          if (answer !== null) {
            if (kept.size >= MOST_KEPT) kept.clear();
            kept.set(key, answer);
          }
          return answer;
        });
      pending.set(key, asked);
      return asked;
    },
  };
}

export type ImageUrls = ReturnType<typeof createImageUrls>;
