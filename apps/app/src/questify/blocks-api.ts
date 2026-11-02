import { blocksAnswerSchema, type BlockedPlayer } from "@questify/shared";
import type { Session } from "#src/api/session.ts";
import { randomUuid } from "#src/api/uuid.ts";

/**
 * A player's own block list (FR-1415, T-705). Blocking hides the other player's name and profile from this player and
 * stops meet quests between the two; the other player is never told.
 */
export async function readBlocks(
  session: Pick<Session, "request">,
): Promise<readonly BlockedPlayer[] | null> {
  const answer = await session.request({ method: "GET", path: "/v1/me/blocks" });
  const parsed = answer.kind === "ok" ? blocksAnswerSchema.safeParse(answer.body) : null;
  return parsed?.success === true ? parsed.data.blocks : null;
}

/** Blocks or unblocks a player by username; true when the server saved it. */
export async function setBlocked(
  session: Pick<Session, "request">,
  username: string,
  blocked: boolean,
): Promise<boolean> {
  const answer = await session.request(
    blocked
      ? {
          method: "POST",
          path: "/v1/me/blocks",
          body: { username },
          headers: { "idempotency-key": randomUuid() },
        }
      : {
          method: "DELETE",
          path: `/v1/me/blocks/${encodeURIComponent(username)}`,
          headers: { "idempotency-key": randomUuid() },
        },
  );
  return answer.kind === "ok";
}
