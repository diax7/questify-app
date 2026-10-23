import type { Language, MessageKey } from "@questify/shared";

export type Bilingual = Readonly<{ ar: string | null; en: string | null }>;

/** One rank prize as `GET …/rank-prizes` answers it (FR-519). */
export type Prize = Readonly<{
  id: string;
  rankFrom: number;
  rankTo: number;
  kind: "item" | "experience";
  name: Bilingual;
  description: Bilingual;
}>;

export type PrizeSettings = Readonly<{
  rankPrizes: boolean;
  rules: Bilingual;
  prizes: readonly Prize[];
}>;

export type ResultsState = "not_ended" | "open" | "confirmed" | "revealed";

/** One place as `GET …/results` answers it (FR-1719). */
export type Place = Readonly<{
  rank: number;
  enrollmentId: string;
  player: Readonly<{ username: string; avatar: string }>;
  score: number;
  openFlags: number;
  flagKinds: readonly string[];
  prize: Readonly<{ id: string; kind: Prize["kind"]; name: Bilingual }> | null;
  prizeStatus: string | null;
}>;

export type Results = Readonly<{
  state: ResultsState;
  rankPrizes: boolean;
  endsAt: string | null;
  confirmedAt: string | null;
  revealedAt: string | null;
  claimUntil: string | null;
  defaultClaimUntil: string | null;
  places: readonly Place[];
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Reads the prize settings answer; undefined when it is not one. */
export function prizeSettingsOf(body: unknown): PrizeSettings | undefined {
  return isRecord(body) && Array.isArray(body["prizes"]) && typeof body["rankPrizes"] === "boolean"
    ? (body as unknown as PrizeSettings)
    : undefined;
}

/** Reads the results answer; undefined when it is not one. */
export function resultsOf(body: unknown): Results | undefined {
  return isRecord(body) && typeof body["state"] === "string" && Array.isArray(body["places"])
    ? (body as unknown as Results)
    : undefined;
}

/** A bilingual text in the page's language, the other one when that is missing. */
export const named = (text: Bilingual, language: Language): string =>
  (language === "ar" ? (text.ar ?? text.en) : (text.en ?? text.ar)) ?? "";

/** "Rank 1" or "Ranks 2 to 5". */
export function rankLabel(
  prize: Pick<Prize, "rankFrom" | "rankTo">,
): Readonly<{ key: MessageKey; values: Record<string, number> }> {
  return prize.rankFrom === prize.rankTo
    ? { key: "prizes.rankOne", values: { rank: prize.rankFrom } }
    : { key: "prizes.rankRange", values: { from: prize.rankFrom, to: prize.rankTo } };
}

/** The status of a revealed prize, in words. */
export function prizeStatusKey(status: string): MessageKey | null {
  switch (status) {
    case "reserved":
      return "results.status.reserved";
    case "handed_over":
      return "results.status.handedOver";
    case "cancelled":
      return "results.status.cancelled";
    case "expired":
      return "results.status.expired";
    default:
      return null;
  }
}

/** The places' usernames that carry open flags, for the confirm sheet (FR-1719). */
export const flaggedNames = (places: readonly Place[]): string[] =>
  places.filter((place) => place.openFlags > 0).map((place) => `@${place.player.username}`);

/** What the page offers next: confirm (the owner, once ended), reveal (the owner, once confirmed), or nothing. */
export function nextStep(results: Results, owner: boolean): "confirm" | "reveal" | null {
  if (!owner) {
    return null;
  }
  if (results.state === "open") {
    return "confirm";
  }
  return results.state === "confirmed" ? "reveal" : null;
}

/** The first rank after the last prize, offered for a new one (at most 100). */
export const nextRank = (prizes: readonly Pick<Prize, "rankTo">[]): number =>
  Math.min(prizes.reduce((top, prize) => Math.max(top, prize.rankTo), 0) + 1, 100);
