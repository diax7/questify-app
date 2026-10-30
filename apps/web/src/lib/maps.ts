import {
  MAP_LIMITS,
  type Language,
  type MapAmenity,
  type MapPinBody,
  type MapPinKind,
  type MessageKey,
  type TeamMap,
  type TeamMapPin,
} from "@questify/shared";

/** A pin's fields as typed: text, the place as percentages of the board, and the choice of a quest. */
export type PinDraft = {
  kind: MapPinKind;
  amenity: MapAmenity;
  nameAr: string;
  nameEn: string;
  detailsAr: string;
  detailsEn: string;
  x: string;
  y: string;
  questId: string;
};

/** A new pin starts in the middle of the board, so it is on the board before anyone clicks. */
export const blankPin = (): PinDraft => ({
  kind: "booth",
  amenity: "prayer",
  nameAr: "",
  nameEn: "",
  detailsAr: "",
  detailsEn: "",
  x: "50",
  y: "50",
  questId: "",
});

const percentOf = (thousandths: number): string => String(thousandths / 10);
const orEmpty = (text: string | null): string => text ?? "";

/** A saved pin as the form shows it. */
export function pinDraftOf(pin: TeamMapPin): PinDraft {
  return {
    kind: pin.kind,
    amenity: pin.amenity ?? "prayer",
    nameAr: orEmpty(pin.nameAr),
    nameEn: orEmpty(pin.nameEn),
    detailsAr: orEmpty(pin.detailsAr),
    detailsEn: orEmpty(pin.detailsEn),
    x: percentOf(pin.x),
    y: percentOf(pin.y),
    questId: orEmpty(pin.questId),
  };
}

/** A typed percentage as thousandths of the board, or NaN when it is not a number (the API names the field). */
export const thousandthsOf = (percent: string): number =>
  percent.trim() === "" ? Number.NaN : Math.round(Number(percent) * (MAP_LIMITS.scale / 100));

const textOrNull = (text: string): string | null => (text.trim() === "" ? null : text.trim());

/** What the form sends: only the fields the pin's kind uses. */
export function pinPayload(draft: PinDraft): MapPinBody {
  const place = { x: thousandthsOf(draft.x), y: thousandthsOf(draft.y) };
  if (draft.kind === "quest") return { kind: "quest", questId: draft.questId || null, ...place };
  return {
    kind: draft.kind,
    amenity: draft.kind === "amenity" ? draft.amenity : null,
    nameAr: textOrNull(draft.nameAr),
    nameEn: textOrNull(draft.nameEn),
    detailsAr: textOrNull(draft.detailsAr),
    detailsEn: textOrNull(draft.detailsEn),
    ...place,
  };
}

const ISSUE_KEYS: Readonly<Record<string, MessageKey>> = {
  name: "maps.issue.name",
  nameAr: "maps.issue.nameAr",
  nameEn: "maps.issue.nameEn",
  detailsAr: "maps.issue.detailsAr",
  detailsEn: "maps.issue.detailsEn",
  kind: "maps.issue.kind",
  amenity: "maps.issue.amenity",
  x: "maps.issue.place",
  y: "maps.issue.place",
  place: "maps.issue.place",
  questId: "maps.issue.questId",
  order: "maps.issue.order",
  pin: "maps.issue.pin",
};

/** The message for a field the API or the database named; an unknown one reads as the general refusal. */
export const mapIssueKey = (issue: string): MessageKey => ISSUE_KEYS[issue] ?? "maps.issue.map";

/** A map's name in the page's language, the other language's when it has only that one. */
export function mapName(map: TeamMap, language: Language): string {
  const [first, second] = language === "ar" ? [map.nameAr, map.nameEn] : [map.nameEn, map.nameAr];
  return first ?? second ?? "";
}

/** What a pin is called on the dashboard: its own name, else its amenity's, else its quest's title. */
export function pinLabel(
  pin: TeamMapPin,
  language: Language,
  quests: ReadonlyMap<string, string>,
  amenityName: (amenity: MapAmenity) => string,
): string {
  const [first, second] = language === "ar" ? [pin.nameAr, pin.nameEn] : [pin.nameEn, pin.nameAr];
  const own = first ?? second;
  if (own !== null) return own;
  if (pin.kind === "quest") return quests.get(pin.questId ?? "") ?? "";
  return pin.amenity === null ? "" : amenityName(pin.amenity);
}

/** The glyph a pin shows on the board; its words are the label beside it. */
export const PIN_GLYPH: Readonly<Record<MapPinKind, string>> = {
  section: "▦",
  booth: "●",
  quest: "★",
  amenity: "+",
};

/** The ids of the quests that already have a pin on any map: a quest has one pin in an event. */
export function pinnedQuestIds(maps: readonly TeamMap[] | null): ReadonlySet<string> {
  const ids = (maps ?? []).flatMap((map) => map.pins.map((pin) => pin.questId));
  return new Set(ids.filter((id): id is string => id !== null));
}
