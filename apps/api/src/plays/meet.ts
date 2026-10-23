import { createHash, randomBytes } from "node:crypto";
import type { PoolClient } from "pg";
import { meetCodeOf, meetTokenOf } from "@questify/shared";
import type { AuthKeys } from "#src/auth/keys";
import type { Caller } from "#src/auth/sign-in";
import { BUCKETS } from "#src/auth/throttle";
import type { Position } from "#src/completions/complete";
import { heldBack, type PlayerLimit } from "#src/plays/limits";
import { paidOf, run, type Done, type Paid, type PlayDeps } from "#src/plays/run";
import type { SettingsService } from "#src/settings/service";

export type MeetDeps = PlayDeps &
  Readonly<{ keys: AuthKeys; settings: Pick<SettingsService, "forEvent"> }>;

/**
 * The limits of meet-someone (T-303c), per player: codes shown, code states read while one is on screen (the app polls
 * every 2 seconds), and refused scans (a script trying codes).
 */
export const MEET_LIMITS = {
  passesPerPlayer: { max: 30, windowSeconds: 600 },
  stateReadsPerPlayer: { max: 60, windowSeconds: 60 },
  refusedScansPerPlayer: { max: 20, windowSeconds: 600 },
} as const;

/** Why a meeting was refused (migration 0049's QM codes). */
export type MeetReason =
  | "bad_code"
  | "expired"
  | "used"
  | "self"
  | "same_device"
  | "already_met"
  | "daily_cap"
  | "their_daily_cap"
  | "done"
  | "their_done"
  | "not_in_event"
  | "not_for_them";

const REASONS: ReadonlySet<string> = new Set<MeetReason>([
  "bad_code",
  "expired",
  "used",
  "self",
  "same_device",
  "already_met",
  "daily_cap",
  "their_daily_cap",
  "done",
  "their_done",
  "not_in_event",
  "not_for_them",
]);

/** A meet refusal: its reason, the other's username for already_met, the cap for daily_cap. */
export type MeetRefusal = Readonly<{
  kind: "meet_refused";
  reason: MeetReason;
  name: string | null;
  cap: number | null;
}>;

export type MeetOutcome<T> =
  | Done<T>
  | MeetRefusal
  | Readonly<{ kind: "too_many_attempts"; retryAfterSeconds: number }>;

/** A code the shown player's app draws: its text, its id for polling and when it runs out. */
export type MeetPass = Readonly<{ code: string; passId: string; expiresAt: string }>;

/** What the shown player's screen polls: open, expired, or used with who scanned it and the points they got. */
export type MeetPassState = Readonly<{
  state: "open" | "expired" | "used";
  met: Readonly<{ username: string; avatar: string; points: number }> | null;
}>;

/** What the scanner is answered: the completion, the quest and the other player's public name (never their id). */
export type Met = Paid &
  Readonly<{
    occurrence: number;
    questId: string;
    met: Readonly<{ username: string; avatar: string }>;
  }>;

/** The shown player's side, for the ranking update only: never sent to the scanner (CTO 9). */
export type OtherSide = Readonly<{ playerId: string; completionId: string }>;

/** The token's hash, as the database keeps it. */
const hashOf = (token: string): Buffer => createHash("sha256").update(token).digest();

/** A QM refusal from the database, or undefined for any other error. */
function meetRefusalOf(error: unknown): MeetRefusal | undefined {
  const pg = error as { code?: string; detail?: string; hint?: string };
  if (!["QM422", "QM409", "QM403"].includes(pg.code ?? "") || !REASONS.has(pg.detail ?? "")) {
    return undefined;
  }
  const reason = pg.detail as MeetReason;
  const cap = Number.parseInt(pg.hint ?? "", 10);
  return {
    kind: "meet_refused",
    reason,
    name: reason === "already_met" ? (pg.hint ?? null) : null,
    cap: reason === "daily_cap" && Number.isFinite(cap) ? cap : null,
  };
}

/** Runs one call as the player; a meet refusal becomes its result, the play refusals as `run` maps them. */
async function asPlayer<T>(
  deps: PlayDeps,
  playerId: string,
  work: (client: PoolClient) => Promise<T>,
): Promise<MeetOutcome<T>> {
  try {
    return await run(deps, { playerId }, work);
  } catch (error) {
    const refusal = meetRefusalOf(error);
    if (refusal === undefined) {
      throw error;
    }
    return refusal;
  }
}

/** Whether the platform's `meetSomeone` switch is on; the event's own switch is the database's (`meet_on`). */
export async function meetPlatformOn(
  settings: Pick<SettingsService, "forEvent">,
): Promise<boolean> {
  const config = await settings.forEvent(undefined);
  return config.kind === "ok" && config.config.features["meetSomeone"]?.enabled !== false;
}

const PASS_LIMIT: PlayerLimit = { bucket: BUCKETS.meetPass, ...MEET_LIMITS.passesPerPlayer };
const STATE_LIMIT: PlayerLimit = { bucket: BUCKETS.meetState, ...MEET_LIMITS.stateReadsPerPlayer };
const REFUSED_LIMIT: PlayerLimit = {
  bucket: BUCKETS.meetRefused,
  ...MEET_LIMITS.refusedScansPerPlayer,
};

