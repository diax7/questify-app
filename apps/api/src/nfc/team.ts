import type { Pool } from "pg";
import { runNfc, type NfcDone } from "#src/nfc/tags";
import type { OrganizerContext } from "#src/organizers/store";

export type TeamNfcDeps = Readonly<{ pool: Pool }>;

/** A tag on the quest's Tags panel (FR-312): who wrote it and when, and its taps (CTO 9, CTO A). */
export type TagView = Readonly<{
  id: string;
  label: string;
  locked: boolean;
  status: "active" | "revoked";
  writtenAt: string;
  revokedAt: string | null;
  /** The operator's username, or null once they were removed. */
  writtenBy: string | null;
  taps: number;
  /** Taps whose sticker id was not the registered one: the tag may have been copied. */
  copies: number;
  /** Taps the phone could not check (an iPhone that could not read the sticker's id). */
  unchecked: number;
  lastTapAt: string | null;
}>;

type Json = Record<string, unknown>;

const isoOrNull = (value: unknown): string | null =>
  value === null || value === undefined ? null : new Date(String(value)).toISOString();

const viewOf = (row: Json): TagView => ({
  id: String(row["id"]),
  label: String(row["label"] ?? ""),
  locked: row["locked"] === true,
  status: row["status"] === "revoked" ? "revoked" : "active",
  writtenAt: new Date(String(row["writtenAt"])).toISOString(),
  revokedAt: isoOrNull(row["revokedAt"]),
  writtenBy: typeof row["writtenBy"] === "string" ? row["writtenBy"] : null,
  taps: Number(row["taps"]),
  copies: Number(row["copies"]),
  unchecked: Number(row["unchecked"]),
  lastTapAt: isoOrNull(row["lastTapAt"]),
});

const seatOf = (context: OrganizerContext) => ({
  organizerId: context.organizerId,
  staffUserId: context.staffUserId,
});

/** A quest's tags, active first and newest first (`quest_nfc_tags`). */
export function questTags(
  deps: TeamNfcDeps,
  context: OrganizerContext,
  target: Readonly<{ eventId: string; questId: string }>,
): Promise<NfcDone<TagView[]>> {
  return runNfc(deps.pool, seatOf(context), async (client) => {
    const { rows } = await client.query<{ tags: Json[] }>("SELECT quest_nfc_tags($1, $2) AS tags", [
      target.eventId,
      target.questId,
    ]);
    return (rows[0]?.tags ?? []).map(viewOf);
  });
}

/** Moves a tag to another NFC quest of the event, without rewriting it. Audited by the database. */
export function moveTag(
  deps: TeamNfcDeps,
  context: OrganizerContext,
  request: Readonly<{ eventId: string; tagId: string; questId: string; requestId: string }>,
): Promise<NfcDone<null>> {
  return runNfc(deps.pool, seatOf(context), async (client) => {
    await client.query("SELECT move_nfc_tag($1, $2, $3, $4)", [
      request.eventId,
      request.tagId,
      request.questId,
      request.requestId,
    ]);
    return null;
  });
}

/** Revokes one tag: a later tap answers unknown_tag. Audited by the database. */
export function revokeTag(
  deps: TeamNfcDeps,
  context: OrganizerContext,
  request: Readonly<{ eventId: string; tagId: string; requestId: string }>,
): Promise<NfcDone<null>> {
  return runNfc(deps.pool, seatOf(context), async (client) => {
    await client.query("SELECT revoke_nfc_tag($1, $2, $3)", [
      request.eventId,
      request.tagId,
      request.requestId,
    ]);
    return null;
  });
}

/** Revokes every active tag of a quest; answers how many. Audited by the database. */
export function revokeQuestTags(
  deps: TeamNfcDeps,
  context: OrganizerContext,
  request: Readonly<{ eventId: string; questId: string; requestId: string }>,
): Promise<NfcDone<number>> {
  return runNfc(deps.pool, seatOf(context), async (client) => {
    const { rows } = await client.query<{ revoked: number }>(
      "SELECT revoke_quest_nfc_tags($1, $2, $3) AS revoked",
      [request.eventId, request.questId, request.requestId],
    );
    return rows[0]?.revoked ?? 0;
  });
}
