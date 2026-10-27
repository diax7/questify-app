import { describe, expect, it } from "vitest";
import {
  SEASONS_API,
  openingMonth,
  readSeason,
  readSeasons,
  seasonPath,
} from "#src/lib/console-seasons.ts";

const EQUIPMENT = { character: null, frame: null, title: null };
const row = (rank: number, xp: number) => ({
  rank,
  username: `player_${String(rank)}`,
  avatar: "fox",
  equipment: EQUIPMENT,
  xp,
  level: 3,
});
const listing = [
  { month: "2026-10", players: 12, current: true },
  { month: "2026-09", players: 0, current: false },
  { month: "2026-08", players: 4, current: false },
];

describe("readSeasons", () => {
  it("reads the months as the API sends them, newest first", () => {
    expect(readSeasons({ seasons: listing })).toEqual(listing);
  });

  it.each([
    ["no body", undefined],
    ["a list without the key", {}],
    [
      "a month that is not YYYY-MM",
      { seasons: [{ month: "2026-13", players: 1, current: false }] },
    ],
    ["a negative count", { seasons: [{ month: "2026-10", players: -1, current: true }] }],
    ["a row with an extra key", { seasons: [{ ...listing[0], reset: true }] }],
  ])("refuses %s", (_name, body) => {
    expect(readSeasons(body)).toBeUndefined();
  });
});

describe("readSeason", () => {
  it("reads a season's count and top rows", () => {
    const body = { month: "2026-08", players: 4, rows: [row(1, 900), row(2, 800)] };
    expect(readSeason(body)).toEqual(body);
  });

  it("reads a month nobody played as an empty list", () => {
    const body = { month: "2026-09", players: 0, rows: [] };
    expect(readSeason(body)).toEqual(body);
  });

  it("refuses more than 10 rows, an id, or a row without XP", () => {
    const eleven = Array.from({ length: 11 }, (_, index) => row(index + 1, 100));
    expect(readSeason({ month: "2026-08", players: 11, rows: eleven })).toBeUndefined();
    const withId = { ...row(1, 100), id: "6f1c7a0e-0000-4000-8000-000000000001" };
    expect(readSeason({ month: "2026-08", players: 1, rows: [withId] })).toBeUndefined();
    expect(readSeason({ month: "2026-08", players: 1, rows: [row(1, 0)] })).toBeUndefined();
  });
});

describe("seasonPath", () => {
  it("puts the month after the list's path", () => {
    expect(seasonPath("2026-08")).toBe(`${SEASONS_API}/2026-08`);
  });
});

describe("openingMonth", () => {
  it("opens on the current month", () => {
    expect(openingMonth(listing)).toBe("2026-10");
  });

  it("opens on the newest month when none is marked current", () => {
    expect(openingMonth(listing.map((season) => ({ ...season, current: false })))).toBe("2026-10");
  });

  it("has no month for an empty list", () => {
    expect(openingMonth([])).toBeNull();
  });
});
