import type { MessageKey } from "@questify/shared";

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const isTextOrNull = (value: unknown): value is string | null =>
  value === null || typeof value === "string";
const isCounts = (value: unknown): value is RehearsalCounts =>
  isRecord(value) && COUNT_KEYS.every((key) => typeof value[key] === "number");

/** Checks the API's answer, so a changed API shows the error state instead of a broken card. */
export function readRehearsal(value: unknown): RehearsalView | undefined {
  if (
    !isRecord(value) ||
    !isTextOrNull(value["code"]) ||
    typeof value["open"] !== "boolean" ||
    typeof value["cap"] !== "number" ||
    !isCounts(value["now"]) ||
    !isTextOrNull(value["firstPlayAt"]) ||
    !isTextOrNull(value["erasedAt"]) ||
    !(value["erased"] === null || isCounts(value["erased"])) ||
    !isTextOrNull(value["wipedAtGoLive"])
  ) {
    return undefined;
  }
  return value as RehearsalView;
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
