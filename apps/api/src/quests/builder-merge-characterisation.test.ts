/**
 * Characterisation of the quest builder's merge and its event gate (function-limits split, 2026-11-09): the copies
 * below are the functions as they stood before the split, and every generated case must give the same answer, the
 * same refusal, the same thrown error and the same queries from the old and the new code.
 */
import {
  PLACED_QUEST_TYPES,
  QUEST_TYPES,
  QUEST_TYPE_NAMES,
  isLivePoll,
  parseQuestConfig,
  parseVerification,
  unavailableSubmissionKind,
  type QuestType,
} from "@questify/shared";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { Actor } from "#src/events/events";
import {
  NO_TEXT,
  bilingual,
  flashWindowOf,
  guarded,
  mergeQuest,
  timeOf,
  withEvent,
  type BuilderDeps,
  type Change,
  type Done,
  type QuestField,
  type QuestInput,
  type Refused,
} from "#src/quests/builder";
import { LiveEditError } from "#src/quests/live-edits";
import { lockBuilderEvent, type BuilderEvent, type QuestRecord } from "#src/quests/store";
import { teamSeat } from "#src/organizers/store";

const CASES = 10_000;

/** A seeded generator (mulberry32), so a failing case can be found again by its seed. */
function rng(seed: number) {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;
  return { next, pick };
}
type Rng = ReturnType<typeof rng>;
const ABSENT = Symbol("absent");

/** An input object with each field absent (no key), or one of its values. */
function inputOf(
  r: Rng,
  fields: Readonly<Record<string, readonly unknown[]>>,
): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const [name, values] of Object.entries(fields)) {
    const value = r.next() < 0.35 ? ABSENT : r.pick(values);
    if (value !== ABSENT) {
      input[name] = value;
    }
  }
  return input;
}

/** Every object's own keys in order, so a reordered result is caught too. */
function keysOf(value: unknown): unknown {
  if (value === null || typeof value !== "object" || value instanceof Date) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map(keysOf);
  }
  return Object.entries(value).map(([key, item]) => [key, keysOf(item)]);
}

// ---- The functions as they stood before the split -----------------------------------------------------------------

type OldWindow = Readonly<{ opensAt: Date | null; closesAt: Date | null; visible: boolean }>;

function oldWindowOf(live: boolean, current: QuestRecord | undefined, asked: OldWindow): OldWindow {
  if (!live) {
    return asked;
  }
  return current?.pollSentAt === null || current === undefined
    ? { opensAt: null, closesAt: null, visible: false }
    : { opensAt: current.opensAt, closesAt: current.closesAt, visible: current.visible };
}

const oldFlashStarted = (current: QuestRecord | undefined, now: Date): current is QuestRecord =>
  current?.flash === true &&
  (current.flashLaunchedAt !== null ||
    (current.visible && current.opensAt !== null && current.opensAt <= now));

function oldFlashOf(
  current: QuestRecord | undefined,
  input: QuestInput,
  live: boolean,
  now: Date,
): boolean | "flash" | "flashLaunched" {
  const flash = input.flash ?? current?.flash ?? false;
  if (flash && live) {
    return "flash";
  }
  return !flash && oldFlashStarted(current, now) ? "flashLaunched" : flash;
}

