import type { Pool, PoolClient } from "pg";
import type { AuthKeys } from "#src/auth/keys";
import type { Caller } from "#src/auth/sign-in";
import { BUCKETS } from "#src/auth/throttle";
import {
  boostApplied,
  bonusPaid,
  itemGiven,
  levelReached,
  type Completed,
  type Position,
} from "#src/completions/complete";
import type { RequestContext } from "#src/db/context";
import { ticketHolds, issueTicket, type TicketKey } from "#src/nfc/ticket";
import { heldBack, type PlayerLimit } from "#src/plays/limits";
import { run, type PlayRefusal } from "#src/plays/run";
import { firstBonusPaid } from "#src/quests/first-bonus";
import { tagCode, tagCodeUrl, verifyTagCode, type TagCodeKey } from "#src/quests/qr";
import type { SettingsService } from "#src/settings/service";

export type NfcDeps = Readonly<{
  pool: Pool;
  tagKey: TagCodeKey;
  ticketKey: TicketKey;
  keys: Pick<AuthKeys, "playerKey">;
  settings: Pick<SettingsService, "forEvent">;
  dashboardOrigin: string;
  /** The clock, in milliseconds (tests move it). */
  now?: () => number;
}>;

/** The limits of NFC (T-308, CTO 8): prepares and confirms per operator, taps per player, each a minute. */
export const NFC_LIMITS = {
  preparesPerOperator: { max: 60, windowSeconds: 60 },
  confirmsPerOperator: { max: 60, windowSeconds: 60 },
  tapsPerPlayer: { max: 60, windowSeconds: 60 },
} as const;

const PREPARE_LIMIT: PlayerLimit = {
  bucket: BUCKETS.nfcPrepare,
  ...NFC_LIMITS.preparesPerOperator,
};
const CONFIRM_LIMIT: PlayerLimit = {
  bucket: BUCKETS.nfcConfirm,
  ...NFC_LIMITS.confirmsPerOperator,
};
const TAP_LIMIT: PlayerLimit = { bucket: BUCKETS.nfcTap, ...NFC_LIMITS.tapsPerPlayer };

/** Why an operator's write or a player's tap was refused, beside the play refusals of the completion door. */
export type NfcRefusal =
  | PlayRefusal
  | Readonly<{ kind: "unknown_tag" }>
  | Readonly<{ kind: "invalid_proof" }>
  | Readonly<{ kind: "not_operator" }>
  | Readonly<{ kind: "ability_off" }>
  | Readonly<{ kind: "outside_quests" }>
  | Readonly<{ kind: "event_closed" }>
  | Readonly<{ kind: "not_nfc" }>
  | Readonly<{ kind: "limit_reached" }>
  | Readonly<{ kind: "already_registered" }>
  | Readonly<{ kind: "invalid_tag"; field: string }>
  | Readonly<{ kind: "platform_off" }>
  | Readonly<{ kind: "too_many_attempts"; retryAfterSeconds: number }>;

export type NfcDone<T> = Readonly<{ kind: "done"; value: T }> | NfcRefusal;

type PgError = Readonly<{ code?: string; detail?: string }>;

const NT409: ReadonlySet<string> = new Set([
  "event_closed",
  "not_nfc",
  "limit_reached",
  "already_registered",
]);

/** The SQLSTATEs of migration 0056's doors as refusals; undefined for anything else. */
export function nfcRefusalOf(pg: PgError): NfcRefusal | undefined {
  switch (pg.code) {
    case "NT404":
      return { kind: "unknown_tag" };
    case "OQ404":
      return { kind: "not_found" };
    case "OP403":
      return { kind: "not_operator" };
    case "OA403":
      return { kind: "ability_off" };
    case "OS403":
      return { kind: "outside_quests" };
    case "NT422":
      return { kind: "invalid_tag", field: pg.detail ?? "tag" };
    case "NT409":
      return NT409.has(pg.detail ?? "") ? ({ kind: pg.detail } as NfcRefusal) : undefined;
    default:
      return undefined;
  }
}

/** Runs one call in `context`; an NFC refusal or a completion refusal the database raises becomes its result. */
export async function runNfc<T>(
  pool: Pool,
  context: RequestContext,
  work: (client: PoolClient) => Promise<T>,
): Promise<NfcDone<T>> {
  try {
    return await run({ pool }, context, work);
  } catch (error) {
    const refusal = nfcRefusalOf(error as PgError);
    if (refusal === undefined) {
      throw error;
    }
    return refusal;
  }
}

/** Whether the platform's `nfcTags` switch is on (ADR-234); on unless a Questify admin switched it off. */
export async function nfcPlatformOn(settings: Pick<SettingsService, "forEvent">): Promise<boolean> {
  const config = await settings.forEvent(undefined);
  return config.kind === "ok" && config.config.features["nfcTags"]?.enabled !== false;
}

