import { toLocalInput, type Language } from "@questify/shared";

export const KINDS = ["physical", "virtual", "workplace"] as const;
export const ACCESS = ["public", "unlisted", "private"] as const;
export const JOIN_METHODS = ["code", "qr", "link", "public_list"] as const;
export type EventStatus = "draft" | "scheduled" | "live" | "ended" | "archived";

/** An event as the API answers it (apps/api/src/events/routes.ts). */
export type EventView = Readonly<{
  id: string;
  joinCode: string;
  name: Readonly<{ ar: string | null; en: string | null }>;
  kind: (typeof KINDS)[number];
  venue: Readonly<{ ar: string | null; en: string | null }>;
  access: (typeof ACCESS)[number];
  joinMethods: readonly (typeof JOIN_METHODS)[number][];
  timezone: string;
  dayStartHour: number;
  startsAt: string;
  endsAt: string;
  status: EventStatus;
  statusNow: EventStatus;
  /** The event's own ranking switch (FR-607). */
  ranking: boolean;
  /** The event's words (FR-404, FR-940); on the single read only, so read it with `readEventTerms`. */
  terms?: unknown;
}>;

/** The name in the page's language, else the other one (an event needs only one). */
export function nameFor(event: Pick<EventView, "name">, language: Language): string {
  const other = language === "ar" ? event.name.en : event.name.ar;
  return event.name[language] ?? other ?? "";
}

/** Zones organizers in the region use most, shown first; every zone the browser knows follows. */
export const COMMON_ZONES = [
  "Asia/Riyadh",
  "Asia/Dubai",
  "Asia/Kuwait",
  "Asia/Qatar",
  "Asia/Bahrain",
  "Asia/Muscat",
  "Africa/Cairo",
  "Asia/Amman",
  "UTC",
] as const;

/** What the form holds: times as the wall clock in the chosen zone, the way date-time fields show them. */
export type EventDraft = Readonly<{
  nameAr: string;
  nameEn: string;
  kind: EventView["kind"];
  venueAr: string;
  venueEn: string;
  timezone: string;
  startsAt: string;
  endsAt: string;
  dayStartHour: number;
  access: EventView["access"];
  joinMethods: readonly EventView["joinMethods"][number][];
}>;

/** A new event's starting values: in Riyadh time, every way to join but the public list. */
export const BLANK_DRAFT: EventDraft = {
  nameAr: "",
  nameEn: "",
  kind: "physical",
  venueAr: "",
  venueEn: "",
  timezone: "Asia/Riyadh",
  startsAt: "",
  endsAt: "",
  dayStartHour: 4,
  access: "public",
  joinMethods: ["code", "qr", "link"],
};

export function draftOf(event: EventView): EventDraft {
  return {
    nameAr: event.name.ar ?? "",
    nameEn: event.name.en ?? "",
    kind: event.kind,
    venueAr: event.venue.ar ?? "",
    venueEn: event.venue.en ?? "",
    timezone: event.timezone,
    startsAt: toLocalInput(new Date(event.startsAt), event.timezone),
    endsAt: toLocalInput(new Date(event.endsAt), event.timezone),
    dayStartHour: event.dayStartHour,
    access: event.access,
    joinMethods: event.joinMethods,
  };
}

const fieldsOf = (draft: EventDraft): Record<string, unknown> => ({
  name: { ar: draft.nameAr, en: draft.nameEn },
  kind: draft.kind,
  venue: { ar: draft.venueAr, en: draft.venueEn },
  access: draft.access,
  joinMethods: draft.joinMethods,
  dayStartHour: draft.dayStartHour,
});

/** The body to create an event: everything, times read in the chosen zone. */
export function createBodyOf(draft: EventDraft): Record<string, unknown> {
  return {
    ...fieldsOf(draft),
    timezone: draft.timezone,
    startsAt: draft.startsAt,
    endsAt: draft.endsAt,
  };
}

/**
 * The body to edit an event: only what changed. A new zone or start sends the zone and both times, since the form
 * shows wall-clock times and the API reads them in the zone sent; a new end alone sends only the end. An unchanged
 * start never reaches a live event's lock.
 */
export function editBodyOf(draft: EventDraft, before: EventDraft): Record<string, unknown> {
  const now = fieldsOf(draft);
  const then = fieldsOf(before);
  const body: Record<string, unknown> = Object.fromEntries(
    Object.entries(now).filter(
      ([key, value]) => JSON.stringify(value) !== JSON.stringify(then[key]),
    ),
  );
  if (draft.timezone !== before.timezone || draft.startsAt !== before.startsAt) {
    return { ...body, timezone: draft.timezone, startsAt: draft.startsAt, endsAt: draft.endsAt };
  }
  return draft.endsAt === before.endsAt ? body : { ...body, endsAt: draft.endsAt };
}
