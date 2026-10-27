import {
  questifySeasonSchema,
  questifySeasonsSchema,
  type QuestifySeason,
  type QuestifySeasons,
} from "@questify/shared";

export const SEASONS_API = "/v1/admin/questify/seasons";

export type SeasonListing = QuestifySeasons["seasons"][number];

/** The seasons list; undefined when the answer is not the expected shape (a changed API shows the error state). */
export function readSeasons(body: unknown): SeasonListing[] | undefined {
  const parsed = questifySeasonsSchema.safeParse(body);
  return parsed.success ? parsed.data.seasons : undefined;
}

/** One season's ranked count and top 10; undefined when the answer is not the expected shape. */
export function readSeason(body: unknown): QuestifySeason | undefined {
  const parsed = questifySeasonSchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

/** The API path of one season. The month always comes from a list the schema checked, so it is `YYYY-MM`. */
export const seasonPath = (month: string): string => `${SEASONS_API}/${month}`;

/** The season the page opens on: the current month, else the newest (the list is newest first). */
export function openingMonth(seasons: readonly SeasonListing[]): string | null {
  return (seasons.find((season) => season.current) ?? seasons[0])?.month ?? null;
}