function oldMergeQuest(
  current: QuestRecord | undefined,
  type: QuestType,
  input: QuestInput,
  timeZone: string,
  now: Date = new Date(),
) {
  const asked = type === "submission" ? unavailableSubmissionKind(input.config) : undefined;
  if (asked !== undefined) {
    return { kind: "submission_kind_unavailable", asked };
  }
  const title = bilingual(input.title, current?.title ?? NO_TEXT);
  if (title.ar === null && title.en === null) {
    return { kind: "invalid", field: "title" };
  }
  const points = input.points ?? current?.points;
  if (points === undefined) {
    return { kind: "invalid", field: "points" };
  }
  const opensAt = timeOf(input.opensAt, current?.opensAt ?? null, timeZone);
  if (opensAt === "invalid") {
    return { kind: "invalid", field: "opensAt" };
  }
  const closesAt = timeOf(input.closesAt, current?.closesAt ?? null, timeZone);
  if (closesAt === "invalid" || (closesAt !== null && opensAt !== null && closesAt <= opensAt)) {
    return { kind: "invalid", field: "closesAt" };
  }
  const config =
    input.config === undefined && current !== undefined
      ? current.config
      : parseQuestConfig(type, input.config ?? {});
  if (config === undefined) {
    return { kind: "invalid", field: "config" };
  }
  const verification = parseVerification(type, input.verification, current?.verification);
  if (verification === undefined) {
    return { kind: "invalid", field: "verification" };
  }
  const place = input.place === undefined ? (current?.place ?? null) : input.place;
  if (
    (place !== null && !PLACED_QUEST_TYPES.includes(type)) ||
    (place === null && type === "location")
  ) {
    return { kind: "invalid", field: "place" };
  }
  const live = isLivePoll(type, config);
  const flash = oldFlashOf(current, input, live, now);
  if (typeof flash === "string") {
    return { kind: "invalid", field: flash };
  }
  const wanted = {
    opensAt,
    closesAt,
    visible:
      input.visible ?? current?.visible ?? (!flash || (opensAt !== null && closesAt !== null)),
  };
  const window = flash ? flashWindowOf(current, wanted, now) : oldWindowOf(live, current, wanted);
  if (window === "flashWindow") {
    return { kind: "invalid", field: "flashWindow" };
  }
  const repeatCap = QUEST_TYPES[type].oneTry ? 1 : (input.repeatCap ?? current?.repeatCap ?? 1);
  if (type === "meet" && Number(config["dailyCap"]) > repeatCap) {
    return { kind: "invalid", field: "dailyCap" };
  }
  return {
    categoryId: input.categoryId ?? current?.categoryId ?? "",
    title,
    description: bilingual(input.description, current?.description ?? NO_TEXT),
    points,
    repeatCap,
    ...window,
    config,
    verification,
    itemId: input.itemId === undefined ? (current?.itemId ?? null) : input.itemId,
    place,
    flash,
  };
}

const OLD_CLOSED = "QE409";
const OLD_LOCKED = "QL409";
const OLD_PLAYED_TABLES = new Set([
  "quest_completion",
  "submission",
  "quest_vote",
  "quiz_attempt",
  "survey_response",
  "category_bonus",
  "redemption",
  "quest_item_miss",
]);

function oldSouvenirUseRefusal(
  pg: Readonly<{ code?: string; table?: string }>,
): Refused | undefined {
  if (pg.code === "23503" && pg.table === "souvenir_rule") {
    return { kind: "souvenir_in_use", what: "category" };
  }
  if (pg.code === "23503" && pg.table === "souvenir_target") {
    return { kind: "souvenir_in_use", what: "quest" };
  }
  return undefined;
}

function oldFirstBonusRefusal(
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

function oldLaterRefusal(
  pg: Readonly<{ code?: string; table?: string; detail?: string; hint?: string }>,
): Refused | undefined {
  if (pg.code === "QX409") {
    return { kind: "not_found" };
  }
  return (
    oldFirstBonusRefusal(pg) ??
    oldSouvenirUseRefusal(pg) ??
    (pg instanceof LiveEditError ? pg.refusal : undefined)
  );
}

type Work<T> = (client: PoolClient, event: BuilderEvent) => Promise<Done<T>>;

async function oldWithEvent<T>(
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
    if ((error as { code?: string }).code === OLD_CLOSED) {
      return { kind: "event_closed" };
    }
    const pg = error as { code?: string; table?: string; detail?: string; hint?: string };
    if (pg.code === OLD_LOCKED) {
      return { kind: "quest_locked" };
    }
    if (pg.code === "PL409") {
      return { kind: "poll_locked", field: pg.detail ?? "live" };
    }
    if (pg.code === "FL409") {
      return { kind: "invalid", field: "flashWindow" };
    }
    if (pg.code === "CU422") {
      return { kind: "invalid", field: "unlockAfter" };
    }
    if (pg.code === "QT422") {
      return { kind: "invalid", field: "refresh" };
    }
    if (pg.code === "QI422") {
      return { kind: "invalid_item" };
    }
    if (pg.code === "23503" && pg.table !== undefined && OLD_PLAYED_TABLES.has(pg.table)) {
      return { kind: "has_completions" };
    }
    if (pg.code === "23503" && pg.table === "passport_stamp") {
      return { kind: "step_in_use" };
    }
    if (pg.code === "23503" && (pg.table === "community_goal" || pg.table === "community_step")) {
      return { kind: "goal_in_use" };
    }
    if (pg.code === "23503" && pg.table === "boost") {
      return { kind: "boost_in_use" };
    }
    if (pg.code === "23503" && pg.table === "nfc_tag") {
      return { kind: "tags_in_use" };
    }
    const refused = oldLaterRefusal(pg);
    if (refused !== undefined) {
      return refused;
    }
    throw error;
  }
}

