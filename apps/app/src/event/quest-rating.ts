import { memberQuestRatingSchema, type MemberQuestRating, type QuestThumb } from "@questify/shared";
import type { Session } from "#src/api/session.ts";

type Requester = Pick<Session, "request">;

export type RatingRead =
  | Readonly<{ kind: "rating"; rating: MemberQuestRating }>
  | Readonly<{ kind: "none" | "signed_out" | "network" }>;

const path = (questId: string) => `/v1/quests/${encodeURIComponent(questId)}/rating`;

/** Whether to ask for a rating on a quest the player completed, and what they already said (FR-1211, FR-1623). */
export async function fetchRating(session: Requester, questId: string): Promise<RatingRead> {
  const answer = await session.request({ method: "GET", path: path(questId) });
  if (answer.kind === "signed_out") return { kind: "signed_out" };
  if (answer.kind === "error") return { kind: answer.status === 404 ? "none" : "network" };
  if (answer.kind === "network") return { kind: "network" };
  const parsed = memberQuestRatingSchema.safeParse(answer.body);
  return parsed.success ? { kind: "rating", rating: parsed.data } : { kind: "network" };
}

/** Sends a thumb or a skip. Answers the stored rating, or why it was not stored. */
export async function sendRating(
  session: Requester,
  questId: string,
  thumb: QuestThumb,
): Promise<RatingRead> {
  const answer = await session.request({ method: "PUT", path: path(questId), body: { thumb } });
  if (answer.kind === "signed_out") return { kind: "signed_out" };
  if (answer.kind === "error") return { kind: answer.status === 409 ? "none" : "network" };
  if (answer.kind === "network") return { kind: "network" };
  const parsed = memberQuestRatingSchema.safeParse(answer.body);
  return parsed.success ? { kind: "rating", rating: parsed.data } : { kind: "network" };
}

/** What the sheet shows for a rating read: the prompt, the player's thumb, or nothing. */
export type RatingView = "ask" | "up" | "down" | "none";

/** A skipped prompt does not come back; an off switch or an unreadable answer shows nothing. */
export function ratingViewOf(read: RatingRead | undefined): RatingView {
  if (read?.kind !== "rating" || !read.rating.on) return "none";
  switch (read.rating.thumb) {
    case null:
      return "ask";
    case "skip":
      return "none";
    default:
      return read.rating.thumb;
  }
}
