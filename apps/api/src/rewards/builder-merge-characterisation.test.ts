/**
 * Characterisation of the reward merge and the shop settings save (function-limits split, 2026-11-09): the copies
 * below are the functions as they stood before the split, with their private helpers, and every generated case must
 * give the same answer, the same refusal, the same thrown error and the same queries from the old and the new code.
 */
import { toInstant, type ShopState } from "@questify/shared";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it } from "vitest";
import type { Caller } from "#src/auth/sign-in";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import type { Actor } from "#src/events/events";
import { audit, bilingual, changes, guarded, NO_TEXT } from "#src/quests/builder";
import { lockBuilderEvent, type BuilderEvent } from "#src/quests/store";
import {
  mergeDesk,
  mergeReward,
  pinOf,
  updateShop,
  windowsOf,
  type DeskSettings,
  type HandoverConfirm,
  type RewardDeps,
  type RewardDone,
  type RewardField,
  type RewardInput,
  type RewardRecord,
  type ShopInput,
  type ShopSettings,
  type ShopView,
  type ShopWindowView,
} from "#src/rewards/builder";
import { windowRefusal, windowRefusalOf, type WindowRefusal } from "#src/rewards/shop-window";
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

/** An input object with each field absent (no key) about a third of the time, else one of its values. */
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

function oldTimeOf(
  input: string | null | undefined,
  current: Date | null,
  timeZone: string,
): Date | null | "invalid" {
  if (input === undefined || input === null) {
    return input === null ? null : current;
  }
  try {
    return toInstant(input, timeZone);
  } catch {
    return "invalid";
  }
}

type Fields = Omit<RewardRecord, "id" | "kind" | "unitsOut" | "position">;

function oldMergeReward(
  current: RewardRecord | undefined,
  input: RewardInput,
  timeZone: string,
): Fields | Readonly<{ kind: "invalid"; field: RewardField }> {
  const name = bilingual(input.name, current?.name ?? NO_TEXT);
  if (name.ar === null && name.en === null) {
    return { kind: "invalid", field: "name" };
  }
  const opensAt = oldTimeOf(input.opensAt, current?.opensAt ?? null, timeZone);
  const closesAt = oldTimeOf(input.closesAt, current?.closesAt ?? null, timeZone);
  if (opensAt === "invalid") {
    return { kind: "invalid", field: "opensAt" };
  }
  if (closesAt === "invalid" || (opensAt !== null && closesAt !== null && closesAt <= opensAt)) {
    return { kind: "invalid", field: "closesAt" };
  }
  return {
    name,
    description: bilingual(input.description, current?.description ?? NO_TEXT),
    price: input.price ?? current?.price ?? 0,
    stock: input.stock ?? current?.stock ?? 0,
    perPlayerLimit:
      input.perPlayerLimit === undefined ? (current?.perPlayerLimit ?? null) : input.perPlayerLimit,
    opensAt,
    closesAt,
    section: input.section === undefined ? (current?.section ?? null) : input.section,
    tags: {
      new: input.tags?.new ?? current?.tags.new ?? false,
      limited: input.tags?.limited ?? current?.tags.limited ?? false,
    },
  };
}

type OldWork<T> = (client: PoolClient, event: BuilderEvent) => Promise<RewardDone<T>>;

function oldWithRewardEvent<T>(
  deps: RewardDeps,
  actor: Actor,
  eventId: string,
  work: OldWork<T>,
): Promise<RewardDone<T>> {
  return withConnection(deps.pool, (client) =>
    withRequestContext(client, teamSeat(actor), async () => {
      const event = await lockBuilderEvent(client, actor.organizerId, eventId);
      if (event === undefined) {
        return { kind: "not_found" } as const;
      }
      if (event.statusNow === "archived") {
        return { kind: "event_archived" } as const;
      }
      return guarded(deps.guard, client, event, () => work(client, event));
    }),
  );
}