/**
 * Shows a fresh meet code for the player (ADR-209): a 128-bit random token, of which the database keeps only the hash.
 * Refused while the platform's switch is off, past the per-player limit, or as `issue_meet_pass` refuses.
 */
export async function issueMeetPass(
  deps: MeetDeps,
  request: Readonly<{ playerId: string; questId: string; deviceId: string | undefined }>,
): Promise<MeetOutcome<MeetPass>> {
  if (!(await meetPlatformOn(deps.settings))) {
    return { kind: "feature_off" };
  }
  const wait = await heldBack(deps, request.playerId, PASS_LIMIT, true);
  if (wait !== undefined) {
    return { kind: "too_many_attempts", retryAfterSeconds: wait };
  }
  const token = randomBytes(16).toString("base64url");
  return asPlayer(deps, request.playerId, async (client) => {
    const { rows } = await client.query<{ pass_id: string; expires_at: Date }>(
      "SELECT * FROM issue_meet_pass($1, $2, $3)",
      [request.questId, hashOf(token), request.deviceId ?? null],
    );
    const row = rows[0] as { pass_id: string; expires_at: Date };
    return {
      code: meetCodeOf(token),
      passId: row.pass_id,
      expiresAt: row.expires_at.toISOString(),
    };
  });
}

/** The player's own code's state; another player's code reads as not found. */
export async function meetPassState(
  deps: MeetDeps,
  request: Readonly<{ playerId: string; passId: string }>,
): Promise<MeetOutcome<MeetPassState>> {
  const wait = await heldBack(deps, request.playerId, STATE_LIMIT, true);
  if (wait !== undefined) {
    return { kind: "too_many_attempts", retryAfterSeconds: wait };
  }
  const read = await asPlayer(deps, request.playerId, async (client) => {
    const { rows } = await client.query<{
      state: "open" | "expired" | "used";
      username: string | null;
      avatar: string | null;
      points: string | null;
    }>("SELECT * FROM meet_pass_state($1)", [request.passId]);
    return rows[0];
  });
  if (read.kind !== "done") {
    return read;
  }
  const row = read.value;
  if (row === undefined) {
    return { kind: "not_found" };
  }
  return {
    kind: "done",
    value: {
      state: row.state,
      met:
        row.state === "used" && row.username !== null
          ? { username: row.username, avatar: row.avatar ?? "falcon", points: Number(row.points) }
          : null,
    },
  };
}

type MetRow = Readonly<{
  completion_id: string;
  points: string;
  occurrence: number;
  score: string;
  balance: string;
  replayed: boolean;
  quest_id: string;
  other_completion: string;
  other_player: string;
  other_username: string;
  other_avatar: string;
}>;

export type MeetRequest = Readonly<{
  playerId: string;
  /** The scanned text: a meet code, or anything else (refused as bad_code). */
  code: string;
  idempotencyKey: string;
  deviceId: string | undefined;
  /** The scanner's well-formed reading, or null; passed on only while location quests are on. */
  position: Position | null;
}>;

/** Whether a refusal counts against the scanner's refused-scan limit: anything the scanner could retry by script. */
const counted = (result: MeetOutcome<unknown>): boolean => result.kind === "meet_refused";

/**
 * The player scanned another's meet code (FR-212, FR-213): both are paid by `meet_player` (migration 0049) in one
 * transaction, or neither. The answer names the other player by username and avatar only; their id and completion
 * come back apart, for the ranking update. Refused scans are held to a per-player limit; the token is never logged.
 */
export async function meetPlayer(
  deps: MeetDeps,
  request: MeetRequest,
  caller: Caller,
): Promise<MeetOutcome<Readonly<{ answer: Met; other: OtherSide }>>> {
  if (!(await meetPlatformOn(deps.settings))) {
    return { kind: "feature_off" };
  }
  const wait = await heldBack(deps, request.playerId, REFUSED_LIMIT, false);
  if (wait !== undefined) {
    return { kind: "too_many_attempts", retryAfterSeconds: wait };
  }
  const token = meetTokenOf(request.code);
  const result: MeetOutcome<Readonly<{ answer: Met; other: OtherSide }>> =
    token === undefined
      ? { kind: "meet_refused", reason: "bad_code", name: null, cap: null }
      : await asPlayer(deps, request.playerId, async (client) => {
          const { rows } = await client.query<MetRow>("SELECT * FROM meet_player($1, $2, $3, $4)", [
            hashOf(token),
            request.idempotencyKey,
            request.deviceId ?? null,
            request.position,
          ]);
          const row = rows[0] as MetRow;
          const paid = await paidOf(client, [row]);
          return {
            answer: {
              ...paid,
              occurrence: row.occurrence,
              questId: row.quest_id,
              met: { username: row.other_username, avatar: row.other_avatar },
            },
            other: { playerId: row.other_player, completionId: row.other_completion },
          };
        });
  if (counted(result)) {
    await heldBack(deps, request.playerId, REFUSED_LIMIT, true);
  }
  caller.log(result.kind === "done" ? "meet.met" : "meet.refused", {
    refusal: result.kind,
    reason: result.kind === "meet_refused" ? result.reason : result.kind,
    replayed: result.kind === "done" ? String(result.value.answer.replayed) : "",
  });
  return result;
}
