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