type ShopRow = {
  pickup_minutes: number;
  shop_days_after: number;
  shop_rules_ar: string | null;
  shop_rules_en: string | null;
  spend_lowers_rank: boolean;
  desk_location_ar: string | null;
  desk_location_en: string | null;
  desk_lat: string | null;
  desk_lng: string | null;
  desk_opens: Date[] | null;
  desk_closes: Date[] | null;
  handover_confirm: HandoverConfirm;
  reservation_on: boolean;
  state: ShopState;
  closes_at: Date | null;
};

const oldShopOf = (row: ShopRow): ShopSettings => ({
  pickupMinutes: row.pickup_minutes,
  daysAfter: row.shop_days_after,
  rules: { ar: row.shop_rules_ar, en: row.shop_rules_en },
  spendLowersRank: row.spend_lowers_rank,
  desk: {
    location: { ar: row.desk_location_ar, en: row.desk_location_en },
    pin: pinOf(row.desk_lat, row.desk_lng),
    hours: windowsOf(row.desk_opens, row.desk_closes),
  },
  handoverConfirm: row.handover_confirm,
  reservation: row.reservation_on,
});

type ShopRead = Readonly<{ settings: ShopSettings; window: ShopWindowView }>;

async function oldReadShop(client: PoolClient, eventId: string): Promise<ShopRead> {
  const { rows } = await client.query<ShopRow>(
    `SELECT pickup_minutes, shop_days_after, shop_rules_ar, shop_rules_en, spend_lowers_rank, desk_location_ar,
            desk_location_en, desk_lat, desk_lng, handover_confirm, reservation_on,
            (SELECT array_agg(lower(w) ORDER BY lower(w)) FROM unnest(desk_hours) w) AS desk_opens,
            (SELECT array_agg(upper(w) ORDER BY lower(w)) FROM unnest(desk_hours) w) AS desk_closes,
            shop_state(status, starts_at, ends_at, shop_days_after) AS state,
            ends_at + make_interval(days => shop_days_after) AS closes_at
     FROM event WHERE id = $1`,
    [eventId],
  );
  const row = rows[0] as ShopRow;
  return {
    settings: oldShopOf(row),
    window: { state: row.state, closesAt: row.closes_at?.toISOString() ?? null },
  };
}

const oldViewOf = (read: ShopRead): ShopView => ({ ...read.settings, ...read.window });

const oldHasPlace = (desk: DeskSettings): boolean =>
  desk.location.ar !== null || desk.location.en !== null;

async function oldHasActiveItems(client: PoolClient, eventId: string): Promise<boolean> {
  const { rows } = await client.query(
    "SELECT 1 FROM reward WHERE event_id = $1 AND kind = 'item' AND status = 'active' LIMIT 1",
    [eventId],
  );
  return rows.length > 0;
}

function oldDeskColumns(
  desk: DeskSettings,
): [number | null, number | null, string[] | null, string[] | null] {
  const { pin, hours } = desk;
  return [
    pin === null ? null : pin.lat,
    pin === null ? null : pin.lng,
    hours === null ? null : hours.map((window) => window.opensAt),
    hours === null ? null : hours.map((window) => window.closesAt),
  ];
}

async function oldWriteShop(
  client: PoolClient,
  eventId: string,
  after: ShopSettings,
): Promise<WindowRefusal | undefined> {
  const { desk } = after;
  await client.query("SAVEPOINT shop_window");
  try {
    await client.query(
      `UPDATE event SET pickup_minutes = $2, shop_days_after = $3, shop_rules_ar = $4, shop_rules_en = $5,
              spend_lowers_rank = $6, desk_location_ar = $7, desk_location_en = $8, handover_confirm = $9,
              desk_lat = $10, desk_lng = $11, reservation_on = $14,
              desk_hours = (SELECT range_agg(tstzrange(w.o, w.c))
                            FROM unnest($12::timestamptz[], $13::timestamptz[]) AS w(o, c))
       WHERE id = $1`,
      [
        eventId,
        after.pickupMinutes,
        after.daysAfter,
        after.rules.ar,
        after.rules.en,
        after.spendLowersRank,
        desk.location.ar,
        desk.location.en,
        after.handoverConfirm,
        ...oldDeskColumns(desk),
        after.reservation,
      ],
    );
  } catch (error) {
    const refusal = windowRefusalOf(error);
    if (refusal === undefined) {
      throw error;
    }
    await client.query("ROLLBACK TO SAVEPOINT shop_window");
    return refusal;
  }
  await client.query("RELEASE SAVEPOINT shop_window");
  return undefined;
}

