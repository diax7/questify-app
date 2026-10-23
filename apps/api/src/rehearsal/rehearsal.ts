import { createHash, randomInt } from "node:crypto";

/** The letters and digits a rehearsal code uses: no I, O, 0 or 1, which read alike (ADR-158). */
export const REHEARSAL_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** The most rehearsal accounts one event may have (`rehearsal_cap()`, migration 0032). */
export const REHEARSAL_CAP = 25;

/** A new code; `pick` returns a whole number from 0 below its bound (crypto's by default). */
export function newRehearsalCode(pick: (bound: number) => number = randomInt): string {
  const chars = Array.from(
    { length: 8 },
    () => REHEARSAL_ALPHABET[pick(REHEARSAL_ALPHABET.length)] ?? "",
  );
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

/**
 * The code a digital reward shows in rehearsal (ADR-159): derived from the reservation, the same on every view, never
 * a real code. The database's comment gives the same rule: 'TEST-' || upper(substr(md5(id::text), 1, 8)).
 */
export function testCode(redemptionId: string): string {
  const digest = createHash("md5").update(redemptionId).digest("hex");
  return `TEST-${digest.slice(0, 8).toUpperCase()}`;
}

/** Why a team action on the rehearsal was refused, by the definer's SQLSTATE (migration 0032). */
export type RehearsalRefusal = "not_found" | "over" | "not_opened";

const REFUSALS: Readonly<Record<string, RehearsalRefusal>> = {
  AN404: "not_found",
  RR409: "over",
  RR404: "not_opened",
};

/** The refusal a database error stands for, or undefined when it is not one of ours. */
export function rehearsalRefusalOf(error: unknown): RehearsalRefusal | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && Object.hasOwn(REFUSALS, code) ? REFUSALS[code] : undefined;
}

/** What the wipe removed (migration 0032's `erase_counts`). */
export type RehearsalCounts = Readonly<{
  accounts: number;
  completions: number;
  points: number;
  reservations: number;
  flags: number;
}>;

/** The team's rehearsal card: the code (null after go-live), what rehearsal holds now, and the last erase. */
export type RehearsalCard = Readonly<{
  code: string | null;
  /** True while the team can still rehearse: a Draft or Scheduled event that has not gone live. */
  open: boolean;
  cap: number;
  now: RehearsalCounts;
  firstPlayAt: string | null;
  erasedAt: string | null;
  erased: RehearsalCounts | null;
  wipedAtGoLive: string | null;
}>;

export type CardRow = Readonly<{
  code: string | null;
  status_now: string;
  accounts: number;
  completions: number;
  points: string;
  reservations: number;
  flags: number;
  first_play_at: Date | null;
  erased_at: Date | null;
  erase_counts: Record<string, unknown> | null;
  live_wiped_at: Date | null;
}>;

const count = (value: unknown): number => {
  const read = Number(value);
  return Number.isFinite(read) ? read : 0;
};

/** The counts from the wipe's JSON, each a number (a missing one reads as 0). */
export function countsOf(json: Record<string, unknown>): RehearsalCounts {
  return {
    accounts: count(json["accounts"]),
    completions: count(json["completions"]),
    points: count(json["points"]),
    reservations: count(json["reservations"]),
    flags: count(json["flags"]),
  };
}

/** True while the team may rehearse: before go-live and not yet wiped at it. */
export const isOpen = (row: CardRow): boolean =>
  (row.status_now === "draft" || row.status_now === "scheduled") && row.live_wiped_at === null;

export function cardOf(row: CardRow): RehearsalCard {
  const open = isOpen(row);
  return {
    code: open ? row.code : null,
    open,
    cap: REHEARSAL_CAP,
    now: {
      accounts: row.accounts,
      completions: row.completions,
      points: Number(row.points),
      reservations: row.reservations,
      flags: row.flags,
    },
    firstPlayAt: row.first_play_at?.toISOString() ?? null,
    erasedAt: row.erased_at?.toISOString() ?? null,
    erased: row.erase_counts === null ? null : countsOf(row.erase_counts),
    wipedAtGoLive: row.live_wiped_at?.toISOString() ?? null,
  };
}
