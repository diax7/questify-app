import { LiveEditError, type LiveEditRefusal } from "#src/quests/live-edits";
import {
  PLACED_QUEST_TYPES,
  QUEST_TYPES,
  isLivePoll,
  parseQuestConfig,
  parseVerification,
  toInstant,
  unavailableSubmissionKind,
  type FirstBonusInput,
  type QuestType,
} from "@questify/shared";
import type { Pool, PoolClient } from "pg";
import { recordAudit } from "#src/audit/record";
import type { Caller } from "#src/auth/sign-in";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { Actor } from "#src/events/events";
import { builderBonusOf, readFirstBonuses, type BuilderFirstBonus } from "#src/quests/first-bonus";
import { sentOrKept } from "#src/quests/kept";
import {
  listCategories,
  listQuests,
  lockBuilderEvent,
  type Bilingual,
  type BuilderEvent,
  type CategoryRecord,
  type QuestFields,
  type QuestPlace,
  type QuestRecord,
} from "#src/quests/store";
import { teamSeat } from "#src/organizers/store";

/** Caps per event (T-103 plan, decision 9). */
export const BUILDER_LIMITS = { categories: 30, quests: 300 } as const;

type Text = Readonly<{ ar?: string | undefined; en?: string | undefined }>;

/** A category's name and rules; times as the event's wall clock (`YYYY-MM-DDTHH:mm`), null clears one. */
export type CategoryInput = Readonly<{
  name?: Text | undefined;
  orderMode?: "any" | "in_order" | undefined;
  opensAt?: string | null | undefined;
  unlockAfter?: string | null | undefined;
  completionBonus?: number | undefined;
  refresh?: "none" | "daily" | "weekly" | undefined;
  hidden?: boolean | undefined;
  /** The quest item its bonus gives (T-304d); null clears it. */
  itemId?: string | null | undefined;
}>;

export type CategoryField = "name" | "to" | "opensAt" | "unlockAfter" | "refresh";

/** Times as the event's wall clock (`YYYY-MM-DDTHH:mm`), read in its zone; null clears one. */
export type QuestInput = Readonly<{
  categoryId?: string | undefined;
  title?: Text | undefined;
  description?: Text | undefined;
  points?: number | undefined;
  repeatCap?: number | undefined;
  opensAt?: string | null | undefined;
  closesAt?: string | null | undefined;
  visible?: boolean | undefined;
  config?: unknown;
  verification?: unknown;
  /** A passport's steps as the full list in order (T-304b): an existing step by its id, a new one without. */
  steps?: readonly Readonly<{ id?: string | undefined; name: Text }>[] | undefined;
  /** The quest item its first completion gives (T-304d); null clears it. */
  itemId?: string | null | undefined;
  /** Its place on a spot type (T-303b); null clears it; a location quest must keep one. */
  place?: QuestPlace | null | undefined;
  /** Shown to players only inside its window (T-307): launched from a draft, or scheduled with both times. */
  flash?: boolean | undefined;
  /** The first-N bonus (T-313): set, stop or switch off (null); left out, it stays as it is. */
  firstBonus?: FirstBonusInput | undefined;
}>;

export type QuestField =
  | "categoryId"
  | "type"
  | "title"
  | "points"
  | "opensAt"
  | "closesAt"
  | "config"
  | "verification"
  | "needed"
  | "steps"
  | "place"
  | "dailyCap"
  /** A live poll can never be a flash quest (T-307). */
  | "flash"
  /** A shown flash quest needs both times, 1 to 1,440 minutes apart (T-307, CTO 1). */
  | "flashWindow"
  /** A launched flash quest stays one (T-307, CTO 10). */
  | "flashLaunched";

