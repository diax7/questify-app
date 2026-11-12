import type { ObjectStore } from "#src/storage/client";

/** How long a signed photo read lasts (plan section 3.4): the team's queue fetches a new one after it. */
export const PHOTO_URL_SECONDS = 300;

export type SignedPhoto = Readonly<{ photoUrl: string | null; photoExpiresAt: Date | null }>;

const NO_PHOTO: SignedPhoto = { photoUrl: null, photoExpiresAt: null };

/**
 * A short read of one photo, for a key a seat-checked reader returned (never one a client sent). Null without a key or
 * a bucket; a signing failure leaves the row without a URL rather than failing the whole read.
 */
export async function signedPhoto(
  storage: ObjectStore | undefined,
  key: string | null,
): Promise<SignedPhoto> {
  if (storage === undefined || key === null) return NO_PHOTO;
  try {
    const signed = await storage.signGet(key, PHOTO_URL_SECONDS);
    return { photoUrl: signed.url, photoExpiresAt: signed.expiresAt };
  } catch {
    return NO_PHOTO;
  }
}

/** How long a photo wall URL lasts (plan section 7, M2): the screen reads its scene every 3 seconds. */
export const WALL_URL_SECONDS = 120;
const MINUTE_MS = 60_000;

/**
 * A wall photo's read, signed from the start of the current minute, so every read within one minute answers the same URL
 * (the screen and the app keep a loaded picture; plan section 7, M2). It lasts 60 to 120 seconds from now. Null without
 * a bucket or when signing fails: the caller leaves that photo out.
 */
export async function stableWallUrl(
  storage: ObjectStore | undefined,
  key: string,
  now: () => number = Date.now,
): Promise<Readonly<{ url: string; expiresAt: Date }> | null> {
  if (storage === undefined) return null;
  try {
    const at = new Date(Math.floor(now() / MINUTE_MS) * MINUTE_MS);
    return await storage.signGet(key, WALL_URL_SECONDS, "image/jpeg", at);
  } catch {
    return null;
  }
}
