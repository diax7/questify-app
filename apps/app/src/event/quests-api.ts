import { isQuestType, type LocalizedText } from "@questify/shared";
import { noteCompletion } from "#src/questify/completion-signal.ts";
import { levelUpOf, type LevelUp } from "#src/questify/level.ts";
import type { AuthedResult, Session } from "#src/api/session.ts";
import type { Bilingual } from "#src/i18n/text.ts";
import type { Position } from "#src/event/location.ts";
import { lockNoteOf, sameLock, type CommunityLock } from "#src/event/unlock.ts";
import {
  firstBonusPaidOf,
  questFirstBonusOf,
  type FirstBonusPaid,
  type QuestFirstBonus,
} from "#src/event/first-bonus.ts";

/**
 * Where a quest stands for this player, decided by the server (`questState` in `apps/api/src/home/home.ts`). A newer
 * server may send a state this app does not know (F-282): it is shown without an action, never refused.
 */
export type QuestState =
  | "done"
  | "not_live"
  | "locked"
  | "not_yet"
  | "closed"
  | "open"
  | (string & {});

/**
 * Why a quest is shut: a community goal not yet reached (T-306c), or its category (T-304): not opened yet, waiting on
 * another category, or in order. A lock this build does not know is read as none and shows "Locked" (F-282).
 */
export type QuestLock =
  | "community_locked"
  | "category_not_started"
  | "category_locked"
  | "order_locked";

const LOCKS: readonly string[] = [
  "community_locked",
  "category_not_started",
  "category_locked",
  "order_locked",
];

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
  /** How many times this player completed it, in its category's current day or week when it refreshes (T-304c). */
  done: number;
  /** The points this player earned from it, from the ledger. */
  earned: number;
  /** How it is verified (FR-301): `quest_qr` the printed code, `my_qr` staff scanning My QR. */
  verification: readonly string[];
  state: QuestState;
  /** Why its category keeps it shut, when its state is `locked`; null otherwise or from an older API. */
  lock: QuestLock | null;
  /** A passport's progress (T-304b): steps stamped of those it needs; null for other types or an older API. */
  steps: Readonly<{ done: number; needed: number }> | null;
  /** The item its first completion still gives while stock is left (T-304d); null for none or an older API. */
  item: Bilingual | null;
  /** A location quest's spot (T-303b); null for other types, a malformed one or an older API. */
  place: Readonly<{ lat: number; lng: number; radiusM: number }> | null;
  /** A meet quest's daily cap and this player's meetings today (T-303c); null for other types or an older API. */
  meet: Readonly<{ dailyCap: number; today: number }> | null;
  /** A game quest's attempts left (null when unlimited) and whether it passed (T-305); null for other types. */
  game: Readonly<{ attemptsLeft: number | null; passed: boolean }> | null;
  /** The community goal holding it shut, its category's included (T-306c); null when free or from an older API. */
  communityLock: CommunityLock | null;
  /** A flash quest's end (T-307): it is listed only inside its window; null for any other quest or an older API. */
  flash: Readonly<{ closesAt: string }> | null;
  /** The boost doubling its category now (T-307); null when none or from an older API. */
  boost: RunningBoost | null;
  /** Its first-N bonus (T-313): the ribbon's `left` follows `/live`; null when none or from an older API. */
  firstBonus: QuestFirstBonus | null;
}>;

/** A boost in force (T-307): the quest pays its points times `multiplier` until `endsAt`. */
export type RunningBoost = Readonly<{ multiplier: number; endsAt: string }>;

/** A running boost as sent, or null for anything missing or not well formed. */
export function runningBoostOf(value: unknown): RunningBoost | null {
  return isRecord(value) &&
    typeof value["multiplier"] === "number" &&
    typeof value["endsAt"] === "string"
    ? { multiplier: value["multiplier"], endsAt: value["endsAt"] }
    : null;
}