/** The refusals every builder action may give. */
export type Refused =
  | Readonly<{ kind: "not_found" }>
  | Readonly<{ kind: "event_closed" }>
  | Readonly<{ kind: "confirm_required" }>
  | Readonly<{ kind: "invalid"; field: QuestField | CategoryField }>
  | Readonly<{ kind: "limit_reached"; limit: number }>
  | Readonly<{ kind: "order_stale" }>
  | Readonly<{ kind: "last_category" }>
  | Readonly<{ kind: "category_not_empty"; quests: number }>
  /** Other categories unlock after this one (FR-235): change them first. */
  | Readonly<{ kind: "category_in_use"; categories: readonly Bilingual[] }>
  /** Players completed it: its points are history (T-105); hide it instead, until T-604 offers keep or remove. */
  | Readonly<{ kind: "has_completions" }>
  /** Only rehearsal accounts completed it: erase the rehearsal first (T-211). */
  | Readonly<{ kind: "rehearsal_data" }>
  /** A submission quest asked for photos on a server with no bucket (T-301b) or video (never in v1, FR-1006). */
  | Readonly<{ kind: "submission_kind_unavailable"; asked: "photo" | "video" }>
  /** What a submission quest accepts is fixed once it has a submission (migration 0193). */
  | Readonly<{ kind: "accepts_locked" }>
  /** A game or vote names an image that is not a stored image of this event (ADR-829). */
  | Readonly<{ kind: "image_unknown"; field: string }>
  /** Players voted or started the quiz: only its text may change (ADR-194, migration 0041). */
  | Readonly<{ kind: "quest_locked" }>
  /** Players stamped this passport step (T-304b): it stays. */
  | Readonly<{ kind: "step_in_use" }>
  /** A community goal counts this quest or category (T-306b): change or delete the goal first. */
  | Readonly<{ kind: "goal_in_use" }>
  /** A boost doubles this category (T-307): it stays while the boost does. */
  | Readonly<{ kind: "boost_in_use" }>
  /** NFC tags are registered for this quest (T-308): revoke them first. */
  | Readonly<{ kind: "tags_in_use" }>
  /** A souvenir rule names this category, or an activated souvenir requires this quest (T-402b). */
  | Readonly<{ kind: "souvenir_in_use"; what: "category" | "quest" }>
  /** The quest item named is removed or another event's (T-304d). */
  | Readonly<{ kind: "invalid_item" }>
  /**
   * A live poll's `live` setting, choices or minutes once sent or voted on, or `live` added to a vote players can see
   * (T-306, migration 0052): `field` names which.
   */
  | Readonly<{ kind: "poll_locked"; field: string }>
  /** A real player got the first-N bonus (T-313): its points stay and it cannot be switched off. */
  | Readonly<{ kind: "first_bonus_paid" }>
  /** Fewer bonuses than players who already got it (T-313). */
  | Readonly<{ kind: "below_given"; given: number }>
  /** The bonus's points (1 to 100,000) or players (1 to 1,000) are out of range (T-313). */
  | Readonly<{ kind: "invalid_first_bonus"; field: "points" | "slots" }>
  /** New points in a live event with real completions need "future" or "past" (T-604, FR-411). */
  | Readonly<{ kind: "apply_required" }>
  /** A played quest's delete needs "keep" or "remove" (T-604, FR-412). */
  | Readonly<{ kind: "points_choice_required" }>
  /** "Also past" goes with an Idempotency-Key (T-604). */
  | Readonly<{ kind: "key_required" }>
  /** The Idempotency-Key is malformed, or longer than "also past" takes (T-604). */
  | Readonly<{ kind: "key_invalid" }>
  | LiveEditRefusal;

export type Done<T> = Readonly<{ kind: "done"; value: T }> | Refused;

/** A quest as the builder shows it: the stored record and its first-N bonus (T-313), null when none. */
export type BuilderQuest = QuestRecord & Readonly<{ firstBonus: BuilderFirstBonus | null }>;

export type BuilderView = Readonly<{
  /** The quest pinned as Up next (FR-1748), or null. */
  focusQuestId: string | null;
  categories: readonly (CategoryRecord & { quests: readonly BuilderQuest[] })[];
}>;

export type CategoryDelete = Readonly<{
  quests?: "move" | "delete" | undefined;
  to?: string | undefined;
}>;

/** What every change carries: whether the person confirmed a change to a live event (FR-1007, ADR-063). */
export type Change = Readonly<{ confirm?: boolean | undefined }>;

/**
 * What a change set's apply adds to one builder action (ADR-800), in the action's own transaction with the event locked:
 * `check` before the action, which throws to leave it unwritten; `applied` after an action that is done, so the item's
 * decision commits with the write.
 */
