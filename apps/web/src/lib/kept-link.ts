/**
 * Which signed link a shown photo uses (T-814, plan review 86 MINOR 7): the one it first loaded with, so a list read
 * again with a newly signed link does not load the picture again; after that link failed, the newest one; null when the
 * newest one failed too (the photo says its link ran out until the next read signs another).
 */
export function linkToShow(kept: string, failed: string | null, latest: string): string | null {
  const current = failed === kept ? latest : kept;
  return failed === current ? null : current;
}
