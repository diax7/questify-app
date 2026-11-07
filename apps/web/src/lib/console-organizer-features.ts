import { organizerFeaturesViewSchema, type OrganizerFeaturesView } from "@questify/shared";

/** The console's per-organizer feature overrides (T-711, FR-1826): `GET`, and `PUT` or `DELETE` of one feature. */
export const organizerFeaturesPath = (organizerId: string): string =>
  `/v1/admin/organizers/${encodeURIComponent(organizerId)}/features`;

export const organizerFeaturePath = (organizerId: string, key: string): string =>
  `${organizerFeaturesPath(organizerId)}/${encodeURIComponent(key)}`;

/** Answers undefined when the body is not the expected shape, so a changed API shows the error state. */
export function readOrganizerFeatures(body: unknown): OrganizerFeaturesView | undefined {
  const parsed = organizerFeaturesViewSchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

/** What the select holds: the organizer follows the platform, or Questify set it Off or On for the organizer. */
export const OVERRIDE_CHOICES = ["platform", "off", "on"] as const;
export type OverrideChoice = (typeof OVERRIDE_CHOICES)[number];

export const choiceOf = (override: boolean | null): OverrideChoice =>
  override === null ? "platform" : override ? "on" : "off";

/** The request that makes a choice: a body to PUT, or null to DELETE (back to the platform's switch). */
export function bodyOf(choice: OverrideChoice): Readonly<{ enabled: boolean }> | null {
  return choice === "platform" ? null : { enabled: choice === "on" };
}

/** A choice just made, not yet in the list the page holds: the feature and the value picked. */
export type PendingChoice = Readonly<{ key: string; choice: OverrideChoice }>;

/** What a feature's select shows: the choice just made for it while the list is being read again, else the stored one. */
export const shownChoice = (
  row: Readonly<{ key: string; override: boolean | null }>,
  pending: PendingChoice | null,
): OverrideChoice => (pending?.key === row.key ? pending.choice : choiceOf(row.override));