// ---- mergeQuest ---------------------------------------------------------------------------------------------------

const ZONES = ["Asia/Riyadh", "UTC", "America/New_York", "Mars/Olympus"];
const NOW = new Date("2030-11-01T08:00:00Z");
const DATES = [
  null,
  new Date("2030-10-01T07:00:00Z"),
  new Date("2030-11-01T07:00:00Z"),
  new Date("2030-11-01T08:00:00Z"),
  new Date("2030-11-01T08:30:00Z"),
  new Date("2030-11-01T09:00:00Z"),
  new Date("2030-11-02T08:00:00Z"),
];
/** Wall times around NOW in the zones above, so windows of 0, 1, 30, 1440 and 1441 minutes and reversed ones arise. */
const WALL_TIMES = [
  "2030-11-01T10:00",
  "2030-11-01T10:01",
  "2030-11-01T10:30",
  "2030-11-01T11:00",
  "2030-11-01T09:00",
  "2030-11-02T11:00",
  "2030-11-02T11:01",
  "2030-10-01T10:00",
  "2030-11-01T04:00",
  "2030-02-30T10:00",
  "soon",
  "",
];
const TEXTS = [
  {},
  { ar: " " },
  { en: "" },
  { en: "The code" },
  { ar: "الرمز", en: "  The code  " },
  { ar: "الرمز" },
  { ar: undefined, en: undefined },
  { ar: " ", en: " x " },
];
const BILINGUALS = [
  { ar: null, en: null },
  { ar: "الرمز", en: null },
  { ar: null, en: "The code" },
  { ar: "الرمز", en: "The code" },
];
const PLACES = [null, { lat: 24.7, lng: 46.6, radiusM: 50 }, { lat: 0, lng: 0, radiusM: 2000 }];
const OPTION = (id: string) => ({ id, text: { en: `Option ${id}` } });
const CONFIGS: readonly unknown[] = [
  {},
  null,
  "text",
  5,
  [],
  { code: "NAJD2030" },
  { code: " najd2030 ", hint: { en: "On the screen" } },
  { code: "no" },
  { accepts: ["text"] },
  { accepts: ["text"], autoApprove: true, resubmit: true },
  { accepts: ["photo"] },
  { accepts: ["text", "video"] },
  { accepts: "photo" },
  { options: [OPTION("a"), OPTION("b")] },
  { options: [OPTION("a"), OPTION("b")], live: { choices: "one", results: "never", minutes: 5 } },
  {
    options: [OPTION("a"), OPTION("c")],
    live: { choices: "several", results: "at_close", minutes: 1 },
  },
  { options: [OPTION("a"), OPTION("b")], live: { choices: "one", results: "never", minutes: 0 } },
  { options: [OPTION("a"), OPTION("a")] },
  { options: [OPTION("a")] },
  {
    questions: [{ id: "q1", text: { en: "Q" }, choices: [OPTION("a"), OPTION("b")], right: "a" }],
  },
  {
    questions: [{ id: "q1", text: { en: "Q" }, choices: [OPTION("a"), OPTION("b")], right: "z" }],
    timerSeconds: 30,
  },
  { questions: [{ id: "s1", text: { en: "How?" }, kind: "rating" }] },
  { questions: [{ id: "s1", text: { en: "How?" }, kind: "text", required: false }] },
  { message: { en: "Come along" } },
  { message: { en: "Come along" }, link: "https://example.com/x" },
  { message: { en: "Come along" }, link: "http://example.com" },
  { needed: 3 },
  { needed: 0 },
  { dailyCap: 1 },
  { dailyCap: 5 },
  { dailyCap: 50 },
  { dailyCap: 51 },
  { game: "slide_puzzle", level: "hard" },
  { game: "memory_match", level: "easy", attempts: null, cooldownMinutes: 10 },
  { game: "memory_match", level: "easy", attempts: null },
  { game: "nope", level: "easy" },
];
const VERIFICATIONS: readonly unknown[] = [
  [],
  ["quest_qr"],
  ["my_qr"],
  ["nfc"],
  ["nfc", "quest_qr"],
  ["screen_qr", "quest_qr"],
  ["screen_qr"],
  ["kiosk"],
  ["kiosk", "my_qr"],
  ["bogus"],
  "quest_qr",
  null,
];

