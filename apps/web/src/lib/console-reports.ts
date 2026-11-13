import {
  flagsAnswerSchema,
  type CHEAT_FLAG_KINDS,
  type MessageKey,
  reportDetailSchema,
  reportQueueSchema,
  type FlagsAnswer,
  type Language,
  type ReportDetail,
  type ReportKind,
  type ReportOutcome,
  type ReportQueue,
  type ReportSnapshot,
} from "@questify/shared";

/** The words of each flag kind and each outcome (message keys are camel case, the API's codes snake case). */
export const FLAG_KIND_KEYS = {
  shared_device: "console.flags.kind.sharedDevice",
  burst: "console.flags.kind.burst",
  far_from_venue: "console.flags.kind.farFromVenue",
  impossible_speed: "console.flags.kind.impossibleSpeed",
  minigame: "console.flags.kind.minigame",
  nfc_copy: "console.flags.kind.nfcCopy",
  device_integrity: "console.flags.kind.deviceIntegrity",
} as const satisfies Record<(typeof CHEAT_FLAG_KINDS)[number], MessageKey>;
export const OUTCOME_KEYS = {
  dismissed: "console.report.outcome.dismissed",
  unpublished: "console.report.outcome.unpublished",
  event_suspended: "console.report.outcome.eventSuspended",
  username_changed: "console.report.outcome.usernameChanged",
  player_banned: "console.report.outcome.playerBanned",
} as const satisfies Record<ReportOutcome, MessageKey>;

/** The console's moderation queue, unpublish and flags (T-705b; FR-1404, FR-1414). */
export const REPORTS_API = "/v1/admin/reports";
export const HOLDS_API = "/v1/admin/holds";
export const RELEASE_HOLD_API = `${HOLDS_API}/release`;
export const FLAGS_API = "/v1/admin/flags";

/** The queue, optionally of one kind. */
export const queuePath = (kind: ReportKind | ""): string =>
  kind === "" ? REPORTS_API : `${REPORTS_API}?kind=${kind}`;

/** One target's reports. */
export const targetPath = (kind: ReportKind, targetId: string): string =>
  `${REPORTS_API}/${kind}/${targetId}`;

export const resolvePath = (kind: ReportKind, targetId: string): string =>
  `${targetPath(kind, targetId)}/resolve`;

/** The console page of one target. */
export const targetPage = (language: Language, kind: ReportKind, targetId: string): string =>
  `/${language}/console/reports/${kind}/${targetId}`;

export const REPORT_COUNTS_API = `${REPORTS_API}/counts`;
export const MODERATION_ADDRESSES_API = "/v1/admin/moderation-addresses";

/** How far a due time is from now, as minutes under two hours and hours from there; `late` once it passed. */
export function dueDistance(
  dueAt: string,
  now: number,
): Readonly<{ late: boolean; unit: "minutes" | "hours"; count: number }> {
  const minutes = Math.round((new Date(dueAt).getTime() - now) / 60_000);
  const size = Math.abs(minutes);
  return size >= 120
    ? { late: minutes < 0, unit: "hours", count: Math.round(size / 60) }
    : { late: minutes < 0, unit: "minutes", count: size };
}

/** The console menu's counts (`GET /v1/admin/reports/counts`), or undefined for another shape. */
export function readReportCounts(
  body: unknown,
): Readonly<{ open: number; urgent: number }> | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const { open, urgent } = body as Record<string, unknown>;
  return typeof open === "number" && typeof urgent === "number" ? { open, urgent } : undefined;
}

/** Each reader answers undefined when the body is not the expected shape, so a changed API shows the error state. */
export function readQueue(body: unknown): ReportQueue | undefined {
  const parsed = reportQueueSchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

export function readDetail(body: unknown): ReportDetail | undefined {
  const parsed = reportDetailSchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

export function readFlags(body: unknown): FlagsAnswer | undefined {
  const parsed = flagsAnswerSchema.safeParse(body);
  return parsed.success ? parsed.data : undefined;
}

/** A pair of texts in the reader's language, or the other one when it has only that one; "" when it has none. */
export function inLanguage(
  pair: Readonly<{ ar?: string | undefined; en?: string | undefined }> | undefined,
  language: Language,
): string {
  const other: Language = language === "ar" ? "en" : "ar";
  return pair?.[language] ?? pair?.[other] ?? "";
}

/** What a snapshot is called in a list: its title, or @username for a player. */
export function snapshotLabel(snapshot: ReportSnapshot | null, language: Language): string {
  if (snapshot === null) {
    return "";
  }
  return snapshot.username === undefined
    ? inLanguage(snapshot.title, language)
    : `@${snapshot.username}`;
}

/**
 * The outcomes the console offers for a kind, after its own action: Unpublish closes the reports itself, so a held kind
 * offers only Dismiss; a username is changed or banned on the player's record; the rest are handled by suspending the
 * event.
 */
export function outcomesFor(kind: ReportKind): readonly ReportOutcome[] {
  if (kind === "username") {
    return ["username_changed", "player_banned", "dismissed"];
  }
  if (kind === "quest" || kind === "reward" || kind === "announcement" || kind === "media") {
    return ["dismissed"];
  }
  return ["event_suspended", "dismissed"];
}
