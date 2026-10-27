import type { z } from "zod";
import { describe, expect, it } from "vitest";
import { EMPTY_EQUIPMENT } from "#src/players/items";
import {
  QUESTIFY_RANKING_SCOPES,
  questifyMonthSchema,
  questifyRankingQuerySchema,
  questifyRankingSchema,
  questifySeasonSchema,
  questifySeasonsSchema,
} from "#src/questify/ranking";

const accepts = (schema: z.ZodType, value: unknown) => schema.safeParse(value).success;
const shown = {
  rank: 1,
  username: "sara_k",
  avatar: "falcon",
  equipment: EMPTY_EQUIPMENT,
  xp: 300,
  level: 2,
};
const ranking = { scope: "month", month: "2026-10", rows: [{ ...shown, isMe: true }], me: shown };

describe("questifyRankingQuerySchema", () => {
  it("defaults to lifetime and takes only the two scopes", () => {
    expect(QUESTIFY_RANKING_SCOPES).toEqual(["lifetime", "month"]);
    expect(questifyRankingQuerySchema.parse({})).toEqual({ scope: "lifetime" });
    expect(questifyRankingQuerySchema.parse({ scope: "month" })).toEqual({ scope: "month" });
    for (const scope of ["season", "", "LIFETIME"])
      expect(accepts(questifyRankingQuerySchema, { scope })).toBe(false);
    expect(accepts(questifyRankingQuerySchema, { scope: "month", page: "2" })).toBe(false);
  });
});

describe("questifyMonthSchema", () => {
  it("takes YYYY-MM with a month from 01 to 12 only", () => {
    for (const month of ["2026-01", "2026-10", "2026-12"])
      expect(accepts(questifyMonthSchema, month)).toBe(true);
    for (const month of ["2026-00", "2026-13", "2026-1", "26-10", "2026-10-01", "all"])
      expect(accepts(questifyMonthSchema, month)).toBe(false);
  });
});

describe("questifyRankingSchema", () => {
  it("takes the top rows and the caller's place, or none", () => {
    expect(questifyRankingSchema.parse(ranking)).toEqual(ranking);
    expect(accepts(questifyRankingSchema, { ...ranking, me: null })).toBe(true);
    expect(accepts(questifyRankingSchema, { ...ranking, scope: "lifetime", month: null })).toBe(
      true,
    );
  });

  it("refuses a row with an extra key (an id, gems), more than 10 rows, or a row without XP", () => {
    for (const extra of [{ playerId: "x" }, { gems: 5 }]) {
      expect(accepts(questifyRankingSchema, { ...ranking, me: { ...shown, ...extra } })).toBe(
        false,
      );
      expect(
        accepts(questifyRankingSchema, { ...ranking, rows: [{ ...shown, isMe: false, ...extra }] }),
      ).toBe(false);
    }
    const eleven = Array.from({ length: 11 }, (_, i) => ({ ...shown, rank: i + 1, isMe: false }));
    expect(accepts(questifyRankingSchema, { ...ranking, rows: eleven })).toBe(false);
    expect(accepts(questifyRankingSchema, { ...ranking, me: { ...shown, xp: 0 } })).toBe(false);
    expect(accepts(questifyRankingSchema, { ...ranking, rows: [shown] })).toBe(false);
  });
});

describe("the season schemas", () => {
  it("take the seasons list and one season's top rows without isMe", () => {
    const seasons = { seasons: [{ month: "2026-10", players: 12, current: true }] };
    expect(questifySeasonsSchema.parse(seasons)).toEqual(seasons);
    const season = { month: "2026-09", players: 1, rows: [shown] };
    expect(questifySeasonSchema.parse(season)).toEqual(season);
    expect(accepts(questifySeasonSchema, { ...season, rows: [{ ...shown, isMe: false }] })).toBe(
      false,
    );
    expect(
      accepts(questifySeasonsSchema, {
        seasons: [{ month: "2026-10", players: -1, current: true }],
      }),
    ).toBe(false);
  });
});
