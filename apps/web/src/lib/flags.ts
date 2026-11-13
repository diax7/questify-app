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
  kind:
    | "shared_device"
    | "burst"
    | "far_from_venue"
    | "impossible_speed"
    | "minigame"
    | "nfc_copy"
    | "device_integrity";
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
/** A failed device-integrity check (T-812): the platform and the server's reason codes, never a vendor payload. */
export type IntegrityLine = Readonly<{
  platform: "ios" | "android" | null;
  reasons: readonly string[];
  checkedAt: string | null;
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
    /** Device integrity: the platform and why the phone's check failed (T-812); null for every other kind. */
    integrity: IntegrityLine | null;
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
  nfc_copy: "flags.kind.nfcCopy",
} as const;

/**
 * What the list row says the case is: "Same phone, 2 accounts", "10 scans in a short time", "Far from the venue (3)",
 * "Moved impossibly fast (2)" or "Phone failed the integrity check".
 */
export function flagSummary(line: FlagLine): Readonly<{ key: MessageKey; count: number }> {
  if (line.kind === "device_integrity") {
    return { key: "flags.kind.deviceIntegrity", count: 0 };
  }
  return line.kind === "shared_device"
    ? { key: "flags.kind.sharedDevice", count: line.accounts ?? 2 }
    : { key: SCAN_KINDS[line.kind], count: line.scans ?? 0 };
}

/** The words for each reason code of a failed check, grouped by what the team can tell from it. */
const INTEGRITY_REASONS: Readonly<Record<string, MessageKey>> = {
  device: "flags.integrity.reason.device",
  app: "flags.integrity.reason.app",
  package: "flags.integrity.reason.otherApp",
  rp_id: "flags.integrity.reason.otherApp",
  nonce: "flags.integrity.reason.reused",
  stale: "flags.integrity.reason.reused",
  counter: "flags.integrity.reason.reused",
};

/** The lines a device-integrity case shows: the platform, then each reason once (an unknown code reads "unverified"). */
export function integrityNotes(line: IntegrityLine, t: Translate): readonly string[] {
  const platform =
    line.platform === null
      ? []
      : [t(line.platform === "ios" ? "flags.integrity.ios" : "flags.integrity.android")];
  const keys = line.reasons.map(
    (code) => INTEGRITY_REASONS[code] ?? "flags.integrity.reason.unverified",
  );
  return [...platform, ...[...new Set(keys)].map((key) => t(key))];
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

type Row = Record<string, unknown>;

const phoneAccountsOf = (evidence: readonly Row[]): Account[] =>
  evidence.map((row) => ({
    enrollmentId: String(row["enrollmentId"]),
    username: String(row["username"]),
    lastScanAt: text(row["lastScanAt"]),
  }));

const gameRoundsOf = (evidence: readonly Row[], language: Language): GameRoundLine[] =>
  evidence.map((row) => ({
    at: text(row["at"]),
    quest: named(row["questAr"], row["questEn"], language),
    game: String(row["game"] ?? ""),
    level: String(row["level"] ?? ""),
    reason: String(row["reason"] ?? ""),
    count: row["reason"] === "unlikely" ? unlikelyCount(row["result"]) : null,
  }));

const burstScansOf = (evidence: readonly Row[], language: Language): Scan[] =>
  evidence.map((row) => ({
    at: text(row["at"]),
    quest: named(row["questAr"], row["questEn"], language),
    operator: text(row["operator"]),
    method: text(row["method"]),
    distanceM: num(row["distanceM"]),
    accuracyM: num(row["accuracyM"]),
    mocked: typeof row["mocked"] === "boolean" ? row["mocked"] : null,
    gapM: num(row["gapM"]),
    seconds: num(row["seconds"]),
  }));

const waitingItemsOf = (value: unknown, language: Language): WaitingItem[] =>
  rows(value).map((row) => ({
    name: named(row["nameAr"], row["nameEn"], language),
    reservedUntil: text(row["reservedUntil"]),
  }));

const removalsOf = (value: unknown): Removal[] =>
  rows(value).map((row) => ({
    entryId: String(row["entryId"]),
    at: text(row["at"]),
    score: Math.abs(Number(row["score"] ?? 0)),
    reason: text(row["reason"]),
  }));

const integrityOf = (evidence: readonly Row[]): IntegrityLine | null => {
  const [row] = evidence;
  if (row === undefined) {
    return null;
  }
  const platform =
    row["platform"] === "ios" || row["platform"] === "android" ? row["platform"] : null;
  const reasons = Array.isArray(row["reasons"])
    ? row["reasons"].filter((code) => typeof code === "string")
    : [];
  return { platform, reasons, checkedAt: text(row["checkedAt"]) };
};

/**
 * A case's evidence read by its kind: a shared phone's accounts, a mini-game's rounds, a failed device check, otherwise
 * a burst's scans.
 */
function evidenceOf(
  flag: Row,
  language: Language,
): Pick<FlagDetail, "phoneAccounts" | "gameRounds" | "burstScans" | "integrity"> {
  const evidence = rows(flag["evidence"]);
  const sharedDevice = flag["kind"] === "shared_device";
  const minigame = flag["kind"] === "minigame";
  const integrity = flag["kind"] === "device_integrity";
  return {
    phoneAccounts: sharedDevice ? phoneAccountsOf(evidence) : [],
    gameRounds: minigame ? gameRoundsOf(evidence, language) : [],
    burstScans: sharedDevice || minigame || integrity ? [] : burstScansOf(evidence, language),
    integrity: integrity ? integrityOf(evidence) : null,
  };
}

/** Reads one case's answer; undefined when it is not one. */
export function flagDetailOf(body: unknown, language: Language): FlagDetail | undefined {
  const flag = isRecord(body) ? body["flag"] : undefined;
  if (!isRecord(flag) || typeof flag["id"] !== "string" || !isRecord(flag["player"])) {
    return undefined;
  }
  return {
    ...(flag as unknown as FlagLine),
    note: text(flag["note"]),
    resolvedBy: text(flag["resolvedBy"]),
    resolvedAt: text(flag["resolvedAt"]),
    enrollmentStatus: String(flag["enrollmentStatus"]),
    paused: flag["paused"] === true,
    ...evidenceOf(flag, language),
    waitingItems: waitingItemsOf(flag["waitingItems"], language),
    removals: removalsOf(flag["removals"]),
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