async function oldNeedsDesk(
  client: PoolClient,
  eventId: string,
  before: ShopSettings,
  after: ShopSettings,
): Promise<boolean> {
  if (
    oldHasPlace(before.desk) &&
    !oldHasPlace(after.desk) &&
    (await oldHasActiveItems(client, eventId))
  ) {
    return true;
  }
  return !after.reservation && !oldHasPlace(after.desk);
}

function oldUpdateShop(
  deps: RewardDeps,
  actor: Actor,
  eventId: string,
  input: ShopInput,
  caller: Caller,
): Promise<RewardDone<ShopView>> {
  return oldWithRewardEvent(deps, actor, eventId, async (client, event) => {
    const { settings: before, window } = await oldReadShop(client, eventId);
    const desk = mergeDesk(before.desk, input.desk, event.timezone);
    if (desk === "invalid_hours") {
      return { kind: "invalid", field: "deskHours" };
    }
    const after: ShopSettings = {
      pickupMinutes: input.pickupMinutes ?? before.pickupMinutes,
      daysAfter: input.daysAfter ?? before.daysAfter,
      rules: bilingual(input.rules, before.rules),
      spendLowersRank: input.spendLowersRank ?? before.spendLowersRank,
      desk,
      handoverConfirm: input.handoverConfirm ?? before.handoverConfirm,
      reservation: input.reservation ?? before.reservation,
    };
    if (await oldNeedsDesk(client, eventId, before, after)) {
      return { kind: "desk_needed" };
    }
    if (after.spendLowersRank !== before.spendLowersRank) {
      if (actor.organizer.role !== "owner") {
        return { kind: "owner_only" };
      }
      if (event.statusNow !== "draft" && event.statusNow !== "scheduled") {
        return { kind: "setting_locked" };
      }
    }
    const refused =
      windowRefusal({
        state: window.state,
        statusNow: event.statusNow,
        current: before.daysAfter,
        wanted: after.daysAfter,
      }) ?? (await oldWriteShop(client, eventId, after));
    if (refused !== undefined) {
      return { kind: "shop_window_locked", reason: refused };
    }
    const diff = changes(before, after);
    if (Object.keys(diff.after).length > 0) {
      await audit(client, actor, caller, {
        action: "event.shop.update",
        eventId,
        target: { type: "event", id: eventId },
        ...diff,
      });
    }
    return done(oldViewOf(await oldReadShop(client, eventId)));
  });
}

const done = <T>(value: T): RewardDone<T> => ({ kind: "done", value });

// ---- mergeReward --------------------------------------------------------------------------------------------------

const ZONES = ["Asia/Riyadh", "UTC", "America/New_York", "Mars/Olympus"];
const TEXTS = [
  {},
  { ar: " " },
  { en: "" },
  { en: "Hoodie" },
  { ar: "هودي", en: "  Hoodie  " },
  { ar: "هودي" },
  { ar: undefined, en: undefined },
];
const BILINGUALS = [
  { ar: null, en: null },
  { ar: "هودي", en: null },
  { ar: null, en: "Hoodie" },
  { ar: "هودي", en: "Hoodie" },
];
const WALL_TIMES = [
  "2030-11-01T10:00",
  "2030-11-01T12:00",
  "2030-11-01T09:00",
  "2030-11-02T10:00",
  "2030-02-30T10:00",
  "later",
  "",
];
const DATES = [
  null,
  new Date("2030-11-01T07:00:00Z"),
  new Date("2030-11-01T09:00:00Z"),
  new Date("2030-11-02T07:00:00Z"),
];
const SECTIONS = ["featured", "merch", "food", "experiences"] as const;

