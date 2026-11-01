import {
  usageEventsSchema,
  usageOrganizersSchema,
  type UsageEvents,
  type UsageOrganizer,
} from "@questify/shared";

export const USAGE_API = "/v1/admin/usage";

/** The organizers list; undefined when the answer is not the expected shape (a changed API shows the error state). */
export function readUsageOrganizers(body: unknown): UsageOrganizer[] | undefined {
  const parsed = usageOrganizersSchema.safeParse(body);
  return parsed.success ? parsed.data.organizers : undefined;
}

/** One organizer's events with their figures; undefined when the answer is not the expected shape. */
export function readUsageEvents(body: unknown): UsageEvents | undefined {
  const parsed = usageEventsSchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

/** The API path of one organizer's events. The id always comes from a list the schema checked, so it is a UUID. */
export const usageEventsPath = (organizerId: string): string =>
  `${USAGE_API}/organizers/${organizerId}`;
