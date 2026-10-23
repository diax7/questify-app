import { switchedOffTypes } from "#src/quests/switched-off";
import {
  paidOf,
  run,
  type Bilingual,
  type Done,
  type Paid,
  type PaidRow,
  type PlayDeps,
} from "#src/plays/run";
import type { SettingsService } from "#src/settings/service";

export type ShareDeps = PlayDeps & Readonly<{ settings: SettingsService }>;

/** A share quest as the player reads it: the organizer's message and link (ADR-199). */
export type ShareView = Readonly<{ message: Bilingual; link: string | null; done: boolean }>;

type ShareRow = {
  event_id: string;
  message_ar: string | null;
  message_en: string | null;
  link: string | null;
  done: boolean;
};

async function shareRow(
  deps: PlayDeps,
  playerId: string,
  questId: string,
): Promise<Done<ShareRow | undefined>> {
  return run(deps, { playerId }, async (client) => {
    const { rows } = await client.query<ShareRow>("SELECT * FROM member_share($1)", [questId]);
    return rows[0];
  });
}

const shareOff = async (deps: ShareDeps, eventId: string, playerId: string) =>
  (await switchedOffTypes(deps.settings, eventId, playerId)).has("share");

/**
 * A share quest's message and link (FR-220); not found unless the player may play it and share quests are on for the
 * event (FR-219), so a switched-off share quest reads as absent.
 */
export async function readShare(
  deps: ShareDeps,
  playerId: string,
  questId: string,
): Promise<Done<ShareView>> {
  const read = await shareRow(deps, playerId, questId);
  if (read.kind !== "done") {
    return read;
  }
  const row = read.value;
  if (row === undefined || (await shareOff(deps, row.event_id, playerId))) {
    return { kind: "not_found" };
  }
  return {
    kind: "done",
    value: { message: { ar: row.message_ar, en: row.message_en }, link: row.link, done: row.done },
  };
}

/**
 * The player completed the phone's share sheet (FR-220): paid once by `share_quest` (migration 0042), refused while
 * the event's composed configuration has share quests off (FR-219).
 */
export async function shareQuest(
  deps: ShareDeps,
  request: Readonly<{ playerId: string; questId: string; idempotencyKey: string }>,
): Promise<Done<Paid>> {
  const read = await shareRow(deps, request.playerId, request.questId);
  if (read.kind !== "done") {
    return read;
  }
  if (read.value !== undefined && (await shareOff(deps, read.value.event_id, request.playerId))) {
    return { kind: "feature_off" };
  }
  return run(deps, { playerId: request.playerId }, async (client) => {
    const { rows } = await client.query<PaidRow>("SELECT * FROM share_quest($1, $2)", [
      request.questId,
      request.idempotencyKey,
    ]);
    return paidOf(client, rows);
  });
}
