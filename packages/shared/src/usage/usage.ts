import { z } from "zod";

/**
 * The console's usage view (T-609, FR-1730, ADR-394): counts only, per organizer and per event, from rows that already
 * exist. Login SMS, promotional email, push volume and storage are not metered yet (Q-361), so they are not here.
 */
const count = z.number().int().min(0);

const figures = {
  /** Members of the event who are not rehearsal accounts (pending and declined requests left out). */
  players: count,
  /** Promotional invitations sent through the event's campaigns (SMS and push together). */
  invitationsSent: count,
  /** Alert emails sent to the team, from the outbox that keeps finished rows 30 days. */
  alertEmails: count,
};

const textSchema = z.strictObject({ ar: z.string().nullable(), en: z.string().nullable() });

/** An organizer's row in the list: the organizer's name and the figures over all its events. */
export const usageOrganizerSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  events: count,
  ...figures,
});
export type UsageOrganizer = z.infer<typeof usageOrganizerSchema>;

/** `GET /v1/admin/usage`: the 100 organizers created last, newest first. */
export const usageOrganizersSchema = z.strictObject({
  organizers: z.array(usageOrganizerSchema).max(100),
});

/** One event's row in an organizer's list. */
export const usageEventSchema = z.strictObject({
  id: z.uuid(),
  name: textSchema,
  status: z.enum(["draft", "scheduled", "live", "ended", "archived"]),
  ...figures,
});
export type UsageEvent = z.infer<typeof usageEventSchema>;

/** `GET /v1/admin/usage/organizers/:organizerId`: the organizer's 200 latest events. */
export const usageEventsSchema = z.strictObject({
  organizer: z.strictObject({ id: z.uuid(), name: z.string() }),
  events: z.array(usageEventSchema).max(200),
});
export type UsageEvents = z.infer<typeof usageEventsSchema>;