export type ItemGuard = Readonly<{
  check: (client: PoolClient, event: BuilderEvent) => Promise<void>;
  applied: (client: PoolClient) => Promise<void>;
}>;

export type BuilderDeps = Readonly<{ pool: Pool; guard?: ItemGuard | undefined }>;

/** Runs one action inside its guard, when it has one. A refusal has written nothing, and records nothing here. */
export async function guarded<T extends Readonly<{ kind: string }>>(
  guard: ItemGuard | undefined,
  client: PoolClient,
  event: BuilderEvent,
  action: () => Promise<T>,
): Promise<T> {
  if (guard === undefined) {
    return action();
  }
  await guard.check(client, event);
  const result = await action();
  if (result.kind === "done") {
    await guard.applied(client);
  }
  return result;
}

const CLOSED = "QE409";
const LOCKED = "QL409";
/**
 * Rows that keep a played quest or category: its completions, submissions, votes, quiz attempts and survey responses;
 * a category's bonus rows and the quest items it gave or missed (T-304d: an item-only bonus has no ledger entry).
 */
const PLAYED_TABLES = new Set([
  "quest_completion",
  "submission",
  "quest_vote",
  "quiz_attempt",
  "survey_response",
  "category_bonus",
  "redemption",
  "quest_item_miss",
]);

const blankToNull = (text: string | undefined): string | null => {
  const trimmed = text?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
};

export const bilingual = (text: Text | undefined, current: Bilingual): Bilingual =>
  text === undefined ? current : { ar: blankToNull(text.ar), en: blankToNull(text.en) };

export const NO_TEXT: Bilingual = { ar: null, en: null };

export const done = <T>(value: T): Done<T> => ({ kind: "done", value });

/** A time in the event's zone: undefined keeps the current one, null clears it, text that is not a time is refused. */
export function timeOf(
  input: string | null | undefined,
  current: Date | null,
  timeZone: string,
): Date | null | "invalid" {
  if (input === undefined) {
    return current;
  }
  if (input === null) {
    return null;
  }
  try {
    return toInstant(input, timeZone);
  } catch {
    return "invalid";
  }
}

type Window = Readonly<{ opensAt: Date | null; closesAt: Date | null; visible: boolean }>;

/**
 * A live poll's window is Send's and Close's (T-306, ADR-220): a draft stays hidden with no times, a sent poll keeps
 * the window it was sent with, whatever the input says. Every other quest takes the input's.
 */
function windowOf(live: boolean, current: QuestRecord | undefined, asked: Window): Window {
  if (!live) {
    return asked;
  }
  return current?.pollSentAt === null || current === undefined
    ? { opensAt: null, closesAt: null, visible: false }
    : { opensAt: current.opensAt, closesAt: current.closesAt, visible: current.visible };
}

/** A flash quest's shortest and longest shown window (T-307, ADR-231). */
export const FLASH_WINDOW_MS = { min: 60_000, max: 1440 * 60_000 } as const;

/** Whether a flash quest runs or ran: launched, or its scheduled window has started. */
const flashStarted = (current: QuestRecord | undefined, now: Date): current is QuestRecord =>
  current?.flash === true &&
  (current.flashLaunchedAt !== null ||
    (current.visible && current.opensAt !== null && current.opensAt <= now));

/**
 * A flash quest's window (T-307, ADR-231): once launched, or once a scheduled window has started, it is Launch's and
 * End now's, whatever the input says; otherwise a shown one needs both times, 1 to 1,440 minutes apart.
 */
export function flashWindowOf(
  current: QuestRecord | undefined,
  asked: Window,
  now: Date,
): Window | "flashWindow" {
  if (flashStarted(current, now)) {
    return { opensAt: current.opensAt, closesAt: current.closesAt, visible: current.visible };
  }
  if (!asked.visible) {
    return asked;
  }
  const length =
    asked.opensAt === null || asked.closesAt === null
      ? 0
      : asked.closesAt.getTime() - asked.opensAt.getTime();
  return length >= FLASH_WINDOW_MS.min && length <= FLASH_WINDOW_MS.max ? asked : "flashWindow";
}

