import { readFileSync } from "node:fs";
import { MESSAGES, type MemberMapPin, type MemberMaps } from "@questify/shared";
import { describe, expect, it, vi } from "vitest";
import type { AuthedResult } from "#src/api/session.ts";
import { fetchMaps, isHere, mapToShow, pinGlyph, pinName, pinStatus } from "#src/event/maps.ts";

const ID = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";
const MAP_A = "1f1f1f1f-1f1f-4f1f-8f1f-1f1f1f1f1f1f";
const MAP_B = "2f2f2f2f-2f2f-4f2f-8f2f-2f2f2f2f2f2f";
const PIN_A = "3f3f3f3f-3f3f-4f3f-8f3f-3f3f3f3f3f3f";
const PIN_B = "4f4f4f4f-4f4f-4f4f-8f4f-4f4f4f4f4f4f";
const headers = new Headers();
const ok = (body: unknown): AuthedResult => ({ kind: "ok", status: 200, body, headers });
const requester = (answer: AuthedResult) => ({
  request: vi.fn(async (_request: unknown) => answer),
});
const words = (key: keyof typeof MESSAGES) => MESSAGES[key].en;

const pin = (over: Partial<MemberMapPin> = {}): MemberMapPin => ({
  id: PIN_A,
  kind: "booth",
  amenity: null,
  x: 100,
  y: 200,
  name: { ar: "كشك 12", en: "Booth 12" },
  details: null,
  quest: null,
  ...over,
});
const questPin = (state: "done" | "open" | "locked" | "closed"): MemberMapPin =>
  pin({
    kind: "quest",
    name: { ar: "ابحث عن الثعلب", en: "Find the fox" },
    quest: { id: ID, title: { ar: "ابحث عن الثعلب", en: "Find the fox" }, points: 30, state },
  });
const maps = (here: string | null): MemberMaps => ({
  maps: [
    { id: MAP_A, name: { ar: "الطابق الأول", en: "Floor 1" }, pins: [pin()] },
    {
      id: MAP_B,
      name: { ar: "الساحة", en: "Outdoor" },
      pins: [pin({ id: PIN_B, kind: "amenity", amenity: "prayer", name: null })],
    },
  ],
  here: here === null ? null : { pinId: here, at: "2030-11-01T07:00:00.000Z" },
});

describe("reading the maps", () => {
  it("reads the maps from the player's own endpoint", async () => {
    const call = requester(ok(maps(null)));
    const read = await fetchMaps(call, ID);
    expect(read).toMatchObject({ kind: "maps", data: { maps: [{ id: MAP_A }, { id: MAP_B }] } });
    expect(call.request).toHaveBeenCalledWith({ method: "GET", path: `/v1/events/${ID}/maps` });
  });

  it("says signed out and network apart, and refuses an answer that is not the maps", async () => {
    expect(await fetchMaps(requester({ kind: "signed_out" }), ID)).toEqual({ kind: "signed_out" });
    expect(await fetchMaps(requester({ kind: "network" }), ID)).toEqual({ kind: "network" });
    expect(await fetchMaps(requester(ok({ maps: "none" })), ID)).toEqual({ kind: "network" });
  });
});

describe("what a pin shows", () => {
  it("gives a quest pin done, open or locked, and any other pin no status", () => {
    expect(pinStatus(questPin("done"))).toBe("done");
    expect(pinStatus(questPin("open"))).toBe("open");
    expect(pinStatus(questPin("locked"))).toBe("locked");
    expect(pinStatus(questPin("closed"))).toBe("locked");
    expect(pinStatus(pin())).toBeNull();
  });

  it("names a pin by its own name in the screen's language, else its amenity", () => {
    expect(pinName(pin(), "ar", words)).toBe("كشك 12");
    expect(pinName(pin(), "en", words)).toBe("Booth 12");
    expect(pinName(pin({ kind: "amenity", amenity: "toilets", name: null }), "en", words)).toBe(
      "Toilets",
    );
  });

  it("marks done and open quests by their state, and the rest by what they are", () => {
    expect(pinGlyph(questPin("done"))).toBe("✓");
    expect(pinGlyph(questPin("open"))).toBe("★");
    expect(pinGlyph(pin({ kind: "amenity", amenity: "prayer", name: null }))).toBe("🕌");
    expect(pinGlyph(pin({ kind: "section" }))).toBe("▦");
    expect(pinGlyph(pin())).toBe("●");
  });
});

describe("which map shows", () => {
  it("opens the map holding 'you are here', else the first, and keeps the player's pick", () => {
    expect(mapToShow(maps(null), undefined)?.id).toBe(MAP_A);
    expect(mapToShow(maps(PIN_B), undefined)?.id).toBe(MAP_B);
    expect(mapToShow(maps(PIN_B), MAP_A)?.id).toBe(MAP_A);
    expect(mapToShow(maps(PIN_B), "gone")?.id).toBe(MAP_B);
    expect(mapToShow({ maps: [], here: null }, undefined)).toBeUndefined();
  });

  it("marks only the pin of the last scan", () => {
    const data = maps(PIN_A);
    expect(isHere(data, pin())).toBe(true);
    expect(isHere(data, pin({ id: PIN_B }))).toBe(false);
    expect(isHere(maps(null), pin())).toBe(false);
  });
});

describe("a reference only (FR-825)", () => {
  it("offers no route and reads no position of the phone", () => {
    for (const file of ["maps.ts", "MapsView.tsx", "Maps.tsx"]) {
      expect(readFileSync(`apps/app/src/event/${file}`, "utf8"), file).not.toMatch(
        /expo-location|watchPosition|getCurrentPosition|Linking\.openURL|maps\.google|maps\.apple/,
      );
    }
  });
});
