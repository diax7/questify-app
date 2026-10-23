import {
  GAME_LEVEL_KEYS,
  GAME_NAME_KEYS,
  formatNumber,
  type Language,
  type MessageKey,
} from "@questify/shared";
import type { Translate } from "#src/lib/language.ts";

/** One case as the list answers it (`GET …/flags`, FR-335). */
export type FlagLine = Readonly<{
  id: string;
  kind: "shared_device" | "burst" | "far_from_venue" | "impossible_speed" | "minigame";
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
/**
 * One mini-game round of a case (T-305): when, the quest, the game and level, and why it was flagged (the replay's
 * reason, `clock`, or `unlikely` for a paid round). Never the inputs: the server does not keep them.
 */
export type GameRoundLine = Readonly<{
  at: string | null;
  quest: string;
  game: string;
  level: string;
  reason: string;
  /** For an unlikely round, the count that tripped it (T-305c): lucky matches, foreseen catches or quick hits. */
  count?: Readonly<{ key: MessageKey; n: number }> | null;
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
    /** Mini-game: each flagged round, oldest first (T-305). */
    gameRounds: readonly GameRoundLine[];
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
  minigame: "flags.kind.minigame",
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
  const minigame = flag["kind"] === "minigame";
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
    gameRounds: minigame
      ? evidence.map((row) => ({
          at: text(row["at"]),
          quest: named(row["questAr"], row["questEn"], language),
          game: String(row["game"] ?? ""),
          level: String(row["level"] ?? ""),
          reason: String(row["reason"] ?? ""),
          count: row["reason"] === "unlikely" ? unlikelyCount(row["result"]) : null,
        }))
      : [],
    burstScans:
      sharedDevice || minigame
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

const GAME_REASONS: Readonly<Record<string, MessageKey>> = {
  malformed: "flags.game.reason.malformed",
  order: "flags.game.reason.order",
  too_fast: "flags.game.reason.tooFast",
  late: "flags.game.reason.late",
  cap: "flags.game.reason.cap",
  illegal: "flags.game.reason.illegal",
  claimed: "flags.game.reason.claimed",
  clock: "flags.game.reason.clock",
  unlikely: "flags.game.reason.unlikely",
};

/** The counts an unlikely round's result may carry, by game: memory's lucky matches, catch's foresight, tap speed. */
const UNLIKELY_COUNTS: ReadonlyArray<readonly [string, MessageKey]> = [
  ["lucky", "flags.game.count.lucky"],
  ["foreseen", "flags.game.count.foreseen"],
  ["quick", "flags.game.count.quick"],
];

/** The count that made a paid round unlikely, read from its stored result; null when it has none. */
export function unlikelyCount(result: unknown): Readonly<{ key: MessageKey; n: number }> | null {
  if (!isRecord(result)) {
    return null;
  }
  for (const [field, key] of UNLIKELY_COUNTS) {
    const n = result[field];
    if (typeof n === "number") {
      return { key, n };
    }
  }
  return null;
}

/**
 * A flagged round in words (T-305): "10:42: Treasure hunt (Memory match, Hard)" and why, when this dashboard knows the
 * reason; a game, level or reason from a newer server shows as sent.
 */
export function gameRoundText(
  round: GameRoundLine,
  date: string,
  t: Translate,
): Readonly<{ line: string; reason: string | null }> {
  const game = Object.hasOwn(GAME_NAME_KEYS, round.game)
    ? t(GAME_NAME_KEYS[round.game as keyof typeof GAME_NAME_KEYS])
    : round.game;
  const level = Object.hasOwn(GAME_LEVEL_KEYS, round.level)
    ? t(GAME_LEVEL_KEYS[round.level as keyof typeof GAME_LEVEL_KEYS])
    : round.level;
  const reason = GAME_REASONS[round.reason];
  const count =
    round.count === undefined || round.count === null
      ? ""
      : ` (${t(round.count.key, { n: formatNumber(round.count.n, "en") })})`;
  return {
    line: t("flags.game.line", { date, quest: round.quest, game, level }),
    reason: reason === undefined ? null : `${t(reason)}${count}`,
  };
}
