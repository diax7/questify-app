import {
  amenityKey,
  memberMapsSchema,
  pinStatusOf,
  type Language,
  type MapAmenity,
  type MemberMap,
  type MemberMapPin,
  type MemberMaps,
  type MessageKey,
  type PinStatus,
} from "@questify/shared";
import type { Session } from "#src/api/session.ts";
import { textIn } from "#src/i18n/text.ts";

type Requester = Pick<Session, "request">;

export type MapsRead =
  | Readonly<{ kind: "maps"; data: MemberMaps }>
  | Readonly<{ kind: "signed_out" | "network" }>;

/** The event's maps with the player's own view of each quest pin (`GET /v1/events/{id}/maps`). */
export async function fetchMaps(session: Requester, eventId: string): Promise<MapsRead> {
  const answer = await session.request({
    method: "GET",
    path: `/v1/events/${encodeURIComponent(eventId)}/maps`,
  });
  if (answer.kind === "signed_out") return { kind: "signed_out" };
  const parsed = answer.kind === "ok" ? memberMapsSchema.safeParse(answer.body) : null;
  return parsed?.success === true ? { kind: "maps", data: parsed.data } : { kind: "network" };
}

/** What a quest pin shows (FR-823), or null for a pin that is not a quest's. */
export const pinStatus = (pin: MemberMapPin): PinStatus | null =>
  pin.quest === null ? null : pinStatusOf(pin.quest.state);

/** A pin's name: its own (a quest's title for a quest pin), else the amenity's standard name. */
export function pinName(
  pin: MemberMapPin,
  language: Language,
  t: (key: MessageKey) => string,
): string {
  const own = pin.name === null ? "" : textIn(pin.name, language);
  if (own !== "") return own;
  return pin.amenity === null ? "" : t(amenityKey(pin.amenity));
}

/** The glyph on a pin that is not a quest's: the amenity's, else the section's or the booth's. */
const AMENITY_GLYPH: Readonly<Record<MapAmenity, string>> = {
  prayer: "🕌",
  toilets: "🚻",
  food: "🍽",
  info: "ℹ",
  first_aid: "✚",
};

export function pinGlyph(pin: MemberMapPin): string {
  const status = pinStatus(pin);
  if (status === "done") return "✓";
  if (status === "open") return "★";
  if (pin.amenity !== null) return AMENITY_GLYPH[pin.amenity];
  return pin.kind === "section" ? "▦" : "●";
}

/** The map to show: the one the player picked, else the one holding "you are here", else the first. */
export function mapToShow(data: MemberMaps, pickedId: string | undefined): MemberMap | undefined {
  const picked = data.maps.find((map) => map.id === pickedId);
  if (picked !== undefined) return picked;
  const here = data.here;
  const holder =
    here === null
      ? undefined
      : data.maps.find((map) => map.pins.some((pin) => pin.id === here.pinId));
  return holder ?? data.maps[0];
}

/** Whether this pin is where the player last scanned. */
export const isHere = (data: MemberMaps, pin: MemberMapPin): boolean => data.here?.pinId === pin.id;