/** The boost a payment was made with (T-307): `points` already holds the multiplied amount. */
export type Boosted = Readonly<{ multiplier: number }>;

/** The boost in a payment's answer, or null when there is none, it is not well formed, or the API is older. */
export function boostedOf(value: unknown): Boosted | null {
  return isRecord(value) && typeof value["multiplier"] === "number" && value["multiplier"] > 1
    ? { multiplier: value["multiplier"] }
    : null;
}

/**
 * Whether a quest of a type this app version does not know still offers its printed QR (F-282): a type added after this
 * build that keeps a quest QR completes by scanning it.
 */
export const scanFallback = (quest: Pick<Quest, "type" | "state" | "verification">): boolean =>
  quest.state === "open" && !isQuestType(quest.type) && quest.verification.includes("quest_qr");

/** A category's rules (T-304, FR-231 to FR-235); an older API sends none, read as no rules. */
export type CategoryRules = Readonly<{
  orderMode: "any" | "in_order";
  opensAt: string | null;
  unlockAfter: Readonly<{ id: string; name: Bilingual }> | null;
  /** settled: paid, or since removed or withheld; a settled bonus is never paid again, so it is not promised. */
  bonus: Readonly<{ points: number; earned: number; settled: boolean; item: Bilingual | null }>;
  /** How often its quests start again (T-304c, FR-236); `resetsAt` is the next start, null for none. */
  refresh: "none" | "daily" | "weekly";
  resetsAt: string | null;
  /** The community goal locking the category as a whole (T-306c), shown once as its note; null when free. */
  communityLock: CommunityLock | null;
  /** The boost doubling the category now (T-307); null when none or from an older API. */
  boost: RunningBoost | null;
}>;

export type Category = Readonly<{ id: string; name: Bilingual; quests: readonly Quest[] }> &
  CategoryRules;

/**
 * A quest item a payment gave (FR-522) or missed (FR-1617, T-304d): `pending` waits at the prize desk;
 * `out_of_stock` and `claim_closed` paid the points only.
 */
export type ItemGiven = Readonly<{
  name: Bilingual;
  outcome: ItemOutcome;
  /** A pending item's claim deadline and the event's zone; it may be the desk's closing soon (ADR-205). */
  until: Readonly<{ at: string; timeZone: string }> | null;
}>;

export type ItemOutcome = "pending" | "out_of_stock" | "claim_closed";

const OUTCOMES: readonly string[] = ["pending", "out_of_stock", "claim_closed"];

/** The item in a payment's answer, or null when there is none or it is not well formed (a newer outcome too). */
export function itemGivenOf(value: unknown): ItemGiven | null {
  return isRecord(value) && isText(value["name"]) && OUTCOMES.includes(String(value["outcome"]))
    ? {
        name: value["name"],
        outcome: value["outcome"] as ItemOutcome,
        until: untilOf(value["until"]),
      }
    : null;
}

function untilOf(value: unknown): ItemGiven["until"] {
  return isRecord(value) && typeof value["at"] === "string" && typeof value["timeZone"] === "string"
    ? { at: value["at"], timeZone: value["timeZone"] }
    : null;
}

/** A category's completion bonus, paid with the completion that finished it (FR-231): points (0 for item only). */
export type Bonus = Readonly<{ points: number; category: Bilingual; item: ItemGiven | null }>;

/** The bonus in a payment's answer, or null when there is none or it is not well formed. */
export function bonusOf(value: unknown): Bonus | null {
  return isRecord(value) && typeof value["points"] === "number" && isText(value["category"])
    ? { points: value["points"], category: value["category"], item: itemGivenOf(value["item"]) }
    : null;
}

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