/** The switch and a per-person limit, before anything is read: undefined when the call may go on. */
async function gate(
  deps: NfcDeps,
  personId: string,
  limit: PlayerLimit,
): Promise<NfcRefusal | undefined> {
  if (!(await nfcPlatformOn(deps.settings))) {
    return { kind: "platform_off" };
  }
  const wait = await heldBack(deps, personId, limit, true);
  return wait === undefined ? undefined : { kind: "too_many_attempts", retryAfterSeconds: wait };
}

const nowOf = (deps: NfcDeps): number => (deps.now ?? Date.now)();

export type WriteTarget = Readonly<{ operatorId: string; eventId: string; questId: string }>;

/** A prepared write: the tag's id, the URL to write on it, and the ticket confirm requires (about 5 minutes). */
export type Prepared = Readonly<{ tagId: string; url: string; ticket: string }>;

/**
 * Step 1 of writing a tag (FR-312): `prepare_nfc_tag` checks the operator, the ability, the quest and the event and
 * answers a fresh id; the API signs it into the tag's URL (version 1) and into a write ticket. Nothing is stored.
 */
export async function prepareTag(deps: NfcDeps, target: WriteTarget): Promise<NfcDone<Prepared>> {
  const held = await gate(deps, target.operatorId, PREPARE_LIMIT);
  if (held !== undefined) {
    return held;
  }
  const made = await runNfc(deps.pool, { playerId: target.operatorId }, async (client) => {
    const { rows } = await client.query<{ id: string }>("SELECT prepare_nfc_tag($1, $2) AS id", [
      target.eventId,
      target.questId,
    ]);
    return (rows[0] as { id: string }).id;
  });
  if (made.kind !== "done") {
    return made;
  }
  const tagId = made.value;
  return {
    kind: "done",
    value: {
      tagId,
      url: tagCodeUrl(deps.dashboardOrigin, tagCode(deps.tagKey, tagId, 1)),
      ticket: issueTicket(deps.ticketKey, { ...target, tagId }, nowOf(deps)),
    },
  };
}

export type Confirm = WriteTarget &
  Readonly<{
    /** The token of the URL the phone wrote (the `/t/` path's last part). */
    code: string;
    ticket: string;
    /** The sticker's id, lower-case hex. */
    uid: string;
    label: string;
    locked: boolean;
    requestId: string;
  }>;

type Bilingual = Readonly<{ ar: string | null; en: string | null }>;

/** A registered tag; `replaced` names the tag this sticker held before (its label and quest), or null. */
export type Registered = Readonly<{
  tagId: string;
  questId: string;
  replaced: Readonly<{ label: string; questId: string; quest: Bilingual }> | null;
}>;

type RegisteredRow = {
  tag_id: string;
  quest_id: string;
  replaced_label: string | null;
  replaced_quest: string | null;
  replaced_title_ar: string | null;
  replaced_title_en: string | null;
};

/** The ticket and the token the phone sends back, checked together (CTO 5, CTO B): the tag's id, or a refusal. */
function writtenTag(deps: NfcDeps, request: Confirm): string | NfcRefusal {
  const opened = verifyTagCode(deps.tagKey, request.code);
  if (opened.kind !== "valid" || opened.version !== 1) {
    return { kind: "invalid_tag", field: "code" };
  }
  const fields = { ...request, tagId: opened.tagId };
  return ticketHolds(deps.ticketKey, request.ticket, fields, nowOf(deps))
    ? opened.tagId
    : { kind: "invalid_tag", field: "ticket" };
}

/**
 * Step 3 of writing a tag (FR-312): the token and ticket of the prepared write, the sticker's id, its label and lock.
 * `register_nfc_tag` checks every rule again under the quest row and swaps out an older registration of this sticker.
 */
export async function confirmTag(deps: NfcDeps, request: Confirm): Promise<NfcDone<Registered>> {
  const held = await gate(deps, request.operatorId, CONFIRM_LIMIT);
  if (held !== undefined) {
    return held;
  }
  const tagId = writtenTag(deps, request);
  if (typeof tagId !== "string") {
    return tagId;
  }
  return runNfc(deps.pool, { playerId: request.operatorId }, async (client) => {
    const { rows } = await client.query<RegisteredRow>(
      "SELECT * FROM register_nfc_tag($1, $2, $3, $4, $5, $6, $7)",
      [
        request.eventId,
        request.questId,
        tagId,
        Buffer.from(request.uid, "hex"),
        request.label,
        request.locked,
        request.requestId,
      ],
    );
    const row = rows[0] as RegisteredRow;
    return {
      tagId: row.tag_id,
      questId: row.quest_id,
      replaced:
        row.replaced_quest === null
          ? null
          : {
              label: row.replaced_label ?? "",
              questId: row.replaced_quest,
              quest: { ar: row.replaced_title_ar, en: row.replaced_title_en },
            },
    };
  });
}

