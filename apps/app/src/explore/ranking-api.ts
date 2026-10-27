import {
  questifyRankingSchema,
  type QuestifyRanking,
  type QuestifyRankingRow,
  type QuestifyRankingScope,
} from "@questify/shared";
import type { Session } from "#src/api/session.ts";

/**
 * `off`: the platform switched the ranking off (404 `ranking_off`), so Explore hides it. `failed`: anything else that
 * did not answer with a ranking; it is never shown as an empty board.
 */
export type QuestifyRankingAnswer =
  | Readonly<{ kind: "ranking"; ranking: QuestifyRanking }>
  | Readonly<{ kind: "off" }>
  | Readonly<{ kind: "failed" }>
  | Readonly<{ kind: "signed_out" }>;

/** `GET /v1/questify/ranking` (FR-611): the Questify-wide top 10 and the caller's own place, lifetime or this month. */
export async function fetchQuestifyRanking(
  session: Pick<Session, "request">,
  scope: QuestifyRankingScope,
): Promise<QuestifyRankingAnswer> {
  const answer = await session.request({
    method: "GET",
    path: `/v1/questify/ranking?scope=${scope}`,
  });
  if (answer.kind === "signed_out") {
    return { kind: "signed_out" };
  }
  if (answer.kind === "error" && answer.status === 404 && answer.code === "ranking_off") {
    return { kind: "off" };
  }
  if (answer.kind !== "ok") {
    return { kind: "failed" };
  }
  const parsed = questifyRankingSchema.safeParse(answer.body);
  return parsed.success ? { kind: "ranking", ranking: parsed.data } : { kind: "failed" };
}

export type ShownQuestifyRow = QuestifyRankingRow & Readonly<{ key: string }>;

/**
 * What Explore shows (the event ranking's 11-row layout, FR-601): the top rows as given, then the player's own row as
 * an 11th only when they are ranked but not among them. A player without XP on the board gets no row of their own.
 */
export function questifyRankingRows(ranking: QuestifyRanking): readonly ShownQuestifyRow[] {
  const top = ranking.rows.map((row) => ({ ...row, key: `${row.rank}:${row.username}` }));
  const me = ranking.me;
  if (me === null || ranking.rows.some((row) => row.isMe)) {
    return top;
  }
  return [...top, { ...me, isMe: true, key: `${me.rank}:${me.username}` }];
}
