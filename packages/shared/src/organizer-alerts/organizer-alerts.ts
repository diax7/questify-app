import { z } from "zod";

/**
 * Organizer alerts by email (T-503, FR-1727, ADR-362): the seven types a team member can switch on or off for
 * themselves. All are on until the member switches one off. Size-limit alerts cover both the 80% and the 100% mark.
 */
export const ORGANIZER_ALERT_TYPES = [
  "activated",
  "stock_low",
  "codes_low",
  "new_flags",
  "content_unpublished",
  "support_access",
  "size_limit",
] as const;
export type OrganizerAlertType = (typeof ORGANIZER_ALERT_TYPES)[number];

/** `GET` and `PUT /v1/organizers/:organizerId/alerts/me`: every type, true when the member wants its email. */
export const organizerAlertSwitchesSchema = z.strictObject({
  activated: z.boolean(),
  stock_low: z.boolean(),
  codes_low: z.boolean(),
  new_flags: z.boolean(),
  content_unpublished: z.boolean(),
  support_access: z.boolean(),
  size_limit: z.boolean(),
});
export type OrganizerAlertSwitches = z.infer<typeof organizerAlertSwitchesSchema>;