/** An API from before T-205 sends no verification: a scan quest then has its printed code only. */
const withVerification = (quest: Quest): Quest => ({
  ...quest,
  verification:
    (quest.verification as readonly string[] | undefined) === undefined
      ? quest.type === "scan_qr"
        ? ["quest_qr"]
        : []
      : quest.verification,
  lock: LOCKS.includes(String(quest.lock)) ? quest.lock : null,
  steps: progressOf(quest.steps),
  item: isText(quest.item) ? quest.item : null,
  place: placeOf(quest.place),
  meet: meetOf(quest.meet),
  game: gameOf(quest.game),
  communityLock: lockNoteOf(quest.communityLock),
  flash: flashOf(quest.flash),
  boost: runningBoostOf(quest.boost),
  firstBonus: questFirstBonusOf(quest.firstBonus),
});

/** A flash quest's end as sent, or null for anything missing or not well formed. */
function flashOf(value: unknown): Quest["flash"] {
  return isRecord(value) && typeof value["closesAt"] === "string"
    ? { closesAt: value["closesAt"] }
    : null;
}

/** A game quest's attempts and pass as sent, or null for anything missing or not well formed. */
function gameOf(value: unknown): Quest["game"] {
  return isRecord(value) &&
    typeof value["passed"] === "boolean" &&
    (value["attemptsLeft"] === null || typeof value["attemptsLeft"] === "number")
    ? { attemptsLeft: value["attemptsLeft"] as number | null, passed: value["passed"] }
    : null;
}

/** A meet quest's caps as sent, or null for anything missing or not well formed. */
function meetOf(value: unknown): Quest["meet"] {
  return isRecord(value) &&
    typeof value["dailyCap"] === "number" &&
    typeof value["today"] === "number"
    ? { dailyCap: value["dailyCap"], today: value["today"] }
    : null;
}

/** A location quest's spot as sent, or null for anything missing or not well formed. */
function placeOf(value: unknown): Quest["place"] {
  return isRecord(value) &&
    typeof value["lat"] === "number" &&
    typeof value["lng"] === "number" &&
    typeof value["radiusM"] === "number"
    ? { lat: value["lat"], lng: value["lng"], radiusM: value["radiusM"] }
    : null;
}

/** A passport's progress as sent, or null for anything missing or not well formed. */
function progressOf(value: unknown): Quest["steps"] {
  return isRecord(value) && typeof value["done"] === "number" && typeof value["needed"] === "number"
    ? { done: value["done"], needed: value["needed"] }
    : null;
}

/** A category's rules as sent, or none for anything missing or not well formed (an older API). */
function rulesOf(category: Record<string, unknown>): CategoryRules {
  const unlock = category["unlockAfter"];
  const bonus = isRecord(category["bonus"]) ? category["bonus"] : {};
  return {
    orderMode: category["orderMode"] === "in_order" ? "in_order" : "any",
    opensAt: typeof category["opensAt"] === "string" ? category["opensAt"] : null,
    unlockAfter:
      isRecord(unlock) && typeof unlock["id"] === "string" && isText(unlock["name"])
        ? { id: unlock["id"], name: unlock["name"] }
        : null,
    bonus: {
      points: typeof bonus["points"] === "number" ? bonus["points"] : 0,
      earned: typeof bonus["earned"] === "number" ? bonus["earned"] : 0,
      settled: bonus["settled"] === true,
      item: isText(bonus["item"]) ? bonus["item"] : null,
    },
    refresh:
      category["refresh"] === "daily" || category["refresh"] === "weekly"
        ? category["refresh"]
        : "none",
    resetsAt: typeof category["resetsAt"] === "string" ? category["resetsAt"] : null,
    communityLock: lockNoteOf(category["communityLock"]),
    boost: runningBoostOf(category["boost"]),
  };
}

/** Checks the answer's shape, so a changed API shows "can't load" instead of a broken screen. */

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
          ...rulesOf(category),
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

/** What a category's header says of its rules (T-304), in this order. */
export type CategoryNote =
  | Readonly<{ kind: "community"; note: CommunityLock }>
  | Readonly<{ kind: "opens"; at: string }>
  | Readonly<{ kind: "unlockAfter"; name: Bilingual }>
  | Readonly<{ kind: "inOrder" }>
  | Readonly<{ kind: "bonus"; points: number }>
  | Readonly<{ kind: "bonusEarned"; points: number }>
  | Readonly<{ kind: "bonusItem"; name: Bilingual }>
  | Readonly<{ kind: "resets"; refresh: "daily" | "weekly"; at: string }>;

