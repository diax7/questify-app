import { VENUE_RADIUS, toLocalInput, type Language } from "@questify/shared";
import { isRadius, pinIsValid, pinTyped } from "#src/lib/coordinates.ts";

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
  /** The venue's pin and radius, for the far-from-venue flag (T-303b); no pin means no such flag. */
  venuePin: Readonly<{ lat: number; lng: number }> | null;
  venueRadiusM: number;
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
  /** Today's ranking switch for a multi-day event (FR-608). */
  rankingToday: boolean;
  /** The event's share quests switch (FR-219). */
  shareQuests: boolean;
  /** The event's meet-someone switch (FR-1009). */
  meetSomeone: boolean;
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
  /** The venue pin and its radius as typed; both pin numbers empty means no pin. */
  venueLat: string;
  venueLng: string;
  venueRadius: string;
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
  venueLat: "",
  venueLng: "",
  venueRadius: String(VENUE_RADIUS.default),
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
    venueLat: event.venuePin === null ? "" : String(event.venuePin.lat),
    venueLng: event.venuePin === null ? "" : String(event.venuePin.lng),
    venueRadius: String(event.venueRadiusM),
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
  venuePin: pinTyped(draft.venueLat, draft.venueLng)
    ? { lat: Number(draft.venueLat), lng: Number(draft.venueLng) }
    : null,
  venueRadiusM: Number(draft.venueRadius),
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

/** Whether the venue pin and radius are what the API takes: both pin numbers in range or neither, 100 to 20000 m. */
export const venueIsValid = (draft: EventDraft): boolean =>
  pinIsValid(draft.venueLat, draft.venueLng) &&
  isRadius(draft.venueRadius, VENUE_RADIUS.min, VENUE_RADIUS.max);
