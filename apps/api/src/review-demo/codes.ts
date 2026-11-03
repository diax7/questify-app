import { createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { QR_QUEST_TYPES, meetCodeOf } from "@questify/shared";
import type { AuthKeys } from "#src/auth/keys";
import { BUCKETS } from "#src/auth/throttle";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { heldBack, type PlayerLimit } from "#src/plays/limits";
import { MEET_LIMITS } from "#src/plays/meet";
import {
  questCode,
  questCodeUrl,
  revealCode,
  stepCode,
  tagCode,
  tagCodeUrl,
  type QuestCodeKey,
  type RevealCodeKey,
  type StepCodeKey,
  type TagCodeKey,
} from "#src/quests/qr";
import type { Bilingual } from "#src/quests/store";

/** What signs the picker's codes: the keys and the address a printed sticker or a written tag carries. */
export type ReviewCodeDeps = Readonly<{
  pool: Pool;
  keys: Pick<AuthKeys, "playerKey">;
  codeKey: QuestCodeKey;
  stepKey: StepCodeKey;
  revealKey: RevealCodeKey;
  tagKey: TagCodeKey;
  origin: string;
}>;

export type ReviewCodeKind = "quest" | "step" | "reveal" | "tag" | "meet";

/**
 * One printable code of the demo event (ADR-565): what the app feeds to its scanner. `url` is the signed address a
 * sticker or a tag holds; a meet quest has none, its code is issued on demand (`reviewMeetCode`).
 */
export type ReviewCode = Readonly<{
  kind: ReviewCodeKind;
  id: string;
  questId: string | null;
  title: Bilingual;
  label: Bilingual | null;
  url: string | null;
}>;

/** RD404 is every refusal of the caller rule: not the reviewer, not the demo event, the window closed, not a member. */
export type ReviewRefusal =
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "none_left" }>
  | Readonly<{ kind: "feature_off" }>
  | Readonly<{ kind: "too_many_attempts"; retryAfterSeconds: number }>;

export type ReviewOutcome<T> = Readonly<{ kind: "done"; value: T }> | ReviewRefusal;

type CodeRow = Readonly<{
  kind: ReviewCodeKind;
  id: string;
  version: number;
  quest_id: string | null;
  title_ar: string | null;
  title_en: string | null;
  label_ar: string | null;
  label_en: string | null;
}>;

/** The database's refusals of the three doors (migration 0147); anything else is thrown on. */
const REFUSALS: Readonly<Record<string, ReviewRefusal>> = {
  RD404: { kind: "not_found" },
  QT422: { kind: "not_found" },
  RD409: { kind: "none_left" },
  QF403: { kind: "feature_off" },
};

async function asCaller<T>(
  pool: Pool,
  playerId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<ReviewOutcome<T>> {
  try {
    const value = await withConnection(pool, (client) =>
      withRequestContext(client, { playerId }, () => work(client)),
    );
    return { kind: "done", value };
  } catch (error) {
    const refusal = REFUSALS[(error as { code?: string }).code ?? ""];
    if (refusal === undefined) {
      throw error;
    }
    return refusal;
  }
}

function urlOf(deps: ReviewCodeDeps, row: CodeRow): string | null {
  switch (row.kind) {
    case "quest":
      return questCodeUrl(deps.origin, questCode(deps.codeKey, row.id, row.version));
    case "step":
      return questCodeUrl(deps.origin, stepCode(deps.stepKey, row.id, row.version));
    case "reveal":
      return questCodeUrl(deps.origin, revealCode(deps.revealKey, row.id, row.version));
    case "tag":
      return tagCodeUrl(deps.origin, tagCode(deps.tagKey, row.id, row.version));
    default:
      return null;
  }
}

/**
 * Home's `reviewDemo: true` while the caller is the reviewer in this event and the window is open; nothing (no key at
 * all) for anyone else.
 */
export async function reviewDemoFlag(
  client: PoolClient,
  eventId: string,
): Promise<Readonly<{ reviewDemo?: true }>> {
  const { rows } = await client.query<{ here: boolean }>("SELECT review_demo_here($1) AS here", [
    eventId,
  ]);
  return rows[0]?.here === true ? { reviewDemo: true } : {};
}

/**
 * The demo event's printable codes for the reviewer's picker (T-710b, FR-303's review half, FR-1407): the database
 * decides who may read them (`review_demo_codes`, RD404 to anyone else), and they are signed here with the keys a printed
 * sticker uses. Nothing new completes anything: the app feeds a picked code to the scanner's own handler.
 */
export function listReviewCodes(
  deps: ReviewCodeDeps,
  playerId: string,
  eventId: string,
): Promise<ReviewOutcome<ReviewCode[]>> {
  return asCaller(deps.pool, playerId, async (client) => {
    const { rows } = await client.query<CodeRow>("SELECT * FROM review_demo_codes($1, $2)", [
      eventId,
      QR_QUEST_TYPES,
    ]);
    return rows.map((row) => ({
      kind: row.kind,
      id: row.id,
      questId: row.quest_id,
      title: { ar: row.title_ar, en: row.title_en },
      label:
        row.label_ar === null && row.label_en === null
          ? null
          : { ar: row.label_ar, en: row.label_en },
      url: urlOf(deps, row),
    }));
  });
}

const PASS_LIMIT: PlayerLimit = { bucket: BUCKETS.meetPass, ...MEET_LIMITS.passesPerPlayer };

/**
 * A one-minute meet code shown by one of the demo's fictional players (`review_demo_meet_code`), so the reviewer can
 * play a meet quest with one phone; held to the meet-pass limit of the caller. The database keeps only the token's hash.
 */
export async function reviewMeetCode(
  deps: ReviewCodeDeps,
  request: Readonly<{ playerId: string; eventId: string; questId: string }>,
): Promise<ReviewOutcome<Readonly<{ code: string; expiresAt: string }>>> {
  const wait = await heldBack(deps, request.playerId, PASS_LIMIT, true);
  if (wait !== undefined) {
    return { kind: "too_many_attempts", retryAfterSeconds: wait };
  }
  const token = randomBytes(16).toString("base64url");
  return asCaller(deps.pool, request.playerId, async (client) => {
    const { rows } = await client.query<{ expires_at: Date }>(
      "SELECT expires_at FROM review_demo_meet_code($1, $2, $3)",
      [request.eventId, request.questId, createHash("sha256").update(token).digest()],
    );
    const expiresAt = (rows[0] as { expires_at: Date }).expires_at;
    return { code: meetCodeOf(token), expiresAt: expiresAt.toISOString() };
  });
}