/**
 * Whether the quest is flash after this input, or the field that refuses it: never a live poll, and it stays flash once
 * launched or once its scheduled window has started (CTO code review 2).
 */
function flashOf(
  current: QuestRecord | undefined,
  input: QuestInput,
  live: boolean,
  now: Date,
): boolean | "flash" | "flashLaunched" {
  const flash = input.flash ?? current?.flash ?? false;
  if (flash && live) {
    return "flash";
  }
  return !flash && flashStarted(current, now) ? "flashLaunched" : flash;
}

/** What `mergeQuest` refuses: a field, or a submission kind this version cannot take. */
type QuestRefusal =
  | Readonly<{ kind: "invalid"; field: QuestField }>
  | Readonly<{ kind: "submission_kind_unavailable"; asked: "photo" | "video" }>;

type QuestTimes = Readonly<{ opensAt: Date | null; closesAt: Date | null }>;

/** The title, points and times after this input, or the first of them that is refused, in that order. */
function basicsOf(
  current: QuestRecord | undefined,
  input: QuestInput,
  timeZone: string,
): (QuestTimes & Readonly<{ title: Bilingual; points: number }>) | QuestField {
  const title = titleOf(current, input);
  if (title === undefined) {
    return "title";
  }
  const points = input.points ?? current?.points;
  if (points === undefined) {
    return "points";
  }
  const times = questTimesOf(current, input, timeZone);
  return typeof times === "string" ? times : { title, points, ...times };
}

/** The title after this input, or undefined when it has neither language. */
function titleOf(current: QuestRecord | undefined, input: QuestInput): Bilingual | undefined {
  const title = bilingual(input.title, current?.title ?? NO_TEXT);
  return title.ar === null && title.en === null ? undefined : title;
}

/** The times after this input, or the field that refuses them: a time that is not one, or a close not after the open. */
function questTimesOf(
  current: QuestRecord | undefined,
  input: QuestInput,
  timeZone: string,
): QuestTimes | "opensAt" | "closesAt" {
  const opensAt = timeOf(input.opensAt, current?.opensAt ?? null, timeZone);
  if (opensAt === "invalid") {
    return "opensAt";
  }
  const closesAt = closeOf(current, input, opensAt, timeZone);
  return closesAt === "closesAt" ? closesAt : { opensAt, closesAt };
}

/** The close after this input, or `closesAt` when it is not a time or not after the open. */
function closeOf(
  current: QuestRecord | undefined,
  input: QuestInput,
  opensAt: Date | null,
  timeZone: string,
): Date | null | "closesAt" {
  const closesAt = timeOf(input.closesAt, current?.closesAt ?? null, timeZone);
  if (closesAt === "invalid" || (closesAt !== null && opensAt !== null && closesAt <= opensAt)) {
    return "closesAt";
  }
  return closesAt;
}

type QuestSettings = Pick<QuestFields, "config" | "verification" | "place">;

/** The config, verification and place after this input, or the first of them that is refused, in that order. */
function settingsOf(
  current: QuestRecord | undefined,
  type: QuestType,
  input: QuestInput,
): QuestSettings | QuestField {
  const config =
    input.config === undefined && current !== undefined
      ? current.config
      : parseQuestConfig(type, input.config ?? {});
  if (config === undefined) {
    return "config";
  }
  const verification = parseVerification(type, input.verification, current?.verification);
  if (verification === undefined) {
    return "verification";
  }
  const place = placeOf(current, type, input);
  return place === "place" ? place : { config, verification, place };
}

/** The place after this input: only on a spot type, and always on a location quest. */
function placeOf(
  current: QuestRecord | undefined,
  type: QuestType,
  input: QuestInput,
): QuestPlace | null | "place" {
  const place = input.place === undefined ? (current?.place ?? null) : input.place;
  const refused =
    (place !== null && !PLACED_QUEST_TYPES.includes(type)) ||
    (place === null && type === "location");
  return refused ? "place" : place;
}

type QuestPlay = Readonly<{ flash: boolean; window: Window; repeatCap: number }>;

