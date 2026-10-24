import type { MessageKey } from "@questify/shared";

type Translate = (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string;

export type Who = Readonly<{ operator: string | null; staff: string | null }>;

/** One line of a player's points record (GET …/players/{id}/entries). */
export type LedgerLine = Readonly<{
  id: string;
  at: string;
  kind: string;
  scoreDelta: number;
  balanceDelta: number;
  questId: string | null;
  title: Readonly<{ ar: string | null; en: string | null }>;
  reason: string | null;
  by: Who;
  removable: boolean;
  removed: boolean;
}>;

/** One line of the event's award report (GET …/awards). */
export type ReportLine = Readonly<{
  id: string;
  at: string;
  kind: "quest" | "award" | "removal";
  points: number;
  /** `username` is null for a deleted account (T-217). */
  player: Readonly<{ enrollmentId: string; username: string | null }>;
  quest: Readonly<{ id: string; title: Readonly<{ ar: string | null; en: string | null }> }> | null;
  reason: string | null;
  bulkId: string | null;
  by: Who;
  removed: boolean;
}>;

const KINDS: Readonly<Record<string, MessageKey>> = {
  quest: "awards.kind.quest",
  award: "awards.kind.award",
  welcome: "awards.kind.welcome",
  redeem: "awards.kind.redeem",
  redeem_return: "awards.kind.redeemReturn",
  handover: "awards.kind.handover",
  removal: "awards.kind.removal",
  bonus: "awards.kind.bonus",
  community: "awards.kind.community",
};

/** The record's label for an entry kind; a kind this dashboard does not know reads as a balance change. */
export const kindKey = (kind: string): MessageKey => KINDS[kind] ?? "history.other";

/** Who made an entry: an operator's @username or a staff user's email; nobody for the player's own scans. */
export function whoOf(by: Who): string | null {
  if (by.operator !== null) {
    return `@${by.operator}`;
  }
  return by.staff;
}

/** A whole number of points from 1 to 100000 typed in a field, or undefined. */
export function pointsOf(typed: string): number | undefined {
  const value = Number(typed.trim());
  return Number.isInteger(value) && value >= 1 && value <= 100000 ? value : undefined;
}

/** A reason the API will take: 1 to 300 characters after trimming. */
export const reasonOk = (typed: string): boolean => {
  const length = typed.trim().length;
  return length >= 1 && length <= 300;
};

/**
 * The words for an over-the-cap answer (FR-310): the limit per award, or what is left today. Undefined for any other
 * answer, which keeps the API's own message.
 */
export function capProblem(body: unknown, t: Translate): string | undefined {
  if (typeof body !== "object" || body === null) {
    return undefined;
  }
  const { code, details } = body as {
    code?: unknown;
    details?: { cap?: unknown; limit?: unknown; left?: unknown };
  };
  if (code !== "over_cap" || details === undefined) {
    return undefined;
  }
  return details.cap === "day"
    ? t("awards.overDay", { left: Number(details.left) })
    : t("awards.overEach", { limit: Number(details.limit) });
}
