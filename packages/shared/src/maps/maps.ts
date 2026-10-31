import { z } from "zod";
import type { MessageKey } from "#src/i18n/messages";
import { optionalPlainText } from "#src/text/plain-text";

/**
 * Event maps (T-506, FR-820 to FR-827, ADR-374): named maps an owner or editor adds to an event, with pins for sections,
 * booths, amenities and quests, shown to players as a reference only (FR-825). A pin's place is a thousandth of the
 * board's width (`x`) and height (`y`) from its top left, so it keeps its place when a picture is added (T-506b). These
 * types and checks are shared by the dashboard, the API and the app; the database checks every field again.
 */

export const MAP_PIN_KINDS = ["section", "booth", "quest", "amenity"] as const;
export type MapPinKind = (typeof MAP_PIN_KINDS)[number];
export const MAP_AMENITIES = ["prayer", "toilets", "food", "info", "first_aid"] as const;
export type MapAmenity = (typeof MAP_AMENITIES)[number];

const AMENITY_KEYS: Readonly<Record<MapAmenity, MessageKey>> = {
  prayer: "maps.amenity.prayer",
  toilets: "maps.amenity.toilets",
  food: "maps.amenity.food",
  info: "maps.amenity.info",
  first_aid: "maps.amenity.firstAid",
};

/** The words for an amenity (the dashboard's choice and the app's pin name). */
export const amenityKey = (amenity: MapAmenity): MessageKey => AMENITY_KEYS[amenity];

/** Limits the database repeats. `scale` is the number of thousandths across the board. */
export const MAP_LIMITS = { name: 60, details: 500, scale: 1000, maps: 50, pins: 300 } as const;

/** `POST …/maps`, `PUT …/maps/{id}`: a name in one language is enough, as a session's title is. */
export const mapBodySchema = z
  .strictObject({
    nameAr: optionalPlainText(MAP_LIMITS.name),
    nameEn: optionalPlainText(MAP_LIMITS.name),
  })
  .superRefine((body, context) => {
    if ((body.nameAr ?? "") === "" && (body.nameEn ?? "") === "") {
      context.addIssue({ code: "custom", path: ["name"], message: "name" });
    }
  });
export type MapBody = z.input<typeof mapBodySchema>;

/** `PUT …/maps/order`: every map of the event once, in the order the app lists them. */
export const mapOrderSchema = z.strictObject({
  ids: z.array(z.uuid()).min(1).max(MAP_LIMITS.maps),
});

const place = z.number().int().min(0).max(MAP_LIMITS.scale);

type PinFields = Readonly<{
  kind: MapPinKind;
  amenity?: MapAmenity | null | undefined;
  nameAr?: string | null | undefined;
  nameEn?: string | null | undefined;
  questId?: string | null | undefined;
}>;

const given = (value: string | null | undefined): boolean => (value ?? "") !== "";

/** The field a pin of this kind is still missing: a quest, an amenity, or a name in one language. */
function missingField(pin: PinFields): "questId" | "amenity" | "name" | null {
  if (pin.kind === "quest") return given(pin.questId) ? null : "questId";
  if (pin.kind === "amenity") return given(pin.amenity) ? null : "amenity";
  return given(pin.nameAr) || given(pin.nameEn) ? null : "name";
}

/**
 * `POST …/maps/{id}/pins`, `PUT …/maps/{id}/pins/{pinId}`: the whole pin. A quest pin needs its quest and carries no name
 * (the quest names it); an amenity needs its kind; a section or booth needs a name in one language.
 */
export const mapPinBodySchema = z
  .strictObject({
    kind: z.enum(MAP_PIN_KINDS),
    amenity: z.enum(MAP_AMENITIES).nullable().optional(),
    nameAr: optionalPlainText(MAP_LIMITS.name),
    nameEn: optionalPlainText(MAP_LIMITS.name),
    detailsAr: optionalPlainText(MAP_LIMITS.details, true),
    detailsEn: optionalPlainText(MAP_LIMITS.details, true),
    x: place,
    y: place,
    questId: z.uuid().nullable().optional(),
  })
  .superRefine((pin, context) => {
    const missing = missingField(pin);
    if (missing !== null) {
      context.addIssue({ code: "custom", path: [missing], message: missing });
    }
  });
export type MapPinBody = z.input<typeof mapPinBodySchema>;

const teamPinSchema = z.object({
  id: z.uuid(),
  kind: z.enum(MAP_PIN_KINDS),
  amenity: z.enum(MAP_AMENITIES).nullable(),
  nameAr: z.string().nullable(),
  nameEn: z.string().nullable(),
  detailsAr: z.string().nullable(),
  detailsEn: z.string().nullable(),
  x: z.number(),
  y: z.number(),
  questId: z.uuid().nullable(),
});
export type TeamMapPin = z.infer<typeof teamPinSchema>;

/** A map as the dashboard lists it, its pins in the order they were placed (`map_team_item`). */
export const teamMapSchema = z.object({
  id: z.uuid(),
  nameAr: z.string().nullable(),
  nameEn: z.string().nullable(),
  position: z.number(),
  pins: z.array(teamPinSchema),
});
export type TeamMap = z.infer<typeof teamMapSchema>;

/** `GET …/maps` for the dashboard. */
export const teamMapListSchema = z.object({ maps: z.array(teamMapSchema) });

const bilingual = z.object({ ar: z.string(), en: z.string() });

/** Where a quest stands for the player, as the Quests tab reads it (the API's `QuestState`). */
export const MAP_QUEST_STATES = [
  "done",
  "not_live",
  "paused",
  "locked",
  "not_yet",
  "closed",
  "open",
] as const;
export type MapQuestState = (typeof MAP_QUEST_STATES)[number];

/** What a quest pin shows (FR-823): done, open, or locked (a quest not live, not opened yet or closed counts as locked). */
export type PinStatus = "done" | "open" | "locked";

export function pinStatusOf(state: MapQuestState): PinStatus {
  if (state === "done" || state === "open") return state;
  return "locked";
}

/** A pin as the app shows it (`GET /v1/events/{id}/maps`); a quest pin carries the viewer's own view of the quest. */
export const memberMapPinSchema = z.object({
  id: z.uuid(),
  kind: z.enum(MAP_PIN_KINDS),
  amenity: z.enum(MAP_AMENITIES).nullable(),
  x: z.number(),
  y: z.number(),
  name: bilingual.nullable(),
  details: bilingual.nullable(),
  quest: z
    .object({
      id: z.uuid(),
      title: bilingual,
      points: z.number(),
      state: z.enum(MAP_QUEST_STATES),
    })
    .nullable(),
});
export type MemberMapPin = z.infer<typeof memberMapPinSchema>;

export const memberMapSchema = z.object({
  id: z.uuid(),
  name: bilingual,
  pins: z.array(memberMapPinSchema),
});
export type MemberMap = z.infer<typeof memberMapSchema>;

/** `GET /v1/events/{id}/maps`: the maps in order, and the pin of the station the player last scanned (FR-827). */
export const memberMapsSchema = z.object({
  maps: z.array(memberMapSchema),
  here: z.object({ pinId: z.uuid(), at: z.string() }).nullable(),
});
export type MemberMaps = z.infer<typeof memberMapsSchema>;