/** Whether it is flash, its window and its repeat cap after this input, or the first that is refused, in that order. */
function playOf(
  current: QuestRecord | undefined,
  type: QuestType,
  input: QuestInput,
  set: QuestTimes & Readonly<{ config: QuestFields["config"] }>,
  now: Date,
): QuestPlay | QuestField {
  const live = isLivePoll(type, set.config);
  const flash = flashOf(current, input, live, now);
  if (typeof flash === "string") {
    return flash;
  }
  const window = questWindowOf(current, input, { ...set, flash, live }, now);
  if (window === "flashWindow") {
    return window;
  }
  const repeatCap = repeatCapOf(current, type, input, set.config);
  return repeatCap === "dailyCap" ? repeatCap : { flash, window, repeatCap };
}

/** The window asked for, then held to the flash or live poll rules. */
function questWindowOf(
  current: QuestRecord | undefined,
  input: QuestInput,
  asked: QuestTimes & Readonly<{ flash: boolean; live: boolean }>,
  now: Date,
): Window | "flashWindow" {
  const { opensAt, closesAt, flash } = asked;
  const wanted = {
    opensAt,
    closesAt,
    // A new flash quest without both times is a draft, launched later.
    visible:
      input.visible ?? current?.visible ?? (!flash || (opensAt !== null && closesAt !== null)),
  };
  return flash ? flashWindowOf(current, wanted, now) : windowOf(asked.live, current, wanted);
}

/** The repeat cap after this input, or `dailyCap` when a meet quest's day would pay more than its whole life. */
function repeatCapOf(
  current: QuestRecord | undefined,
  type: QuestType,
  input: QuestInput,
  config: QuestFields["config"],
): number | "dailyCap" {
  // A vote, a quiz, a survey or a share is played once (ADR-191, ADR-198, ADR-199).
  const repeatCap = QUEST_TYPES[type].oneTry ? 1 : (input.repeatCap ?? current?.repeatCap ?? 1);
  // A meet quest's day can never pay more meetings than its whole life (ADR-210).
  return type === "meet" && Number(config["dailyCap"]) > repeatCap ? "dailyCap" : repeatCap;
}

/** The fields no rule checks: the category, the description and the quest item, each kept when left out. */
function plainOf(
  current: QuestRecord | undefined,
  input: QuestInput,
): Pick<QuestFields, "categoryId" | "description" | "itemId"> {
  return {
    // Stryker disable next-line StringLiteral: a create always names its category (the route requires it)
    categoryId: input.categoryId ?? current?.categoryId ?? "",
    description: bilingual(input.description, current?.description ?? NO_TEXT),
    itemId: sentOrKept(input.itemId, current?.itemId ?? null),
  };
}

/**
 * A quest's fields after this input, from what is stored (or nothing, for a new quest), checked as one whole. The
 * config is validated against the quest's type; a config left out keeps the stored one. The checks run in one order,
 * so the first refused field is the one named: the submission kind, title, points, times, config, verification,
 * place, flash, window, then the meet's daily cap.
 */
export function mergeQuest(
  current: QuestRecord | undefined,
  type: QuestType,
  input: QuestInput,
  timeZone: string,
  now: Date = new Date(),
): QuestFields | QuestRefusal {
  // Video only: whether this server takes photos is the routes' check (it knows the bucket); the database holds both.
  const asked = type === "submission" ? unavailableSubmissionKind(input.config, true) : undefined;
  if (asked !== undefined) {
    return { kind: "submission_kind_unavailable", asked };
  }
  const basics = basicsOf(current, input, timeZone);
  if (typeof basics === "string") {
    return { kind: "invalid", field: basics };
  }
  const settings = settingsOf(current, type, input);
  if (typeof settings === "string") {
    return { kind: "invalid", field: settings };
  }
  const play = playOf(current, type, input, { ...basics, config: settings.config }, now);
  if (typeof play === "string") {
    return { kind: "invalid", field: play };
  }
  const plain = plainOf(current, input);
  return {
    categoryId: plain.categoryId,
    title: basics.title,
    description: plain.description,
    points: basics.points,
    repeatCap: play.repeatCap,
    ...play.window,
    config: settings.config,
    verification: settings.verification,
    itemId: plain.itemId,
    place: settings.place,
    flash: play.flash,
  };
}

