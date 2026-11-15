import type { ObjectStore } from "#src/storage/client";

/** How long a signed photo read lasts (plan section 3.4): the team's queue fetches a new one after it. */
export const PHOTO_URL_SECONDS = 300;

export type SignedPhoto = Readonly<{ photoUrl: string | null; photoExpiresAt: Date | null }>;

const NO_PHOTO: SignedPhoto = { photoUrl: null, photoExpiresAt: null };

/**
 * A short read of one photo, for a key a seat-checked reader returned (never one a client sent). Null without a key or
 * a media store. Signing is pure computation (ADR-840), so it calls nothing outside.
 */
export function signedPhoto(storage: ObjectStore | undefined, key: string | null): SignedPhoto {
  if (storage === undefined || key === null) return NO_PHOTO;
  const signed = storage.signGet(key, PHOTO_URL_SECONDS);
  return { photoUrl: signed.url, photoExpiresAt: signed.expiresAt };
}

/** How long a photo wall URL lasts (plan section 7, M2): the screen reads its scene every 3 seconds. */
export const WALL_URL_SECONDS = 120;
const MINUTE_MS = 60_000;

/**
 * A wall photo's read, signed from the start of the current minute, so every read within one minute answers the same URL
 * (the screen and the app keep a loaded picture; plan section 7, M2). It lasts 60 to 120 seconds from now. Null without
 * a media store: the caller leaves that photo out.
 */
export function stableWallUrl(
  storage: ObjectStore | undefined,
  key: string,
  now: () => number = Date.now,
): Readonly<{ url: string; expiresAt: Date }> | null {
  if (storage === undefined) return null;
  const at = new Date(Math.floor(now() / MINUTE_MS) * MINUTE_MS);
  return storage.signGet(key, WALL_URL_SECONDS, at);
}
