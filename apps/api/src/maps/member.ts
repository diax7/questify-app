import type { MapAmenity, MapPinKind, MapQuestState, MemberMaps } from "@questify/shared";

type Text = Readonly<{ ar: string | null; en: string | null }>;
type Bilingual = Readonly<{ ar: string; en: string }>;

/** What the Quests tab lists for the player: the one read a quest pin's title, points and state come from. */
export type PinQuest = Readonly<{
  id: string;
  title: Text;
  points: number;
  state: MapQuestState;
}>;

type DoorPin = Readonly<{
  id: string;
  kind: MapPinKind;
  amenity: MapAmenity | null;
  x: number;
  y: number;
  name: Bilingual | null;
  details: Bilingual | null;
  questId: string | null;
}>;

/** The `member_maps` door's answer: quest pins carry only their quest's id. */
export type DoorMaps = Readonly<{
  maps: readonly Readonly<{ id: string; name: Bilingual; pins: readonly DoorPin[] }>[];
  here: Readonly<{ pinId: string; at: string }> | null;
}>;

const textOf = (text: Text): Bilingual => ({
  ar: text.ar ?? text.en ?? "",
  en: text.en ?? text.ar ?? "",
});

/**
 * The maps a player is shown (FR-823): each quest pin takes its quest's title, points and state from the quests the
 * player lists, and a pin whose quest is not among them (hidden, a type switched off) is left out, so a map never names
 * a quest the Quests tab does not. "You are here" is dropped with its pin.
 */
export function memberMapsOf(door: DoorMaps, quests: ReadonlyMap<string, PinQuest>): MemberMaps {
  const kept = new Set<string>();
  const maps = door.maps.map((map) => ({
    id: map.id,
    name: map.name,
    pins: map.pins.flatMap((pin) => {
      const quest = pin.questId === null ? null : quests.get(pin.questId);
      if (quest === undefined) return [];
      kept.add(pin.id);
      return [
        {
          id: pin.id,
          kind: pin.kind,
          amenity: pin.amenity,
          x: pin.x,
          y: pin.y,
          name: quest === null ? pin.name : textOf(quest.title),
          details: pin.details,
          quest:
            quest === null
              ? null
              : {
                  id: quest.id,
                  title: textOf(quest.title),
                  points: quest.points,
                  state: quest.state,
                },
        },
      ];
    }),
  }));
  return { maps, here: door.here !== null && kept.has(door.here.pinId) ? door.here : null };
}