export const isInvalid = (
  value: object,
): value is
  | Readonly<{ kind: "invalid"; field: QuestField }>
  | Readonly<{ kind: "submission_kind_unavailable"; asked: "photo" | "video" }> => "kind" in value;

/**
 * What an audit entry keeps of a quest. An entry code is a secret, and the audit refuses any `code` key: the entry
 * says only that one is set (`entryCode`), and an edit that changes it says so (`codeChanged`).
 */
export function auditView(
  quest: QuestFields & Pick<QuestRecord, "type" | "steps">,
): Record<string, unknown> {
  const { code, ...config } = quest.config;
  return {
    categoryId: quest.categoryId,
    type: quest.type,
    titleAr: quest.title.ar,
    titleEn: quest.title.en,
    descriptionAr: quest.description.ar,
    descriptionEn: quest.description.en,
    points: quest.points,
    repeatCap: quest.repeatCap,
    opensAt: quest.opensAt?.toISOString() ?? null,
    closesAt: quest.closesAt?.toISOString() ?? null,
    visible: quest.visible,
    config,
    verification: quest.verification,
    itemId: quest.itemId,
    place: quest.place,
    flash: quest.flash,
    ...(code === undefined ? {} : { entryCode: "set" }),
    ...(quest.type === "passport"
      ? {
          steps: quest.steps.map((step) => ({
            id: step.id,
            nameAr: step.name.ar,
            nameEn: step.name.en,
          })),
        }
      : {}),
  };
}

/** The audit's before and after for an edit, with a changed entry code noted but never written. */
export function questChanges(before: QuestRecord, after: QuestRecord) {
  const diff = changes(auditView(before), auditView(after));
  return before.config["code"] === after.config["code"]
    ? diff
    : {
        before: { ...diff.before, codeChanged: false },
        after: { ...diff.after, codeChanged: true },
      };
}

/** Only the fields that changed, before and after. */
export function changes(before: Record<string, unknown>, after: Record<string, unknown>) {
  const keys = Object.keys(after).filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
  return {
    before: Object.fromEntries(keys.map((key) => [key, before[key]])),
    after: Object.fromEntries(keys.map((key) => [key, after[key]])),
  };
}

type Work<T> = (client: PoolClient, event: BuilderEvent) => Promise<Done<T>>;

/**
 * Runs one builder action on the path's event, locked: not found outside the caller's reach, closed once the event has
 * ended, and, for a change to what players see, a confirmation while the event is live. Every action refuses before
 * its first write, so a refusal leaves nothing behind (a refusal is a normal return and commits; a new action must keep
 * this rule, or throw instead); the lock means a category checked here is still there when the
 * action writes.
 */
export async function withEvent<T>(
  deps: BuilderDeps,
  actor: Actor,
  eventId: string,
  gate: Readonly<{ change: Change | undefined }>,
  work: Work<T>,
): Promise<Done<T>> {
  try {
    return await withConnection(deps.pool, (client) =>
      withRequestContext(client, teamSeat(actor), async () => {
        const event = await lockBuilderEvent(client, actor.organizerId, eventId);
        if (event === undefined) {
          return { kind: "not_found" } as const;
        }
        // Stryker disable next-line ConditionalExpression,LogicalOperator,StringLiteral,BlockStatement: the database guard refuses the same writes (migration 0010); this answers before any work
        if (event.statusNow === "ended" || event.statusNow === "archived") {
          return { kind: "event_closed" } as const;
        }
        if (
          gate.change !== undefined &&
          event.statusNow === "live" &&
          gate.change.confirm !== true
        ) {
          return { kind: "confirm_required" } as const;
        }
        return guarded(deps.guard, client, event, () => work(client, event));
      }),
    );
  } catch (error) {
    const refused = builderRefusalOf(error as PgError);
    if (refused !== undefined) {
      return refused;
    }
    throw error;
  }
}

type PgError = Readonly<{ code?: string; table?: string; detail?: string; hint?: string }>;

/** The refusal a builder action's error stands for, or undefined when it is to be thrown as it is. */
function builderRefusalOf(pg: PgError): Refused | undefined {
  return codeRefusal(pg) ?? keptRowRefusal(pg) ?? laterRefusal(pg);
}

