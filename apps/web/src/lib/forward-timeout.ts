/** An export file is written while its rows are read, so a very large event takes longer than a page does (T-608). */
const EXPORT_PATH = /^\/v1\/organizers\/[^/]+\/events\/[^/]+\/exports\/[a-z]+$/u;
/** Applying a change set claims it for 5 minutes in the API, so the forwarder waits as long. */
const APPLY_PATH = /^\/v1\/organizers\/[^/]+\/events\/[^/]+\/change-sets\/[^/]+\/apply$/u;

export const EXPORT_TIMEOUT_MS = 180_000;
export const APPLY_TIMEOUT_MS = 300_000;
export const DEFAULT_TIMEOUT_MS = 15_000;

/** How long the forwarder waits for the API on this path. */
export function forwardTimeoutMs(pathname: string): number {
  if (EXPORT_PATH.test(pathname)) {
    return EXPORT_TIMEOUT_MS;
  }
  return APPLY_PATH.test(pathname) ? APPLY_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
}
