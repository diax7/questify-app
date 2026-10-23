/** One option's count, as `GET …/events/{id}/quests/{qid}/votes` gives it (T-302). */
export type VoteOptionCount = Readonly<{
  id: string;
  text: Readonly<{ ar: string | null; en: string | null }>;
  votes: number;
}>;

/** Every option's count, their sum, and the players who voted (T-306): a share is out of the voters. */
export type VoteCounts = Readonly<{
  options: readonly VoteOptionCount[];
  total: number;
  voters: number;
}>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isText = (value: unknown) =>
  isRecord(value) &&
  (value["ar"] === null || typeof value["ar"] === "string") &&
  (value["en"] === null || typeof value["en"] === "string");

const isCount = (value: unknown): value is VoteOptionCount =>
  isRecord(value) &&
  typeof value["id"] === "string" &&
  isText(value["text"]) &&
  typeof value["votes"] === "number";

/** Reads the counts; anything malformed reads as nothing, so the panel stays hidden rather than guessing. */
export function voteCountsOf(body: unknown): VoteCounts | undefined {
  if (
    !isRecord(body) ||
    !Array.isArray(body["options"]) ||
    !body["options"].every(isCount) ||
    typeof body["total"] !== "number" ||
    typeof body["voters"] !== "number"
  ) {
    return undefined;
  }
  return { options: body["options"], total: body["total"], voters: body["voters"] };
}

/** An option's share of the voters as a whole percent; with several choices the shares can add up past 100. */
export function shareOf(votes: number, voters: number): number {
  return voters === 0 ? 0 : Math.round((votes * 100) / voters);
}