/** The guards' own codes, each one refusal (a map keyed by code, so a code such as `toString` names none). */
const CODE_REFUSALS = new Map<string, (pg: PgError) => Refused>([
  // Stryker disable next-line all: reached only when the event ends between the check above and a write, milliseconds apart
  [CLOSED, () => ({ kind: "event_closed" })],
  [LOCKED, () => ({ kind: "quest_locked" })],
  // A live poll's settings once sent or voted on (migration 0052).
  ["PL409", (pg) => ({ kind: "poll_locked", field: pg.detail ?? "live" })],
  // What a submission quest accepts, once it has a submission (migration 0193).
  ["SA409", () => ({ kind: "accepts_locked" })],
  // A flash quest launched, or its window started, between the read and the write (migration 0055).
  ["FL409", () => ({ kind: "invalid", field: "flashWindow" })],
  // The categories' unlocks would go round in a circle (migration 0044).
  ["CU422", () => ({ kind: "invalid", field: "unlockAfter" })],
  // A played-once quest would sit in a refreshing category (migration 0046); the builder checks first.
  ["QT422", () => ({ kind: "invalid", field: "refresh" })],
  // The item was removed between the builder's check and the write (migration 0047).
  ["QI422", () => ({ kind: "invalid_item" })],
  // A config names an image that is not a stored image of this event of its kind (migration 0194).
  ["MI422", (pg) => ({ kind: "image_unknown", field: pg.detail ?? "config" })],
]);

function codeRefusal(pg: PgError): Refused | undefined {
  const code = pg.code;
  return code === undefined ? undefined : CODE_REFUSALS.get(code)?.(pg);
}

/**
 * A row that keeps the quest or category (a foreign key, 23503): a player played the quest between the check and the
 * delete, so its points are history (migration 0012); a player stamped a passport step (migration 0045); a community
 * goal counts it (migration 0053) or a step unlocks it (migration 0054); a boost doubles the category (migration 0055);
 * NFC tags name the quest (migration 0056).
 */
function keptRowRefusal(pg: PgError): Refused | undefined {
  if (pg.code !== "23503" || pg.table === undefined) {
    return undefined;
  }
  if (PLAYED_TABLES.has(pg.table)) {
    return { kind: "has_completions" };
  }
  return KEPT_ROW_REFUSALS.get(pg.table)?.();
}

const KEPT_ROW_REFUSALS = new Map<string, () => Refused>([
  ["passport_stamp", () => ({ kind: "step_in_use" })],
  ["community_goal", () => ({ kind: "goal_in_use" })],
  ["community_step", () => ({ kind: "goal_in_use" })],
  ["boost", () => ({ kind: "boost_in_use" })],
  ["nfc_tag", () => ({ kind: "tags_in_use" })],
]);

/** The refusals added by later tasks: the first-N bonus (T-313), souvenirs (T-402b) and live points edits (T-604). */
function laterRefusal(
  pg: Readonly<{ code?: string; table?: string; detail?: string; hint?: string }>,
): Refused | undefined {
  // A quest deleted by a mark between the read and the write is frozen (QX409, migration 0098): gone to the caller.
  if (pg.code === "QX409") {
    return { kind: "not_found" };
  }
  return (
    firstBonusRefusal(pg) ??
    souvenirUseRefusal(pg) ??
    (pg instanceof LiveEditError ? pg.refusal : undefined)
  );
}

/**
 * A souvenir rule names the category, or an activated souvenir's frozen targets name the quest (migration 0064, no
 * cascade): undefined for any other error.
 */
function souvenirUseRefusal(pg: Readonly<{ code?: string; table?: string }>): Refused | undefined {
  if (pg.code === "23503" && pg.table === "souvenir_rule") {
    return { kind: "souvenir_in_use", what: "category" };
  }
  if (pg.code === "23503" && pg.table === "souvenir_target") {
    return { kind: "souvenir_in_use", what: "quest" };
  }
  return undefined;
}

