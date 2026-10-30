import { describe, expect, it } from "vitest";
import { memberMapsOf, type DoorMaps, type PinQuest } from "#src/maps/member";

const text = (en: string) => ({ ar: en, en });
const quest = (id: string, state: PinQuest["state"], title = "Station"): PinQuest => ({
  id,
  title: { ar: null, en: title },
  points: 30,
  state,
});
const pin = (id: string, questId: string | null, kind: "quest" | "amenity" = "quest") =>
  ({
    id,
    kind,
    amenity: kind === "amenity" ? "food" : null,
    x: 10,
    y: 20,
    name: kind === "quest" ? null : text("Food court"),
    details: null,
    questId,
  }) as const;

const door = (pins: ReturnType<typeof pin>[], here: string | null): DoorMaps => ({
  maps: [{ id: "map-1", name: text("Floor"), pins }],
  here: here === null ? null : { pinId: here, at: "2026-10-30T10:00:00.000Z" },
});

describe("the maps a player is shown", () => {
  it("gives a quest pin its quest's title, points and state, and leaves other pins as they are", () => {
    const shown = memberMapsOf(
      door([pin("p1", "q1"), pin("p2", null, "amenity")], null),
      new Map([["q1", quest("q1", "open", "Find the fox")]]),
    );
    expect(shown.maps[0]?.pins[0]).toMatchObject({
      name: { ar: "Find the fox", en: "Find the fox" },
      quest: { id: "q1", points: 30, state: "open" },
    });
    expect(shown.maps[0]?.pins[1]).toMatchObject({ name: text("Food court"), quest: null });
  });

  it("drops a quest pin whose quest the player does not list, and 'you are here' with it", () => {
    const quests = new Map([["q2", quest("q2", "done")]]);
    const shown = memberMapsOf(door([pin("p1", "q1"), pin("p2", "q2")], "p1"), quests);
    expect(shown.maps[0]?.pins.map((row) => row.id)).toEqual(["p2"]);
    expect(shown.here).toBeNull();
    expect(memberMapsOf(door([pin("p1", "q1"), pin("p2", "q2")], "p2"), quests).here).toEqual({
      pinId: "p2",
      at: "2026-10-30T10:00:00.000Z",
    });
  });

  it("shows no quest pin at all when the player lists no quests", () => {
    const shown = memberMapsOf(
      door([pin("p1", "q1"), pin("p2", null, "amenity")], null),
      new Map(),
    );
    expect(shown.maps[0]?.pins.map((row) => row.id)).toEqual(["p2"]);
  });
});