function storedConfigOf(r: Rng, type: QuestType): Readonly<Record<string, unknown>> {
  for (let tries = 0; tries < 12; tries += 1) {
    const parsed = parseQuestConfig(type, r.pick(CONFIGS));
    if (parsed !== undefined) {
      return parsed;
    }
  }
  return r.pick([{}, { dailyCap: 5 }, { options: [OPTION("a"), OPTION("b")] }]);
}

function questRecordOf(r: Rng, type: QuestType): QuestRecord {
  const own = r.next() < 0.75 ? type : r.pick(QUEST_TYPE_NAMES);
  return {
    id: "11111111-1111-4111-8111-111111111111",
    eventId: "22222222-2222-4222-8222-222222222222",
    categoryId: "33333333-3333-4333-8333-333333333333",
    type: own,
    title: r.next() < 0.1 ? r.pick(BILINGUALS) : r.pick(BILINGUALS.slice(1)),
    description: r.pick(BILINGUALS),
    points: r.pick([0, 15, 100]),
    repeatCap: r.pick([1, 2, 5, 60]),
    opensAt: r.pick(DATES),
    closesAt: r.pick(DATES),
    visible: r.next() < 0.5,
    position: 4,
    config: storedConfigOf(r, own),
    qrVersion: 1,
    verification: r.pick([[], ["quest_qr"], ["my_qr"], ["quest_qr", "nfc"]]),
    steps: [],
    itemId: r.pick([null, "44444444-4444-4444-8444-444444444444"]),
    place: r.pick(PLACES),
    pollSentAt: r.pick([null, null, new Date("2030-11-01T07:30:00Z")]),
    flash: r.next() < 0.4,
    flashLaunchedAt: r.pick([null, null, new Date("2030-11-01T07:45:00Z")]),
    paused: false,
    skipped: false,
  };
}

/**
 * Each field's values: most cases draw from the values the field takes, so the later checks are reached; about one in
 * ten draws from every value, the refused ones too.
 */
function mostlyGood(r: Rng, all: readonly unknown[], good: (value: unknown) => boolean) {
  const kept = all.filter(good);
  return r.next() < 0.1 || kept.length === 0 ? all : kept;
}

const GOOD_TEXT = (text: unknown): boolean => {
  const { ar, en } = text as { ar?: string; en?: string };
  return (ar?.trim() ?? "") !== "" || (en?.trim() ?? "") !== "";
};
const GOOD_TIME = (time: unknown): boolean =>
  time === null || /^2030-1[01]-0[12]T/.test(String(time));

function questInputOf(r: Rng, type: QuestType): QuestInput {
  return inputOf(r, {
    categoryId: ["c1", "33333333-3333-4333-8333-333333333333"],
    title: mostlyGood(r, TEXTS, GOOD_TEXT),
    description: TEXTS,
    points: [0, 1, 15, 250, -5],
    repeatCap: [0, 1, 3, 10, 51],
    opensAt: mostlyGood(r, [null, ...WALL_TIMES], GOOD_TIME),
    closesAt: mostlyGood(r, [null, ...WALL_TIMES], GOOD_TIME),
    visible: [true, false],
    // Photos and video are drawn as often as a config that parses: they are the first refusal.
    config: mostlyGood(
      r,
      CONFIGS,
      (config) =>
        parseQuestConfig(type, config) !== undefined ||
        unavailableSubmissionKind(config) !== undefined,
    ),
    verification: mostlyGood(
      r,
      VERIFICATIONS,
      (methods) => parseVerification(type, methods) !== undefined,
    ),
    steps: [[], [{ name: { en: "One" } }]],
    itemId: [null, "44444444-4444-4444-8444-444444444444"],
    place: mostlyGood(r, PLACES, (place) =>
      type === "location" ? place !== null : place === null || PLACED_QUEST_TYPES.includes(type),
    ),
    flash: [true, false],
    firstBonus: [null],
  }) as QuestInput;
}

function outcomeOf(run: () => unknown): Readonly<{ value?: unknown; error?: unknown }> {
  try {
    return { value: run() };
  } catch (error) {
    return { error };
  }
}