function rewardOf(r: Rng): RewardRecord {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    kind: r.pick(["item", "experience", "digital"] as const),
    name: r.next() < 0.1 ? r.pick(BILINGUALS) : r.pick(BILINGUALS.slice(1)),
    description: r.pick(BILINGUALS),
    price: r.pick([0, 50, 200]),
    stock: r.pick([0, 1, 10]),
    unitsOut: r.pick([0, 3]),
    perPlayerLimit: r.pick([null, 1, 2]),
    opensAt: r.pick(DATES),
    closesAt: r.pick(DATES),
    section: r.pick([null, ...SECTIONS]),
    tags: { new: r.next() < 0.5, limited: r.next() < 0.5 },
    position: 4,
  };
}

function rewardInputOf(r: Rng): RewardInput {
  const often = <T>(good: readonly T[], all: readonly T[]): readonly T[] =>
    r.next() < 0.15 ? all : good;
  return inputOf(r, {
    name: often(TEXTS.slice(3, 6), TEXTS),
    description: TEXTS,
    price: [0, 1, 200, -1],
    stock: [0, 5, 100],
    perPlayerLimit: [null, 1, 3],
    opensAt: often([null, ...WALL_TIMES.slice(0, 4)], [null, ...WALL_TIMES]),
    closesAt: often([null, ...WALL_TIMES.slice(0, 4)], [null, ...WALL_TIMES]),
    section: [null, ...SECTIONS],
    tags: [{}, { new: true }, { limited: false }, { new: false, limited: true }],
  }) as RewardInput;
}

const labelOf = (value: unknown): string =>
  typeof value === "object" && value !== null && "kind" in value
    ? `${String(value.kind)}:${String((value as { field?: unknown }).field ?? "")}`
    : "done";

describe("mergeReward characterisation", () => {
  it(`answers as before over ${CASES} generated cases`, () => {
    const r = rng(36_2026);
    const seen = new Map<string, number>();
    for (let index = 0; index < CASES; index += 1) {
      const current = r.next() < 0.3 ? undefined : rewardOf(r);
      const input = rewardInputOf(r);
      const zone = r.next() < 0.8 ? "Asia/Riyadh" : r.pick(ZONES);
      const before = oldMergeReward(current, input, zone);
      const after = mergeReward(current, input, zone);
      expect({ index, current, input, zone, after }).toStrictEqual({
        index,
        current,
        input,
        zone,
        after: before,
      });
      expect(keysOf(after)).toStrictEqual(keysOf(before));
      const label = labelOf(before);
      seen.set(label, (seen.get(label) ?? 0) + 1);
    }
    for (const label of ["invalid:name", "invalid:opensAt", "invalid:closesAt"]) {
      expect(seen.get(label) ?? 0, label).toBeGreaterThan(50);
    }
    expect(seen.get("done") ?? 0).toBeGreaterThan(CASES / 4);
  });
});

// ---- updateShop ---------------------------------------------------------------------------------------------------

const EVENT_ID = "77777777-7777-4777-8777-777777777777";
const actorOf = (role: "owner" | "editor"): Actor => ({
  staffUserId: "55555555-5555-4555-8555-555555555555",
  organizerId: "66666666-6666-4666-8666-666666666666",
  organizer: { id: "66666666-6666-4666-8666-666666666666", role, eventScope: null },
});
const CALLER: Caller = {
  address: "127.0.0.1",
  userAgent: null,
  log: { info: () => undefined, warn: () => undefined } as unknown as Caller["log"],
  requestId: "req-1",
};

