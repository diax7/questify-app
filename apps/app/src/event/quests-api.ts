import type { LocalizedText } from "@questify/shared";
import type { AuthedResult, Session } from "#src/api/session.ts";
import type { Bilingual } from "#src/i18n/text.ts";

/**
 * Where a quest stands for this player, decided by the server (`questState` in `apps/api/src/home/home.ts`). A newer
 * server may send a state this app does not know (F-282): it is shown without an action, never refused.
 */
export type QuestState = "done" | "not_live" | "not_yet" | "closed" | "open" | (string & {});

/** A quest as `GET /v1/events/{id}/quests` gives it (T-113, T-114). */
export type Quest = Readonly<{
  id: string;
  title: Bilingual;
  description: Bilingual;
  /** A type this app version may not know (F-282): shown without an action. */
  type: string;
  points: number;
  repeatCap: number;
  opensAt: string | null;
  closesAt: string | null;
  /** How many times this player completed it. */
  done: number;
  /** The points this player earned from it, from the ledger. */
  earned: number;
  /** How it is verified (FR-301): `quest_qr` the printed code, `my_qr` staff scanning My QR. */
  verification: readonly string[];
  state: QuestState;
}>;

export type Category = Readonly<{ id: string; name: Bilingual; quests: readonly Quest[] }>;

export type QuestsView = Readonly<{
  event: Readonly<{ statusNow: string; timezone: string }>;
  categories: readonly Category[];
}>;

export type QuestsAnswer =
  | Readonly<{ kind: "quests"; view: QuestsView }>
  /** A pending member of a private event (403 `membership_pending`): waiting, and the event stays on the phone. */
  | Readonly<{ kind: "pending" }>
  | Readonly<{ kind: "gone" }>
  | Readonly<{ kind: "network" }>
  | Readonly<{ kind: "signed_out" }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isText = (value: unknown): value is Bilingual =>
  isRecord(value) &&
  (value["ar"] === null || typeof value["ar"] === "string") &&
  (value["en"] === null || typeof value["en"] === "string");

const isTime = (value: unknown) => value === null || typeof value === "string";

const NUMBERS = ["points", "repeatCap", "done", "earned"] as const;

const isQuest = (value: unknown): value is Quest =>
  isRecord(value) &&
  typeof value["id"] === "string" &&
  typeof value["type"] === "string" &&
  isText(value["title"]) &&
  isText(value["description"]) &&
  isTime(value["opensAt"]) &&
  isTime(value["closesAt"]) &&
  typeof value["state"] === "string" &&
  (value["verification"] === undefined ||
    (Array.isArray(value["verification"]) &&
      value["verification"].every((item) => typeof item === "string"))) &&
  NUMBERS.every((key) => typeof value[key] === "number");

const isCategory = (value: unknown): value is Category =>
  isRecord(value) &&
  typeof value["id"] === "string" &&
  isText(value["name"]) &&
  Array.isArray(value["quests"]) &&
  value["quests"].every(isQuest);

/** Checks the answer's shape, so a changed API shows "can't load" instead of a broken screen. */
/** An API from before T-205 sends no verification: a scan quest then has its printed code only. */
const withVerification = (quest: Quest): Quest =>
  (quest.verification as readonly string[] | undefined) === undefined
    ? { ...quest, verification: quest.type === "scan_qr" ? ["quest_qr"] : [] }
    : quest;

export function readQuests(body: unknown): QuestsView | undefined {
  if (!isRecord(body) || !isRecord(body["event"]) || !Array.isArray(body["categories"])) {
    return undefined;
  }
  const event = body["event"];
  return typeof event["statusNow"] === "string" &&
    typeof event["timezone"] === "string" &&
    body["categories"].every(isCategory)
    ? {
        event: { statusNow: event["statusNow"], timezone: event["timezone"] },
        categories: (body["categories"] as Category[]).map((category) => ({
          ...category,
          quests: category.quests.map(withVerification),
        })),
      }
    : undefined;
}

/**
 * As Home: only the server's definite answer (403 `not_enrolled` or 404) means this is no longer the player's event; a
 * pending member is told to wait and keeps it.
 */
export function questsAnswer(answer: AuthedResult): QuestsAnswer {
  if (answer.kind === "signed_out" || answer.kind === "network") {
    return { kind: answer.kind };
  }
  if (answer.kind === "error") {
    if (answer.code === "membership_pending") {
      return { kind: "pending" };
    }
    return { kind: answer.status === 403 || answer.status === 404 ? "gone" : "network" };
  }
  const view = readQuests(answer.body);
  return view === undefined ? { kind: "network" } : { kind: "quests", view };
}

export async function fetchQuests(
  session: Pick<Session, "request">,
  eventId: string,
): Promise<QuestsAnswer> {
  return questsAnswer(
    await session.request({
      method: "GET",
      path: `/v1/events/${encodeURIComponent(eventId)}/quests`,
    }),
  );
}

export type CategorySummary = Readonly<{
  earned: number;
  available: number;
  finished: number;
  total: number;
}>;

/**
 * A collapsed category's line (FR-230): points earned of those it can give, and quests finished of its quests. Earned
 * points are shown as they are: after the organizer lowers a quest's points they can pass the points available.
 */
