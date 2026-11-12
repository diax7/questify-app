/** An export file is written while its rows are read, so a very large event takes longer than a page does (T-608). */
const EXPORT_PATH = /^\/v1\/organizers\/[^/]+\/events\/[^/]+\/exports\/[a-z]+$/u;
/** Applying a change set claims it for 5 minutes in the API, so the forwarder waits as long. */
const APPLY_PATH = /^\/v1\/organizers\/[^/]+\/events\/[^/]+\/change-sets\/[^/]+\/apply$/u;

/**
 * A player's photo upload (T-301b), or an organizer image upload (ADR-829): up to 8 MB on a venue's network, then a
 * re-encode and a PUT to the bucket.
 */
const PHOTO_PATH =
  /^\/v1\/(?:quests\/[^/]+\/photo|events\/[^/]+\/tickets\/photo|organizers\/[^/]+\/events\/[^/]+\/images)$/u;

export const EXPORT_TIMEOUT_MS = 180_000;
export const APPLY_TIMEOUT_MS = 300_000;
export const PHOTO_TIMEOUT_MS = 90_000;
export const DEFAULT_TIMEOUT_MS = 15_000;
/** The API's own photo limit; every other body stays under 1 MiB. */
export const PHOTO_BODY_BYTES = 8 * 1024 * 1024;
export const DEFAULT_BODY_BYTES = 1_048_576;

/** How long the forwarder waits for the API on this path. */
export function forwardTimeoutMs(pathname: string): number {
  if (EXPORT_PATH.test(pathname)) {
    return EXPORT_TIMEOUT_MS;
  }
  if (PHOTO_PATH.test(pathname)) {
    return PHOTO_TIMEOUT_MS;
  }
  return APPLY_PATH.test(pathname) ? APPLY_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
}

/** The largest body the forwarder reads for this path: a photo upload's 8 MB, else 1 MiB. */
export const forwardBodyBytes = (pathname: string): number =>
  PHOTO_PATH.test(pathname) ? PHOTO_BODY_BYTES : DEFAULT_BODY_BYTES;