const shopRowOf = (r: Rng): ShopRow => {
  const hours = r.pick([
    null,
    [[new Date("2030-11-01T07:00:00Z")], [new Date("2030-11-01T09:00:00Z")]],
  ] as const);
  const pinned = r.next() < 0.5;
  return {
    pickup_minutes: r.pick([15, 30]),
    shop_days_after: r.pick([0, 2, 7]),
    shop_rules_ar: r.pick([null, "القواعد"]),
    shop_rules_en: r.pick([null, "Rules"]),
    spend_lowers_rank: r.next() < 0.5,
    desk_location_ar: r.pick([null, "البوابة"]),
    desk_location_en: r.pick([null, null, "Gate"]),
    desk_lat: pinned ? "24.7" : null,
    desk_lng: pinned ? "46.6" : null,
    desk_opens: hours === null ? null : [...hours[0]],
    desk_closes: hours === null ? null : [...hours[1]],
    handover_confirm: r.pick(["collect_first", "desk_offer"] as const),
    reservation_on: r.next() < 0.6,
    state: r.pick(["not_open", "open", "closed"] as const),
    closes_at: r.pick([null, new Date("2030-11-08T13:00:00Z")]),
  };
};

const HOURS = [
  null,
  [],
  [{ opensAt: "2030-11-01T10:00", closesAt: "2030-11-01T12:00" }],
  [
    { opensAt: "2030-11-01T10:00", closesAt: "2030-11-01T12:00" },
    { opensAt: "2030-11-01T13:00", closesAt: "2030-11-01T15:00" },
  ],
  [
    { opensAt: "2030-11-01T10:00", closesAt: "2030-11-01T12:00" },
    { opensAt: "2030-11-01T11:00", closesAt: "2030-11-01T15:00" },
  ],
  [{ opensAt: "2030-11-01T12:00", closesAt: "2030-11-01T10:00" }],
  [{ opensAt: "soon", closesAt: "2030-11-01T10:00" }],
];

function shopInputOf(r: Rng): ShopInput {
  return inputOf(r, {
    pickupMinutes: [15, 30, 60],
    daysAfter: [0, 2, 7, 14],
    rules: [{}, { en: "Rules" }, { ar: " ", en: "" }],
    spendLowersRank: [true, false],
    desk: [
      {},
      ...Array.from({ length: 6 }, () =>
        inputOf(r, {
          location: [{}, { en: "Gate" }, { ar: " ", en: "" }, { ar: "البوابة" }],
          pin: [null, { lat: 24.7, lng: 46.6 }],
          hours: HOURS,
        }),
      ),
    ],
    handoverConfirm: ["collect_first", "desk_offer"],
    reservation: [true, false, true],
  }) as ShopInput;
}

const NO_THROW = Symbol("none");
const pgError = (fields: Record<string, unknown>) => Object.assign(new Error("db"), fields);

type ShopScenario = Readonly<{
  event: Readonly<{ id: string; timezone: string; status_now: string }> | undefined;
  role: "owner" | "editor";
  guard: "none" | "passes" | "check_throws" | "applied_throws";
  guardError: unknown;
  before: ShopRow;
  after: ShopRow;
  activeItems: boolean;
  updateThrows: unknown;
  auditThrows: unknown;
  input: ShopInput;
}>;