const labelOf = (value: unknown): string =>
  typeof value === "object" && value !== null && "kind" in value
    ? `${String(value.kind)}:${String((value as { field?: unknown }).field ?? "")}`
    : "done";

describe("mergeQuest characterisation", () => {
  it(`answers as before over ${CASES} generated cases`, () => {
    const r = rng(20_261_109);
    const seen = new Map<string, number>();
    for (let index = 0; index < CASES; index += 1) {
      // Votes are drawn more often: a live poll is where the flash and window rules meet.
      const type = r.next() < 0.2 ? "vote" : r.pick(QUEST_TYPE_NAMES);
      const current = r.next() < 0.3 ? undefined : questRecordOf(r, type);
      const input = questInputOf(r, type);
      const zone = r.next() < 0.8 ? "Asia/Riyadh" : r.pick(ZONES);
      const now = r.next() < 0.9 ? NOW : r.pick(DATES.filter((date) => date !== null));
      const before = outcomeOf(() => oldMergeQuest(current, type, input, zone, now));
      const after = outcomeOf(() => mergeQuest(current, type, input, zone, now));
      const where = { index, type, current, input, zone, now };
      expect({ ...where, ...after }).toStrictEqual({ ...where, ...before });
      expect(keysOf(after.value)).toStrictEqual(keysOf(before.value));
      if (before.value !== undefined && !("kind" in (before.value as object))) {
        const [old, made] = [before.value, after.value] as { config: unknown; place: unknown }[];
        expect(made?.config === current?.config).toBe(old?.config === current?.config);
        expect(made?.place === input.place).toBe(old?.place === input.place);
      }
      const label = labelOf(before.value);
      seen.set(label, (seen.get(label) ?? 0) + 1);
    }
    const fields: QuestField[] = [
      "title",
      "points",
      "opensAt",
      "closesAt",
      "config",
      "verification",
      "place",
      "flash",
      "flashLaunched",
      "flashWindow",
      "dailyCap",
    ];
    for (const field of fields) {
      expect(seen.get(`invalid:${field}`) ?? 0, field).toBeGreaterThan(5);
    }
    expect(seen.get("submission_kind_unavailable:") ?? 0).toBeGreaterThan(5);
    expect(seen.get("done") ?? 0).toBeGreaterThan(CASES / 10);
  });
});

describe("mergeQuest refusal order", () => {
  const OK = { title: { en: "x" }, points: 10 };
  const LIVE_VOTE = {
    options: [OPTION("a"), OPTION("b")],
    live: { choices: "one", results: "never", minutes: 5 },
  };
  const cases: readonly [string, QuestType, QuestInput, unknown][] = [
    [
      "the submission kind over the title",
      "submission",
      { config: { accepts: ["photo"] } },
      { kind: "submission_kind_unavailable", asked: "photo" },
    ],
    ["the title over the points", "enter_code", {}, { kind: "invalid", field: "title" }],
    [
      "the points over the open time",
      "enter_code",
      { title: OK.title, opensAt: "not a time" },
      { kind: "invalid", field: "points" },
    ],
    [
      "the open time over the close time",
      "enter_code",
      { ...OK, opensAt: "not a time", closesAt: "not a time" },
      { kind: "invalid", field: "opensAt" },
    ],
    [
      "the close time over the config",
      "enter_code",
      { ...OK, closesAt: "not a time", config: {} },
      { kind: "invalid", field: "closesAt" },
    ],
    [
      "the config over the verification",
      "enter_code",
      { ...OK, config: {}, verification: ["nonsense"] as never },
      { kind: "invalid", field: "config" },
    ],
    [
      "the verification over the place",
      "enter_code",
      {
        ...OK,
        config: { code: "NAJD2030" },
        verification: ["nonsense"] as never,
        place: { lat: 24.7, lng: 46.6, radiusM: 50 },
      },
      { kind: "invalid", field: "verification" },
    ],
    [
      "the place over the flash",
      "vote",
      { ...OK, config: LIVE_VOTE, place: { lat: 24.7, lng: 46.6, radiusM: 50 }, flash: true },
      { kind: "invalid", field: "place" },
    ],
    [
      "the flash over the flash window",
      "vote",
      {
        ...OK,
        config: LIVE_VOTE,
        flash: true,
        visible: true,
        opensAt: "2030-11-01T10:00",
        closesAt: "2030-11-03T10:00",
      },
      { kind: "invalid", field: "flash" },
    ],
    [
      "the flash window over the daily cap",
      "meet",
      {
        ...OK,
        flash: true,
        visible: true,
        opensAt: "2030-11-01T10:00",
        closesAt: "2030-11-03T10:00",
      },
      { kind: "invalid", field: "flashWindow" },
    ],
    ["the daily cap alone", "meet", OK, { kind: "invalid", field: "dailyCap" }],
  ];
  it.each(cases)("refuses first on %s", (_name, type, input, expected) => {
    expect(mergeQuest(undefined, type, input, "Asia/Riyadh", NOW)).toEqual(expected);
  });
});

