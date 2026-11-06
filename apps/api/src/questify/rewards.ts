import { levelRewardsSchema, type LevelRewards } from "@questify/shared";
import type { PoolClient } from "pg";
import { unauthenticated } from "#src/auth/http-errors";

/**
 * The caller's level, every level's item and the achievement items (T-404c, ADR-767). The door binds to the caller and
 * refuses anyone who is not an active player (PI401, 401). The shared schema is strict, so a field added to the door
 * fails here rather than reaching a phone.
 */
export async function readLevelRewards(client: PoolClient): Promise<LevelRewards> {
  try {
    const { rows } = await client.query<{ r: unknown }>("SELECT own_level_rewards() AS r");
    return levelRewardsSchema.parse(rows[0]?.r);
  } catch (error) {
    if ((error as { code?: string }).code === "PI401") {
      throw unauthenticated();
    }
    throw error;
  }
}