/**
 * A category header's notes: the community goal locking it as a whole (T-306c), first; when it opens and which
 * category unlocks it, while that keeps its quests shut; that it is played in order; when it resets (T-304c); and its
 * completion bonus, or the bonus earned; nothing for a bonus settled with nothing kept.
 */
export function categoryNotes(category: Category): CategoryNote[] {
  const locks = new Set(category.quests.map((quest) => quest.lock));
  const notes: CategoryNote[] =
    category.communityLock === null ? [] : [{ kind: "community", note: category.communityLock }];
  if (locks.has("category_not_started") && category.opensAt !== null) {
    notes.push({ kind: "opens", at: category.opensAt });
  }
  if (locks.has("category_locked") && category.unlockAfter !== null) {
    notes.push({ kind: "unlockAfter", name: category.unlockAfter.name });
  }
  if (category.orderMode === "in_order") {
    notes.push({ kind: "inOrder" });
  }
  if (category.refresh !== "none" && category.resetsAt !== null) {
    notes.push({ kind: "resets", refresh: category.refresh, at: category.resetsAt });
  }
  if (category.bonus.earned > 0) {
    notes.push({ kind: "bonusEarned", points: category.bonus.earned });
  } else if (category.bonus.points > 0 && !category.bonus.settled) {
    notes.push({ kind: "bonus", points: category.bonus.points });
  }
  if (category.bonus.item !== null && !category.bonus.settled) {
    notes.push({ kind: "bonusItem", name: category.bonus.item });
  }
  return notes;
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

/**
 * The community lock a quest's own line names: its own, not its category's (that one is the category's note, said
 * once); null otherwise.
 */
export function ownCommunityLock(
  quest: Pick<Quest, "communityLock">,
  category: Pick<Category, "communityLock">,
): CommunityLock | null {
  return quest.communityLock === null || sameLock(quest.communityLock, category.communityLock)
    ? null
    : quest.communityLock;
}

/** A quest by id in the latest data, so an open sheet shows the newest state, or nothing once it is gone. */
export function findQuest(categories: readonly Category[], questId: string): Quest | undefined {
  return categories.flatMap((category) => category.quests).find((quest) => quest.id === questId);
}

/** The reasons `quest_not_open` gives (API.md), with a category's locks (T-304). */
export type NotOpenReason =
  | "event_not_live"
  | "hidden"
  | "not_started"
  | "ended"
  | "not_for_you"
  | QuestLock;

const NOT_OPEN: readonly string[] = [
  "event_not_live",
  "hidden",
  "not_started",
  "ended",
  "not_for_you",
  ...LOCKS,
];

/**
 * What the sheet does with a completion's answer. Never `gone`: a 403 or 404 here is about the quest or the
 * enrollment, and the tab's own read decides whether the event is still the player's.
 */
export type CompletionAnswer =
  | Readonly<{
      kind: "completed";
      points: number;
      score: number;
      replayed: boolean;
      /** The Questify level this completion reached first (T-401), or null. */
      levelUp: LevelUp | null;
      /** The category bonus this completion paid (T-304), or null. */
      bonus: Bonus | null;
      /** The quest item this completion gave or missed (T-304d), or null. */
      item: ItemGiven | null;
      /** The boost that doubled it (T-307), or null. */
      boost: Boosted | null;
      /** The first-N bonus it earned, or missed when `place` is null (T-313); null when none. */
      firstBonus: FirstBonusPaid | null;
    }>
  /** A check-in refused for its position (T-303b); `distanceM` is the player's own rounded distance for not_here. */
  | Readonly<{
      kind: "location_refused";
      reason: LocationReason | undefined;
      distanceM: number | null;
    }>
  /** The platform's location switch is off: the QR is the way in (ADR-208). */
  | Readonly<{ kind: "location_off" }>
  /** A wrong code, in the API's own words. */
  | Readonly<{ kind: "wrong_code"; problem: LocalizedText | null }>
  /**
   * A meeting refused (T-303c): `reason` as the API says it (undefined for one this build does not know), the other's
   * username for already_met, the cap for daily_cap.
   */
  | Readonly<{
      kind: "meet_refused";
      reason: MeetReason | undefined;
      name: string | null;
      cap: number | null;
    }>
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

/** Why a meeting was refused (API.md `meet_refused`), and `off` while the event's meet quests are switched off. */
export type MeetReason =
  | "bad_code"
  | "expired"
  | "used"
  | "self"
  | "same_device"
  | "already_met"
  | "daily_cap"
  | "their_daily_cap"
  | "done"
  | "their_done"
  | "not_in_event"
  | "not_for_them"
  | "off";

const MEET_REASONS: readonly string[] = [
  "bad_code",
  "expired",
  "used",
  "self",
  "same_device",
  "already_met",
  "daily_cap",
  "their_daily_cap",
  "done",
  "their_done",
  "not_in_event",
  "not_for_them",
];

/** Why the server refused a check-in (API.md `location_refused`). */
export type LocationReason = "no_position" | "bad_position" | "stale" | "imprecise" | "not_here";

const LOCATION_REASONS: readonly string[] = [
  "no_position",
  "bad_position",
  "stale",
  "imprecise",
  "not_here",
];

function refusal(
  answer: Extract<AuthedResult, { kind: "error" }>,
): Exclude<CompletionAnswer, { kind: "completed" | "network" | "signed_out" }> {
  switch (answer.code) {
    case "location_refused": {
      const reason = String(answer.details["reason"]);
      const distance = answer.details["distanceM"];
      return {
        kind: "location_refused",
        reason: LOCATION_REASONS.includes(reason) ? (reason as LocationReason) : undefined,
        distanceM: typeof distance === "number" ? distance : null,
      };
    }
    case "feature_off":
      return { kind: "location_off" };
    case "meet_refused": {
      const reason = String(answer.details["reason"]);
      const name = answer.details["name"];
      const cap = answer.details["cap"];
      return {
        kind: "meet_refused",
        reason: MEET_REASONS.includes(reason) ? (reason as MeetReason) : undefined,
        name: typeof name === "string" ? name : null,
        cap: typeof cap === "number" ? cap : null,
      };
    }
    case "invalid_code":
    case "code_expired":
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
  if (typeof body["points"] !== "number" || typeof body["score"] !== "number") {
    return { kind: "failed" };
  }
  const replayed = body["replayed"] === true;
  // Every completion flow (scan, typed code, games, meeting, passport, NFC) ends here: the sync debounce starts once.
  if (!replayed) noteCompletion();
  return {
    kind: "completed",
    points: body["points"],
    score: body["score"],
    replayed,
    levelUp: levelUpOf(body["levelUp"]),
    bonus: bonusOf(body["bonus"]),
    item: itemGivenOf(body["item"]),
    boost: boostedOf(body["boost"]),
    firstBonus: firstBonusPaidOf(body["firstBonus"]),
  };
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

/**
 * How a completion is proven: a typed entry code (FR-202), a scanned quest QR's token (FR-201), a station's rotating
 * code (FR-314) or a location check-in (FR-215). A scan may carry the last known position (T-303b); a check-in carries its fresh one.
 */
export type Proof =
  | Readonly<{ type: "code"; code: string; position?: Position }>
  | Readonly<{ type: "qr"; code: string; position?: Position }>
  /** A station's rotating code (T-309): judged by the server against its 30-second window. */
  | Readonly<{ type: "screen"; code: string; position?: Position }>
  | Readonly<{ type: "location"; position: Position }>;

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