export function categorySummary(category: Pick<Category, "quests">): CategorySummary {
  return category.quests.reduce(
    (sum, quest) => ({
      earned: sum.earned + quest.earned,
      available: sum.available + quest.points * quest.repeatCap,
      finished: sum.finished + (quest.state === "done" ? 1 : 0),
      total: sum.total + 1,
    }),
    { earned: 0, available: 0, finished: 0, total: 0 },
  );
}

/**
 * The categories open when the tab shows: the one holding the quest Home's Go named, else all of a one-category
 * event, else none.
 */
export function initiallyOpen(
  categories: readonly Category[],
  questId: string | undefined,
): string[] {
  const holder = categories.find((category) =>
    category.quests.some((quest) => quest.id === questId),
  );
  if (holder !== undefined) {
    return [holder.id];
  }
  return categories.length === 1 && categories[0] !== undefined ? [categories[0].id] : [];
}

/** A quest by id in the latest data, so an open sheet shows the newest state, or nothing once it is gone. */
export function findQuest(categories: readonly Category[], questId: string): Quest | undefined {
  return categories.flatMap((category) => category.quests).find((quest) => quest.id === questId);
}

/** The reasons `quest_not_open` gives (API.md). */
export type NotOpenReason = "event_not_live" | "hidden" | "not_started" | "ended" | "not_for_you";

const NOT_OPEN: readonly string[] = [
  "event_not_live",
  "hidden",
  "not_started",
  "ended",
  "not_for_you",
];

/**
 * What the sheet does with a completion's answer. Never `gone`: a 403 or 404 here is about the quest or the
 * enrollment, and the tab's own read decides whether the event is still the player's.
 */
export type CompletionAnswer =
  | Readonly<{ kind: "completed"; points: number; score: number; replayed: boolean }>
  /** A wrong code, in the API's own words. */
  | Readonly<{ kind: "wrong_code"; problem: LocalizedText | null }>
  | Readonly<{ kind: "not_open"; reason: NotOpenReason | undefined }>
  /** The quest's repeat cap is reached (FR-227). */
  | Readonly<{ kind: "limit" }>
  /** The quest or the membership changed meanwhile: close the sheet and read the tab again. */
  | Readonly<{ kind: "reload" }>
  | Readonly<{ kind: "wait"; seconds: number | null }>
  /** Any other answer from the server: try again, keeping the code. */
  | Readonly<{ kind: "failed" }>
  | Readonly<{ kind: "network" }>
  | Readonly<{ kind: "signed_out" }>;

function refusal(
  answer: Extract<AuthedResult, { kind: "error" }>,
): Exclude<CompletionAnswer, { kind: "completed" | "network" | "signed_out" }> {
  switch (answer.code) {
    case "invalid_code":
      return { kind: "wrong_code", problem: answer.message };
    case "quest_not_open": {
      const reason = String(answer.details["reason"]);
      return {
        kind: "not_open",
        reason: NOT_OPEN.includes(reason) ? (reason as NotOpenReason) : undefined,
      };
    }
    case "already_completed":
      return { kind: "limit" };
    case "enrollment_inactive":
    case "not_found":
      return { kind: "reload" };
    case "too_many_attempts": {
      const seconds = Number(answer.headers.get("retry-after"));
      return { kind: "wait", seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : null };
    }
    default:
      return answer.status === 404 ? { kind: "reload" } : { kind: "failed" };
  }
}

export function completionAnswer(answer: AuthedResult): CompletionAnswer {
  if (answer.kind === "signed_out" || answer.kind === "network") {
    return { kind: answer.kind };
  }
  if (answer.kind === "error") {
    return refusal(answer);
  }
  const body = isRecord(answer.body) ? answer.body : {};
  return typeof body["points"] === "number" && typeof body["score"] === "number"
    ? {
        kind: "completed",
        points: body["points"],
        score: body["score"],
        replayed: body["replayed"] === true,
      }
    : { kind: "failed" };
}

/** The last submission's key, its code, and whether only the network failed (the one case a key is reused). */
export type Attempt = Readonly<{ key: string; code: string; retryable: boolean }>;

/**
 * The Idempotency-Key for a submission: the last one again only to retry the same code after a network failure, so a
 * dropped answer never pays twice; any answer from the server, or another code, takes a new key (the API replays a
 * key's answer for 24 hours).
 */
export function keyFor(last: Attempt | undefined, code: string, makeKey: () => string): string {
  return last !== undefined && last.retryable && last.code === code ? last.key : makeKey();
}

/** How a completion is proven: a typed entry code (FR-202) or a scanned quest QR's token (FR-201). */
export type Proof =
  | Readonly<{ type: "code"; code: string }>
  | Readonly<{ type: "qr"; code: string }>;

/**
 * Completes a quest with its proof; the server normalizes a typed code (`normalizeEntryCode`) and verifies a token.
 * The key is the caller's, from `keyFor`.
 */
export async function completeQuest(
  session: Pick<Session, "request">,
  questId: string,
  proof: Proof,
  idempotencyKey: string,
): Promise<CompletionAnswer> {
  return completionAnswer(
    await session.request({
      method: "POST",
      path: `/v1/quests/${encodeURIComponent(questId)}/complete`,
      body: { proof },
      headers: { "idempotency-key": idempotencyKey },
    }),
  );
}
