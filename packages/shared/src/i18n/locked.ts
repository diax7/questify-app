/**
 * The texts the translation matrix shows but never saves (T-702, Q-378): the wording of the terms, privacy and
 * community-guideline screens, the sign-up and organizer acceptances, account deletion and the marketing consent and
 * opt-out screens. They carry legal or store-compliance meaning, so changing one needs a version record (FR-1781)
 * that the matrix does not keep; they change with a release. A key is locked when it starts with one of these.
 */
const LOCKED_PREFIXES = [
  "legal.",
  "consent.",
  "acceptance.",
  "privacy.",
  "guidelines.",
  "reaccept.",
  "deletion.",
  "optOut.",
  "marketing.",
  "signIn.consent",
  "signIn.terms",
  "signIn.privacy",
  "signIn.accept",
  "signIn.versions",
  "submission.guidelines",
  "staff.accept.",
] as const;

/** Whether the text behind `key` is legal or consent wording that an admin may read but not change. */
export function isLockedText(key: string): boolean {
  return LOCKED_PREFIXES.some((prefix) => key.startsWith(prefix));
}
