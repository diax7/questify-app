import { formatNumber, type Language, type MessageKey } from "@questify/shared";
import type { Translate } from "#src/lib/language.ts";

/** One case as the list answers it (`GET …/flags`, FR-335). */
export type FlagLine = Readonly<{
  id: string;
  kind: "shared_device" | "burst" | "far_from_venue" | "impossible_speed";
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
/**
 * One scan of a case. The location fields (T-303b) are rounded distances and the reading's accuracy, never
 * coordinates: `distanceM` from the venue, `gapM` from the previous placed quest, `seconds` since it (null for the
 * first).
 */
export type Scan = Readonly<{
  at: string | null;
  quest: string;
  operator: string | null;
  /** How it was completed, as the API names it (`meet_scan`, `meet_shown`, …), or null. */
  method: string | null;
  distanceM: number | null;
  accuracyM: number | null;
  mocked: boolean | null;
  gapM: number | null;
  seconds: number | null;
}>;
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
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const rows = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

/** A bilingual name in the page's language, the other one when that is missing. */
const named = (ar: unknown, en: unknown, language: Language): string =>
  (language === "ar" ? (text(ar) ?? text(en)) : (text(en) ?? text(ar))) ?? "";

const SCAN_KINDS = {
  burst: "flags.kind.burst",
  far_from_venue: "flags.kind.farFromVenue",
  impossible_speed: "flags.kind.impossibleSpeed",
} as const;

/**
 * What the list row says the case is: "Same phone, 2 accounts", "10 scans within 5 minutes", "Far from the venue (3)"
 * or "Moved impossibly fast (2)".
 */
export function flagSummary(line: FlagLine): Readonly<{ key: MessageKey; count: number }> {
  return line.kind === "shared_device"
    ? { key: "flags.kind.sharedDevice", count: line.accounts ?? 2 }
    : { key: SCAN_KINDS[line.kind], count: line.scans ?? 0 };
}

/** A distance in words: metres under a kilometre, else kilometres to one decimal ("2.4 km"). Western digits. */
export function lengthText(metres: number, language: Language, t: Translate): string {
  return metres < 1000
    ? t("flags.metres", { n: formatNumber(metres, language) })
    : t("flags.kilometres", { n: formatNumber(Math.round(metres / 100) / 10, language) });
}

/**
 * The location lines under a scan of a far-from-venue or impossible-speed case (FR-331, FR-332): how far from the
 * venue and how precise the reading, whether the phone reported a fake location, or how far apart two spots were and
 * how fast they were reached. Other kinds and readings without the numbers say nothing.
 */
export function locationNotes(
  kind: FlagLine["kind"],
  scan: Scan,
  language: Language,
  t: Translate,
): readonly string[] {
  if (kind === "far_from_venue") {
    const far =
      scan.distanceM === null || scan.accuracyM === null
        ? []
        : [
            t("flags.far", {
              distance: lengthText(scan.distanceM, language, t),
              accuracy: formatNumber(scan.accuracyM, language),
            }),
          ];
    return scan.mocked === true ? [...far, t("flags.mocked")] : far;
  }
  if (kind === "impossible_speed" && scan.gapM !== null && scan.seconds !== null) {
    return [
      t("flags.speed", {
        gap: lengthText(scan.gapM, language, t),
        seconds: formatNumber(scan.seconds, language),
      }),
    ];
  }
  return [];
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
          method: text(row["method"]),
          distanceM: num(row["distanceM"]),
          accuracyM: num(row["accuracyM"]),
          mocked: typeof row["mocked"] === "boolean" ? row["mocked"] : null,
          gapM: num(row["gapM"]),
          seconds: num(row["seconds"]),
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

/** The label a case line gets for a meeting's side (T-303c): scanned or shown; null for every other method. */
export function methodLabel(
  method: string | null,
): "flags.method.meetScan" | "flags.method.meetShown" | null {
  if (method === "meet_scan") {
    return "flags.method.meetScan";
  }
  return method === "meet_shown" ? "flags.method.meetShown" : null;
}
