import type {
  AdminCampaign,
  AdminQuest,
  AdminQuestify,
  CampaignBody,
  QuestBody,
  QuestPatch,
  QuestifySeason,
  QuestifySeasons,
} from "@questify/shared";
import type { Pool } from "pg";
import { invalidQuestify, notFound, questifyConflict } from "#src/auth/http-errors";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";

/**
 * The console's Questify quests and campaigns (T-403b, FR-710, FR-711, ADR-278). Every door of migration 0066 re-reads
 * the admin from the account (`app_admin_id`), so the request flag set here opens nothing on its own; the database
 * audits each write with ids and changed field names only.
 */

/** A door's refusal as an HTTP answer; anything else is a server fault and is rethrown. */
export function refusalOf(error: unknown): never {
  const { code, detail, constraint } = error as {
    code?: string;
    detail?: string;
    constraint?: string;
  };
  // Not an active platform admin (QY403): the same 404 the console hook gives, so nothing is advertised. A plain 42501
  // (say a lost EXECUTE grant) is a server fault and falls through to a 500.
  if (code === "QY403" || code === "QY404") throw notFound();
  if (code === "QY409") throw questifyConflict({ reason: detail });
  if (code === "QY422") throw invalidQuestify({ field: detail });
  // A campaign's draft moved to "set your interests", which is always-on only (0071, ADR-320).
  if (code === "23514" && constraint === "questify_quest_interests_shape") {
    throw invalidQuestify({ field: "metric" });
  }
  // A value the tables refuse that the shared schemas let through.
  if (code === "23514") throw invalidQuestify();
  throw error;
}

async function door<T>(pool: Pool, adminId: string, sql: string, values: unknown[]): Promise<T> {
  try {
    return await withConnection(pool, (client) =>
      withRequestContext(client, { isAdmin: true, staffUserId: adminId }, async () => {
        const { rows } = await client.query<{ r: T }>(sql, values);
        return rows[0]?.r as T;
      }),
    );
  } catch (error) {
    return refusalOf(error);
  }
}

export type Write<B> = Readonly<{ id: string | null; body: B; requestId: string }>;
export type Act = Readonly<{ id: string; requestId: string }>;

/** Every always-on quest and the 100 latest-starting campaigns with their quests. */
export const listQuestify = (pool: Pool, adminId: string): Promise<AdminQuestify> =>
  door(pool, adminId, "SELECT questify_admin_list() AS r", []);

/** Creates a draft campaign (`id` null) or replaces a campaign's name and window. */
export const saveCampaign = (
  pool: Pool,
  adminId: string,
  write: Write<CampaignBody>,
): Promise<AdminCampaign> =>
  door(pool, adminId, "SELECT questify_campaign_save($1, $2::jsonb, $3) AS r", [
    write.id,
    JSON.stringify(write.body),
    write.requestId,
  ]);

/** Publishes a draft before it starts; a published one answers as it is. */
export const publishCampaign = (pool: Pool, adminId: string, act: Act): Promise<AdminCampaign> =>
  door(pool, adminId, "SELECT questify_campaign_publish($1, $2) AS r", [act.id, act.requestId]);

/** Retires a campaign at any time; its awards stay. */
export const retireCampaign = (pool: Pool, adminId: string, act: Act): Promise<AdminCampaign> =>
  door(pool, adminId, "SELECT questify_campaign_retire($1, $2) AS r", [act.id, act.requestId]);

/** Creates a quest (`id` null, with its campaign) or replaces one (its campaign never moves). */
export const saveQuest = (
  pool: Pool,
  adminId: string,
  write: Write<QuestBody | QuestPatch>,
): Promise<AdminQuest> =>
  door(pool, adminId, "SELECT questify_quest_save($1, $2::jsonb, $3) AS r", [
    write.id,
    JSON.stringify(write.body),
    write.requestId,
  ]);

/** Retires a quest at any time; its awards stay. */
export const retireQuest = (pool: Pool, adminId: string, act: Act): Promise<AdminQuest> =>
  door(pool, adminId, "SELECT questify_quest_retire($1, $2) AS r", [act.id, act.requestId]);

/** Every season (FR-1786, ADR-323): each Questify month with a board and the current one, newest first. */
export const listSeasons = async (pool: Pool, adminId: string): Promise<QuestifySeasons> => ({
  seasons: await door(pool, adminId, "SELECT questify_seasons() AS r", []),
});

/** One season's archive: its ranked count and its top 10, read with today's rule. */
export const readSeason = (pool: Pool, adminId: string, month: string): Promise<QuestifySeason> =>
  door(pool, adminId, "SELECT questify_season_top($1) AS r", [month]);
