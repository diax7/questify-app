import type { MessageKey } from "@questify/shared";
import { decodeBase64Url } from "#src/event/scan.ts";

const TOKEN = /^[A-Za-z0-9_-]{50}$/;

/**
 * The operator invite token in a scanned or opened link (T-204): the dashboard's `https://{host}/{ar|en}/op#{token}`
 * (a personal QR or an invite email) or the web page's app link `questify://operator-invite/{token}`. Null for
 * anything else. The host is not checked: the server's signature decides, and a forged token only gets "not valid".
 */
export function inviteTokenOf(text: string): string | null {
  const trimmed = text.trim();
  const web = /^https:\/\/[A-Za-z0-9.-]+\/(?:ar|en)\/op#([^#\s]+)$/.exec(trimmed)?.[1];
  const app = /^questify:\/\/operator-invite\/([^/?#\s]+)$/.exec(trimmed)?.[1];
  const token = web ?? app;
  return token !== undefined && TOKEN.test(token) ? token : null;
}

/**
 * The operator invite a signed-out person opened before signing in (FR-903), carried to sign-in as a route param and
 * opened again when sign-in ends; anything that is not a token's shape is dropped.
 */
export function pendingInviteOf(params: Readonly<Record<string, unknown>>): string | undefined {
  const invite = params["invite"];
  return typeof invite === "string" && TOKEN.test(invite) ? invite : undefined;
}

/** A My QR is its bare token (ADR-137): the station sends anything that has its shape and lets the server judge. */
export function isPlayerCode(text: string): boolean {
  return TOKEN.test(text.trim());
}

/** Why the station shows red (API.md, `POST /v1/operator/scan`; `going_live` from a practice scan only). */
const RED_REASONS = [
  "invalid_code",
  "old_code",
  "not_in_event",
  "enrollment_inactive",
  "quest_not_open",
  "quest_not_found",
  "ability_off",
  "outside_station",
  "self_scan",
  "operator_not_playing",
  "wrong_method",
  "going_live",
] as const;
type RedReason = (typeof RED_REASONS)[number];

export type ScannedPlayer = Readonly<{ username: string; avatar: string }>;

/** What the full-screen result shows (FR-924): its colour, its words and who was scanned. */
export type StationResult =
  /** `bonusPoints`: a practice scan would also earn the first-N bonus (T-313); null otherwise. */
  | Readonly<{
      color: "green";
      points: number;
      player: ScannedPlayer | null;
      bonusPoints: number | null;
    }>
  | Readonly<{ color: "orange"; player: ScannedPlayer | null }>
  | Readonly<{ color: "red"; reason: MessageKey; player: ScannedPlayer | null }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const playerOf = (value: unknown): ScannedPlayer | null =>
  isRecord(value) && typeof value["username"] === "string" && typeof value["avatar"] === "string"
    ? { username: value["username"], avatar: value["avatar"] }
    : null;

const camel = (value: string) =>
  value.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());

/** The scan's answer as the station shows it; undefined for a body this app cannot read. */
export function stationResult(body: unknown): StationResult | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  const player = playerOf(body["player"]);
  switch (body["result"]) {
    case "completed":
      return typeof body["points"] === "number"
        ? {
            color: "green",
            points: body["points"],
            player,
            bonusPoints: typeof body["bonusPoints"] === "number" ? body["bonusPoints"] : null,
          }
        : undefined;
    case "already_completed":
      return { color: "orange", player };
    case "refused": {
      // A reason a newer server adds is still red, in the general words.
      const reason = RED_REASONS.includes(body["reason"] as RedReason)
        ? (body["reason"] as RedReason)
        : "invalid_code";
      return { color: "red", reason: `operator.red.${camel(reason)}` as MessageKey, player };
    }
    default:
      return undefined;
  }
}

/** The same code at the same station within this time is the camera reading it again, not a new scan. */
export const REPEAT_MS = 5000;

export type LastScan = Readonly<{ code: string; questId: string; at: number }> | null;

/**
 * FR-923 with a fixed My QR: a code held up stays one scan until it leaves for 5 seconds or the station changes. The
 * window slides: the caller refreshes `at` on every repeat read (`held`), so a phone held up for a minute is one scan.
 */
export function isRepeat(last: LastScan, code: string, questId: string, now: number): boolean {
  return (
    last !== null && last.code === code && last.questId === questId && now - last.at < REPEAT_MS
  );
}

/** One key per code and station until the server gives a definite answer: a retry after a lost reply never pays twice. */
export type Attempt = Readonly<{ code: string; questId: string; key: string }> | null;

/** What the station remembers between camera reads: the mode it was in, the last code and its key. */
export type ScanMemory = Readonly<{ practice: boolean; last: LastScan; attempt: Attempt }>;

/**
 * The memory for a read in this mode. A mode change forgets the last code (CTO plan review, MAJOR-1): a code still in
 * front of the camera after leaving practice is scanned again, for real, and paid; one practised after a real scan is
 * practised. The pending key stays (CTO code review, MINOR-1): a real scan whose reply was lost keeps its key across a
 * toggle, so its retry replays rather than pays twice; a key made in practice never reached the server.
 */
export function memoryIn(memory: ScanMemory, practice: boolean): ScanMemory {
  return memory.practice === practice ? memory : { ...memory, practice, last: null };
}

/**
 * The key a scan of this code sends, and the memory after sending it. A real scan reuses its pending key for the same
 * code and station; a practice scan sends no key and leaves a real scan's pending key alone (CTO code review, MINOR-1).
 */
export function attemptFor(
  memory: ScanMemory,
  scan: Readonly<{ code: string; questId: string }>,
  fresh: () => string,
): Readonly<{ memory: ScanMemory; key: string }> {
  if (memory.practice) {
    return { memory, key: "" };
  }
  const prior = memory.attempt;
  const key = prior?.code === scan.code && prior.questId === scan.questId ? prior.key : fresh();
  return { memory: { ...memory, attempt: { ...scan, key } }, key };
}

/** The memory after a definite answer: a real scan's key is done; a practice answer settles no real key. */
export function answered(memory: ScanMemory): ScanMemory {
  return memory.practice ? memory : { ...memory, attempt: null };
}

/** The last scan after a repeat read: the same scan, seen again now (the window slides). */
export function held(last: NonNullable<LastScan>, now: number): NonNullable<LastScan> {
  return { ...last, at: now };
}

/** The player a My QR names (format 0x02, ADR-137), read on the phone only to match a cached code to its account. */
export function playerOfCode(token: string): string | null {
  const bytes = TOKEN.test(token) ? decodeBase64Url(token) : null;
  if (bytes === null || bytes.length !== 37 || bytes[0] !== 0x02) {
    return null;
  }
  const hex = Array.from(bytes.subarray(1, 17), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