// ---- withEvent ----------------------------------------------------------------------------------------------------

const ACTOR: Actor = {
  staffUserId: "55555555-5555-4555-8555-555555555555",
  organizerId: "66666666-6666-4666-8666-666666666666",
  organizer: { id: "66666666-6666-4666-8666-666666666666", role: "editor", eventScope: null },
};
const EVENT_ID = "77777777-7777-4777-8777-777777777777";

const pgError = (fields: Record<string, unknown>) => Object.assign(new Error("db"), fields);
const CODES = [
  "23503",
  "23503",
  "23503",
  "QE409",
  "QL409",
  "PL409",
  "FL409",
  "CU422",
  "QT422",
  "QI422",
  "23503",
  "QX409",
  "QB409",
  "QB422",
  "23505",
  "40P01",
  "constructor",
  "toString",
  undefined,
];
const TABLES = [
  undefined,
  "quest_completion",
  "submission",
  "quest_vote",
  "quiz_attempt",
  "survey_response",
  "category_bonus",
  "redemption",
  "quest_item_miss",
  "passport_stamp",
  "community_goal",
  "community_step",
  "boost",
  "nfc_tag",
  "souvenir_rule",
  "souvenir_target",
  "quest",
  "hasOwnProperty",
];
const DETAILS = [undefined, "live", "choices", "minutes", "below_given", "slots", "points", ""];
const HINTS = [undefined, "3", "x", ""];

function thrownOf(r: Rng): unknown {
  const roll = r.next();
  if (roll < 0.05) {
    return r.pick([null, undefined, "boom", 42]);
  }
  if (roll < 0.12) {
    const refusal = r.pick([
      { kind: "not_found" },
      { kind: "event_not_live" },
      { kind: "over_cap", limit: 3 },
      { kind: "invalid", field: "apply" },
    ] as const);
    const error = new LiveEditError(refusal, undefined);
    return r.next() < 0.3 ? Object.assign(error, { code: r.pick(CODES) }) : error;
  }
  if (roll < 0.15) {
    return new Error("plain");
  }
  return pgError(
    inputOf(r, { code: CODES, table: TABLES, detail: DETAILS, hint: HINTS }) as Record<
      string,
      unknown
    >,
  );
}

type Scenario = Readonly<{
  row: Readonly<{ id: string; timezone: string; status_now: string }> | undefined;
  lockThrows: unknown;
  gate: Readonly<{ change: Change | undefined }>;
  guard: "none" | "passes" | "check_throws" | "applied_throws";
  guardError: unknown;
  work: Readonly<{ kind: "returns"; value: Done<string> } | { kind: "throws"; error: unknown }>;
  commitThrows: unknown;
}>;

const NO_THROW = Symbol("none");

function scenarioOf(r: Rng): Scenario {
  const workThrows = r.next() < 0.6;
  return {
    row:
      r.next() < 0.1
        ? undefined
        : {
            id: EVENT_ID,
            timezone: "Asia/Riyadh",
            status_now: r.pick(["draft", "scheduled", "live", "ended", "archived"]),
          },
    lockThrows: r.next() < 0.08 ? thrownOf(r) : NO_THROW,
    gate: { change: r.pick([undefined, {}, { confirm: true }, { confirm: false }]) },
    guard: r.pick(["none", "none", "passes", "check_throws", "applied_throws"]),
    guardError: thrownOf(r),
    work: workThrows
      ? { kind: "throws", error: thrownOf(r) }
      : {
          kind: "returns",
          value: r.pick([
            { kind: "done", value: "made" },
            { kind: "not_found" },
            { kind: "invalid", field: "title" },
          ] as const),
        },
    commitThrows: r.next() < 0.03 ? thrownOf(r) : NO_THROW,
  };
}

