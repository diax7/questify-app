import {
  questifyRankingSchema,
  type QuestifyRanking,
  type QuestifyRankingScope,
} from "@questify/shared";
import type { PoolClient } from "pg";
import { questifyRankingOff, unauthenticated } from "#src/auth/http-errors";

type Board = Readonly<{ board: string; rows: unknown; me: unknown }>;

/**
 * The Questify-wide ranking as the caller sees it (T-408, FR-611, ADR-322): the top 10 and the caller's own place on
 * the lifetime board or this Questify month's. The answer is checked against the shared schema, so a key the door
 * should never send (an id, a contact, gems) fails loudly instead of reaching a phone.
 */
export async function readQuestifyRanking(
  client: PoolClient,
  scope: QuestifyRankingScope,
): Promise<QuestifyRanking> {
  let board: Board | undefined;
  try {
    const { rows } = await client.query<{ r: Board }>("SELECT questify_ranking($1) AS r", [scope]);
    board = rows[0]?.r;
  } catch (error) {
    const { code } = error as { code?: string };
    if (code === "PI401") throw unauthenticated();
    if (code === "QW404") throw questifyRankingOff();
    throw error;
  }
  if (board === undefined) throw new Error("questify_ranking answered no result");
  return questifyRankingSchema.parse({
    scope,
    month: board.board === "all" ? null : board.board,
    rows: board.rows,
    me: board.me,
  });
}
