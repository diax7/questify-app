import {
  dataEraseAnswerSchema,
  pendingHandoverSchema,
  type DataEraseAnswer,
  type DataRequestReason,
  type PendingHandoverItem,
} from "@questify/shared";
import type { Pool, PoolClient } from "pg";
import { eraseConfirmationRequired, invalidRequest } from "#src/auth/http-errors";
import { door, type Admin } from "#src/console/doors";

/** Why an admin acts on a data request, and the opaque case it belongs to (ADR-483). */
export type CaseOf = Readonly<{ reasonCode: DataRequestReason; reference: string }>;

export type EraseResult =
  | DataEraseAnswer
  | Readonly<{ outcome: "handover_pending"; pending: PendingHandoverItem[] }>;

/** The data-request doors' own refusals (DR400 names the field in its message, DR409 the typed name); the rest pass. */
async function dataDoor<T>(pool: Pool, admin: Admin, work: (client: PoolClient) => Promise<T>) {
  try {
    return await door(pool, admin, work);
  } catch (error) {
    const { code, message } = error as { code?: unknown; message?: unknown };
    if (code === "DR400") {
      throw invalidRequest({ field: message === "reference" ? "reference" : "reasonCode" });
    }
    if (code === "DR409") {
      throw eraseConfirmationRequired();
    }
    throw error;
  }
}

async function pendingOf(client: PoolClient, playerId: string): Promise<PendingHandoverItem[]> {
  const { rows } = await client.query<{
    redemption_id: string;
    event_id: string;
    event_ar: string | null;
    event_en: string | null;
    item_ar: string | null;
    item_en: string | null;
    rank_prize: boolean;
  }>("SELECT * FROM console_player_pending($1)", [playerId]);
  return rows.map((row) =>
    pendingHandoverSchema.parse({
      redemptionId: row.redemption_id,
      eventId: row.event_id,
      event: { ar: row.event_ar, en: row.event_en },
      item: { ar: row.item_ar, en: row.item_en },
      rankPrize: row.rank_prize,
    }),
  );
}

/** One player's data, built by `console_player_export` (migration 0129) and audited there with the case. */
export function exportPlayerData(
  pool: Pool,
  admin: Admin,
  input: CaseOf & Readonly<{ playerId: string }>,
  requestId: string,
): Promise<unknown> {
  return dataDoor(pool, admin, async (client) => {
    const { rows } = await client.query<{ r: unknown }>(
      "SELECT console_player_export($1, $2, $3, $4) AS r",
      [input.playerId, input.reasonCode, input.reference, requestId],
    );
    return rows[0]?.r;
  });
}

/** The handovers still pending for a player, so the console can ask for the forfeit before an erase. */
export function readPendingHandovers(
  pool: Pool,
  admin: Admin,
  playerId: string,
): Promise<PendingHandoverItem[]> {
  return dataDoor(pool, admin, (client) => pendingOf(client, playerId));
}

/**
 * Erases a player on a legal or the player's own request (`admin_erase_player`, ADR-483). A pending handover without
 * the forfeit changes nothing and answers the items; a repeat on a deleted account answers `already_deleted`.
 */
export function erasePlayer(
  pool: Pool,
  admin: Admin,
  input: CaseOf & Readonly<{ playerId: string; username: string; forfeit: boolean }>,
  requestId: string,
): Promise<EraseResult> {
  return dataDoor(pool, admin, async (client): Promise<EraseResult> => {
    const { rows } = await client.query<{ outcome: string; events: string[] }>(
      "SELECT outcome, events FROM admin_erase_player($1, $2, $3, $4, $5, $6)",
      [input.playerId, input.reasonCode, input.reference, input.username, input.forfeit, requestId],
    );
    const row = rows[0];
    if (row?.outcome === "handover_pending") {
      return { outcome: "handover_pending", pending: await pendingOf(client, input.playerId) };
    }
    return dataEraseAnswerSchema.parse({ outcome: row?.outcome, events: row?.events ?? [] });
  });
}