/** The Tools screen's write page: the quests the operator may write a tag for, and their own latest writes. */
export type OperatorTags = Readonly<{
  quests: ReadonlyArray<Readonly<{ id: string; title: Bilingual; tags: number }>>;
  tags: ReadonlyArray<
    Readonly<{
      id: string;
      questId: string;
      quest: Bilingual;
      label: string;
      locked: boolean;
      status: "active" | "revoked";
      writtenAt: string;
    }>
  >;
}>;

type Json = Record<string, unknown>;
const titleOf = (row: Json): Bilingual => ({
  ar: (row["titleAr"] as string | null) ?? null,
  en: (row["titleEn"] as string | null) ?? null,
});

/** The calling operator's write page (`operator_nfc_tags`). */
export async function operatorTags(
  deps: NfcDeps,
  operatorId: string,
  eventId: string,
): Promise<NfcDone<OperatorTags>> {
  if (!(await nfcPlatformOn(deps.settings))) {
    return { kind: "platform_off" };
  }
  return runNfc(deps.pool, { playerId: operatorId }, async (client) => {
    const { rows } = await client.query<{ page: { quests: Json[]; tags: Json[] } }>(
      "SELECT operator_nfc_tags($1) AS page",
      [eventId],
    );
    const page = rows[0]?.page ?? { quests: [], tags: [] };
    return {
      quests: page.quests.map((row) => ({
        id: String(row["id"]),
        title: titleOf(row),
        tags: Number(row["tags"]),
      })),
      tags: page.tags.map((row) => ({
        id: String(row["id"]),
        questId: String(row["questId"]),
        quest: titleOf(row),
        label: String(row["label"] ?? ""),
        locked: row["locked"] === true,
        status: row["status"] === "revoked" ? "revoked" : "active",
        writtenAt: new Date(String(row["writtenAt"])).toISOString(),
      })),
    };
  });
}

/** A player's tap as the app sends it (FR-313, FR-621). */
export type Tap = Readonly<{
  playerId: string;
  /** The token of the `/t/` URL read from the tag. */
  code: string;
  /** The sticker's id, lower-case hex, or null when the phone sent none. */
  uid: string | null;
  /** The iPhone saying it cannot read the sticker's id (CTO A): the tap is paid, not checked, never flagged. */
  uidUnreadable: boolean;
  position: Position | null;
  idempotencyKey: string;
  deviceId: string | undefined;
}>;

/** A tap's answer: the completion, as a scan's, with the quest it completed. */
export type Tapped = Completed & Readonly<{ questId: string }>;

type TapRow = {
  completion_id: string;
  points: string;
  occurrence: number;
  score: string;
  balance: string;
  replayed: boolean;
  quest_id: string;
};

async function tapped(client: PoolClient, row: TapRow): Promise<Tapped> {
  return {
    completionId: row.completion_id,
    points: Number(row.points),
    occurrence: row.occurrence,
    score: Number(row.score),
    balance: Number(row.balance),
    replayed: row.replayed,
    levelUp: await levelReached(client, row.completion_id),
    bonus: await bonusPaid(client, row.completion_id),
    item: await itemGiven(client, row.completion_id),
    boost: await boostApplied(client, row.completion_id),
    firstBonus: await firstBonusPaid(client, row.completion_id),
    questId: row.quest_id,
  };
}

/**
 * A player taps a tag (FR-313): the API opens the tag's token (strict, constant time); `tap_quest` finds the tag and
 * completes its quest through the one door, writing the tap and its sticker check. A token that is not a Questify tag
 * is invalid_proof, logged apart (forged or not_questify, never the token).
 */
export async function tapTag(
  deps: NfcDeps,
  request: Tap,
  caller: Caller,
): Promise<NfcDone<Tapped>> {
  const held = await gate(deps, request.playerId, TAP_LIMIT);
  if (held !== undefined) {
    return held;
  }
  const opened = verifyTagCode(deps.tagKey, request.code);
  // Every tag is written at version 1: a signed token of another version was never issued, so it is refused as forged.
  if (opened.kind !== "valid" || opened.version !== 1) {
    caller.log("nfc.tap_refused", { reason: opened.kind === "valid" ? "forged" : opened.kind });
    return { kind: "invalid_proof" };
  }
  const result = await runNfc(deps.pool, { playerId: request.playerId }, async (client) => {
    const { rows } = await client.query<TapRow>("SELECT * FROM tap_quest($1, $2, $3, $4, $5, $6)", [
      opened.tagId,
      request.uid === null ? null : Buffer.from(request.uid, "hex"),
      request.uidUnreadable,
      request.idempotencyKey,
      request.deviceId ?? null,
      request.position,
    ]);
    return tapped(client, rows[0] as TapRow);
  });
  if (result.kind === "done") {
    caller.log("nfc.tapped", {
      questId: result.value.questId,
      replayed: String(result.value.replayed),
    });
  } else {
    caller.log("nfc.tap_refused", { reason: result.kind });
  }
  return result;
}
