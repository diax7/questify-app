import type { Language, MessageKey } from "@questify/shared";

/** One case as the list answers it (`GET …/flags`, FR-335). */
export type FlagLine = Readonly<{
  id: string;
  kind: "shared_device" | "burst";
  status: "open" | "cleared" | "confirmed";
  resolution: "cleared" | "points_removed" | "banned" | null;
  raisedAt: string | null;
  player: Readonly<{ enrollmentId: string; username: string }>;
  accounts: number | null;
  scans: number | null;
  waiting: number;
}>;

export type Account = Readonly<{
  enrollmentId: string;
  username: string;
  lastScanAt: string | null;
}>;
export type Scan = Readonly<{ at: string | null; quest: string; operator: string | null }>;
export type WaitingItem = Readonly<{ name: string; reservedUntil: string | null }>;
export type Removal = Readonly<{
  entryId: string;
  at: string | null;
  score: number;
  reason: string | null;
}>;

/** One case opened (`GET …/flags/{id}`), its evidence read for the page's language. */
export type FlagDetail = FlagLine &
  Readonly<{
    note: string | null;
    resolvedBy: string | null;
    resolvedAt: string | null;
    enrollmentStatus: string;
    paused: boolean;
    /** Same phone: the event's accounts seen on it. */
    phoneAccounts: readonly Account[];
    /** Burst: each scan, oldest first. */
    burstScans: readonly Scan[];
    waitingItems: readonly WaitingItem[];
    removals: readonly Removal[];
  }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const rows = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

/** A bilingual name in the page's language, the other one when that is missing. */
const named = (ar: unknown, en: unknown, language: Language): string =>
  (language === "ar" ? (text(ar) ?? text(en)) : (text(en) ?? text(ar))) ?? "";

/** What the list row says the case is: "Same phone, 2 accounts" or "10 scans within 5 minutes". */
export function flagSummary(line: FlagLine): Readonly<{ key: MessageKey; count: number }> {
  return line.kind === "shared_device"
    ? { key: "flags.kind.sharedDevice", count: line.accounts ?? 2 }
    : { key: "flags.kind.burst", count: line.scans ?? 0 };
}

/** How a closed case ended, in words. */
export function resolutionKey(resolution: FlagLine["resolution"]): MessageKey {
  if (resolution === "points_removed") {
    return "flags.resolution.pointsRemoved";
  }
  return resolution === "banned" ? "flags.resolution.banned" : "flags.resolution.cleared";
}

/** Reads one case's answer; undefined when it is not one. */
export function flagDetailOf(body: unknown, language: Language): FlagDetail | undefined {
  const flag = isRecord(body) ? body["flag"] : undefined;
  if (!isRecord(flag) || typeof flag["id"] !== "string" || !isRecord(flag["player"])) {
    return undefined;
  }
  const evidence = rows(flag["evidence"]);
  const sharedDevice = flag["kind"] === "shared_device";
  return {
    ...(flag as unknown as FlagLine),
    note: text(flag["note"]),
    resolvedBy: text(flag["resolvedBy"]),
    resolvedAt: text(flag["resolvedAt"]),
    enrollmentStatus: String(flag["enrollmentStatus"]),
    paused: flag["paused"] === true,
    phoneAccounts: sharedDevice
      ? evidence.map((row) => ({
          enrollmentId: String(row["enrollmentId"]),
          username: String(row["username"]),
          lastScanAt: text(row["lastScanAt"]),
        }))
      : [],
    burstScans: sharedDevice
      ? []
      : evidence.map((row) => ({
          at: text(row["at"]),
          quest: named(row["questAr"], row["questEn"], language),
          operator: text(row["operator"]),
        })),
    waitingItems: rows(flag["waitingItems"]).map((row) => ({
      name: named(row["nameAr"], row["nameEn"], language),
      reservedUntil: text(row["reservedUntil"]),
    })),
    removals: rows(flag["removals"]).map((row) => ({
      entryId: String(row["entryId"]),
      at: text(row["at"]),
      score: Math.abs(Number(row["score"] ?? 0)),
      reason: text(row["reason"]),
    })),
  };
}