/** A pool whose one client answers the gate's queries from the scenario and logs every call. */
function fakeOf(scenario: Scenario) {
  const log: unknown[] = [];
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      log.push(["query", sql, params]);
      if (sql.includes("FROM event") && scenario.lockThrows !== NO_THROW) {
        throw scenario.lockThrows;
      }
      if (sql === "COMMIT" && scenario.commitThrows !== NO_THROW) {
        throw scenario.commitThrows;
      }
      return {
        rows: sql.includes("FROM event") && scenario.row !== undefined ? [scenario.row] : [],
      };
    },
    release: (error?: unknown) => log.push(["release", error]),
  } as unknown as PoolClient;
  const pool = {
    connect: async () => {
      log.push(["connect"]);
      return client;
    },
  } as unknown as Pool;
  const guard =
    scenario.guard === "none"
      ? undefined
      : {
          check: async (_client: PoolClient, event: BuilderEvent) => {
            log.push(["check", event]);
            if (scenario.guard === "check_throws") {
              throw scenario.guardError;
            }
          },
          applied: async () => {
            log.push(["applied"]);
            if (scenario.guard === "applied_throws") {
              throw scenario.guardError;
            }
          },
        };
  const work: Work<string> = async (_client, event) => {
    log.push(["work", event]);
    if (scenario.work.kind === "throws") {
      throw scenario.work.error;
    }
    return scenario.work.value;
  };
  return { deps: { pool, guard }, work, log };
}

async function settledOf(run: () => Promise<unknown>) {
  try {
    return { value: await run() };
  } catch (error) {
    return { error };
  }
}

/** A thrown error as compared: the very object when it was one of the scenario's, else its class and message. */
const errorView = (error: unknown, scenario: Scenario) =>
  [scenario.lockThrows, scenario.guardError, scenario.commitThrows].includes(error) ||
  (scenario.work.kind === "throws" && scenario.work.error === error)
    ? { same: error }
    : { made: [(error as Error)?.constructor?.name, (error as Error)?.message] };

describe("withEvent characterisation", () => {
  it(`answers, throws and queries as before over ${CASES} generated cases`, async () => {
    const r = rng(9_112_026);
    const seen = new Map<string, number>();
    for (let index = 0; index < CASES; index += 1) {
      const scenario = scenarioOf(r);
      const old = fakeOf(scenario);
      const made = fakeOf(scenario);
      const before = await settledOf(() =>
        oldWithEvent(old.deps, ACTOR, EVENT_ID, scenario.gate, old.work),
      );
      const after = await settledOf(() =>
        withEvent(made.deps, ACTOR, EVENT_ID, scenario.gate, made.work),
      );
      const view = (outcome: { value?: unknown; error?: unknown }, log: unknown[]) => ({
        index,
        scenario,
        log,
        ...("error" in outcome
          ? { error: errorView(outcome.error, scenario) }
          : { value: outcome.value }),
      });
      expect(view(after, made.log)).toStrictEqual(view(before, old.log));
      if ("value" in before && "value" in after) {
        expect(keysOf(after.value)).toStrictEqual(keysOf(before.value));
        // A live edit's refusal is handed on as the very object it carried.
        expect(after.value === (scenario.work as { error?: LiveEditError }).error?.refusal).toBe(
          before.value === (scenario.work as { error?: LiveEditError }).error?.refusal,
        );
      }
      const label = "error" in before ? "thrown" : labelOf(before.value);
      seen.set(label, (seen.get(label) ?? 0) + 1);
    }
    for (const label of [
      "thrown",
      "done:",
      "not_found:",
      "event_closed:",
      "confirm_required:",
      "quest_locked:",
      "poll_locked:live",
      "poll_locked:choices",
      "invalid:flashWindow",
      "invalid:unlockAfter",
      "invalid:refresh",
      "invalid_item:",
      "has_completions:",
      "step_in_use:",
      "goal_in_use:",
      "boost_in_use:",
      "tags_in_use:",
      "souvenir_in_use:",
      "first_bonus_paid:",
      "below_given:",
      "invalid_first_bonus:slots",
      "invalid_first_bonus:points",
      "invalid:apply",
      "over_cap:",
    ]) {
      expect(seen.get(label) ?? 0, label).toBeGreaterThan(3);
    }
  });
});