/** The first-N bonus setter's refusals (set_quest_first_bonus, migration 0062), or undefined for any other error. */
function firstBonusRefusal(
  pg: Readonly<{ code?: string; detail?: string; hint?: string }>,
): Refused | undefined {
  if (pg.code === "QB409") {
    return pg.detail === "below_given"
      ? { kind: "below_given", given: Number(pg.hint) }
      : { kind: "first_bonus_paid" };
  }
  if (pg.code === "QB422") {
    return { kind: "invalid_first_bonus", field: pg.detail === "slots" ? "slots" : "points" };
  }
  return undefined;
}

export const audit = (
  client: PoolClient,
  actor: Actor,
  caller: Caller,
  entry: Readonly<{
    action: string;
    eventId: string;
    target: {
      type: "category" | "quest" | "event" | "reward" | "rank_prize" | "quest_item";
      id: string;
    };
    before?: Record<string, unknown>;
    after?: Record<string, unknown>;
  }>,
) =>
  recordAudit(client, {
    actor: { type: "staff", id: actor.staffUserId },
    action: entry.action,
    target: entry.target,
    organizerId: actor.organizerId,
    eventId: entry.eventId,
    before: entry.before,
    after: entry.after,
    requestId: caller.requestId,
  });

/** These quests of the event with their first-N bonuses, as the builder shows them. */
export async function withFirstBonus(
  client: PoolClient,
  eventId: string,
  quests: readonly QuestRecord[],
): Promise<BuilderQuest[]> {
  const counts = new Map(
    (await readFirstBonuses(client, eventId)).map((count) => [count.questId, count]),
  );
  return quests.map((quest) => {
    const count = counts.get(quest.id);
    return { ...quest, firstBonus: count === undefined ? null : builderBonusOf(count) };
  });
}

async function view(
  client: PoolClient,
  eventId: string,
  focusQuestId: string | null,
): Promise<BuilderView> {
  const categories = await listCategories(client, eventId);
  const quests = await withFirstBonus(client, eventId, await listQuests(client, eventId));
  return {
    focusQuestId,
    categories: categories.map((category) => ({
      ...category,
      quests: quests.filter((quest) => quest.categoryId === category.id),
    })),
  };
}

/** The event's categories with their quests, in order, for the builder (any status: an ended event is still read). */
export function readBuilder(
  deps: BuilderDeps,
  actor: Actor,
  eventId: string,
): Promise<Done<BuilderView>> {
  return withConnection(deps.pool, (client) =>
    withRequestContext(client, teamSeat(actor), async () => {
      const { rows } = await client.query<{ focus_quest_id: string | null }>(
        "SELECT focus_quest_id FROM event WHERE organizer_id = $1 AND id = $2",
        [actor.organizerId, eventId],
      );
      const event = rows[0];
      return event === undefined
        ? { kind: "not_found" }
        : done(await view(client, eventId, event.focus_quest_id));
    }),
  );
}

/**
 * Who completed any of these quests, or sent a submission for one: `real` when a player did (their points are history,
 * migration 0012; a submission is kept with its review, migration 0040), `rehearsal` when only rehearsal accounts did
 * (erased with the rehearsal, T-211), `none` otherwise.
 */
export async function completionsOf(
  client: PoolClient,
  where: Readonly<{ questId: string } | { categoryId: string }>,
): Promise<"none" | "rehearsal" | "real"> {
  const quests =
    "questId" in where
      ? { sql: "q.id = $1", value: where.questId }
      : { sql: "q.category_id = $1", value: where.categoryId };
  const { rows } = await client.query<{ real: boolean | null }>(
    `WITH chosen AS (SELECT q.id FROM quest q WHERE ${quests.sql})
     SELECT bool_or(n.joined_via IS DISTINCT FROM 'rehearsal') AS real
     FROM (SELECT c.enrollment_id FROM quest_completion c WHERE c.quest_id IN (SELECT id FROM chosen)
           UNION ALL
           SELECT s.enrollment_id FROM submitters_of(ARRAY(SELECT id FROM chosen)) s) c
     JOIN enrollment n ON n.id = c.enrollment_id`,
    [quests.value],
  );
  const real = rows[0]?.real ?? null;
  return real === null ? "none" : real ? "real" : "rehearsal";
}