function shopScenarioOf(r: Rng): ShopScenario {
  return {
    event:
      r.next() < 0.05
        ? undefined
        : {
            id: EVENT_ID,
            timezone: r.next() < 0.9 ? "Asia/Riyadh" : r.pick(ZONES),
            status_now: r.pick(["draft", "scheduled", "live", "ended", "archived"]),
          },
    role: r.pick(["owner", "editor"] as const),
    guard: r.pick(["none", "none", "passes", "check_throws", "applied_throws"] as const),
    guardError: r.pick([pgError({ code: "CS409" }), new Error("guard")]),
    before: shopRowOf(r),
    after: shopRowOf(r),
    activeItems: r.next() < 0.5,
    updateThrows:
      r.next() < 0.25
        ? r.pick([
            pgError({ code: "SW409", detail: "closed" }),
            pgError({ code: "SW409", detail: "shorter" }),
            pgError({ code: "SW409", detail: "other" }),
            pgError({ code: "23514" }),
            null,
          ])
        : NO_THROW,
    auditThrows: r.next() < 0.03 ? new Error("audit") : NO_THROW,
    input: shopInputOf(r),
  };
}

function shopFakeOf(scenario: ShopScenario) {
  const log: unknown[] = [];
  let reads = 0;
  const client = {
    query: async (sql: string, params?: unknown[]) => {
      log.push(["query", sql, params]);
      if (sql.includes("event_status_now")) {
        return { rows: scenario.event === undefined ? [] : [scenario.event] };
      }
      if (sql.includes("SELECT pickup_minutes")) {
        reads += 1;
        return { rows: [reads === 1 ? scenario.before : scenario.after] };
      }
      if (sql.includes("FROM reward WHERE event_id")) {
        return { rows: scenario.activeItems ? [{ "?column?": 1 }] : [] };
      }
      if (sql.startsWith("UPDATE event SET pickup_minutes") && scenario.updateThrows !== NO_THROW) {
        throw scenario.updateThrows;
      }
      if (sql.includes("INSERT INTO audit_log") && scenario.auditThrows !== NO_THROW) {
        throw scenario.auditThrows;
      }
      return { rows: [] };
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
  const deps = { pool, codeKey: {} as RewardDeps["codeKey"], guard } as RewardDeps;
  return { deps, log };
}

async function settledOf(run: () => Promise<unknown>) {
  try {
    return { value: await run() };
  } catch (error) {
    return { error };
  }
}

describe("updateShop characterisation", () => {
  it(`answers, throws and queries as before over ${CASES} generated cases`, async () => {
    const r = rng(15_2026);
    const seen = new Map<string, number>();
    for (let index = 0; index < CASES; index += 1) {
      const scenario = shopScenarioOf(r);
      const actor = actorOf(scenario.role);
      const old = shopFakeOf(scenario);
      const made = shopFakeOf(scenario);
      const before = await settledOf(() =>
        oldUpdateShop(old.deps, actor, EVENT_ID, scenario.input, CALLER),
      );
      const after = await settledOf(() =>
        updateShop(made.deps, actor, EVENT_ID, scenario.input, CALLER),
      );
      const view = (outcome: { value?: unknown; error?: unknown }, log: unknown[]) => ({
        index,
        scenario,
        log,
        ...("error" in outcome
          ? {
              error: [
                (outcome.error as Error | null)?.constructor?.name,
                (outcome.error as Error | null)?.message,
                [scenario.updateThrows, scenario.guardError, scenario.auditThrows].includes(
                  outcome.error,
                ),
              ],
            }
          : { value: outcome.value }),
      });
      expect(view(after, made.log)).toStrictEqual(view(before, old.log));
      if ("value" in before) {
        expect(keysOf(after.value)).toStrictEqual(keysOf(before.value));
      }
      const label = "error" in before ? "thrown" : labelOf(before.value);
      seen.set(label, (seen.get(label) ?? 0) + 1);
      if (old.log.some((entry) => String((entry as unknown[])[1]).includes("audit_log"))) {
        seen.set("audited", (seen.get("audited") ?? 0) + 1);
      }
    }
    for (const label of [
      "thrown",
      "done:",
      "not_found:",
      "event_archived:",
      "invalid:deskHours",
      "desk_needed:",
      "owner_only:",
      "setting_locked:",
      "shop_window_locked:",
      "audited",
    ]) {
      expect(seen.get(label) ?? 0, label).toBeGreaterThan(20);
    }
  });
});
