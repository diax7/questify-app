import type { MessageKey } from "@questify/shared";

import { isRecord } from "#src/lib/is-record.ts";

/** What rehearsal wrote, or what an erase removed (T-211). */
export type RehearsalCounts = Readonly<{
  accounts: number;
  completions: number;
  points: number;
  reservations: number;
  flags: number;
}>;

/** The team's rehearsal card (GET …/events/{id}/rehearsal). */
export type RehearsalView = Readonly<{
  code: string | null;
  open: boolean;
  cap: number;
  now: RehearsalCounts;
  firstPlayAt: string | null;
  erasedAt: string | null;
  erased: RehearsalCounts | null;
  wipedAtGoLive: string | null;
}>;

const COUNT_KEYS = ["accounts", "completions", "points", "reservations", "flags"] as const;

const isTextOrNull = (value: unknown): value is string | null =>
  value === null || typeof value === "string";
const isCounts = (value: unknown): value is RehearsalCounts =>
  isRecord(value) && COUNT_KEYS.every((key) => typeof value[key] === "number");

const FIELD_CHECKS: Readonly<Record<keyof RehearsalView, (field: unknown) => boolean>> = {
  code: isTextOrNull,
  open: (field) => typeof field === "boolean",
  cap: (field) => typeof field === "number",
  now: isCounts,
  firstPlayAt: isTextOrNull,
  erasedAt: isTextOrNull,
  erased: (field) => field === null || isCounts(field),
  wipedAtGoLive: isTextOrNull,
};

/** Checks the API's answer, so a changed API shows the error state instead of a broken card. */
export function readRehearsal(value: unknown): RehearsalView | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const checks = Object.entries(FIELD_CHECKS);
  return checks.every(([key, valid]) => valid(value[key])) ? (value as RehearsalView) : undefined;
}

/** True when rehearsal wrote anything the go-live wipe will erase: the card then warns. */
export const holdsData = (counts: RehearsalCounts): boolean =>
  COUNT_KEYS.some((key) => counts[key] !== 0);

export type Line = Readonly<{
  key: MessageKey;
  params: Readonly<Record<string, string | number>>;
}>;

/**
 * The line about the last erase: at go-live (the change log's "Rehearsal data erased"), or by the team; none when
 * nothing was ever erased.
 */
export function erasedLine(view: RehearsalView): Line | undefined {
  if (view.erased === null) {
    return undefined;
  }
  const { accounts, completions, reservations } = view.erased;
  return {
    key: view.wipedAtGoLive === null ? "rehearsal.erased" : "rehearsal.wiped",
    params: { accounts, completions, reservations },
  };
}

export type RehearsalAction = "rotate" | "erase";

/** The card read from an API answer: nothing when the call failed or the answer is not a rehearsal card. */
export const rehearsalOf = (
  result: Readonly<{ ok: boolean; body: unknown }>,
): RehearsalView | undefined =>
  result.ok
    ? readRehearsal((result.body as { rehearsal?: unknown } | undefined)?.rehearsal)
    : undefined;

/** Where a confirmed action goes: Change code posts to `code`, Erase rehearsal to `erase`. */
export const rehearsalActionPath = (base: string, what: RehearsalAction): string =>
  `${base}/${what === "rotate" ? "code" : "erase"}`;

/** The confirmation's title and the action's button label (which also opens the confirmation). */
export const rehearsalWords = (
  what: RehearsalAction,
): Readonly<{ title: MessageKey; action: MessageKey }> =>
  what === "rotate"
    ? { title: "rehearsal.rotateConfirm", action: "rehearsal.rotate" }
    : { title: "rehearsal.eraseConfirm", action: "rehearsal.erase" };
