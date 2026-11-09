/**
 * Characterisation of the event merge (function-limits split, 2026-11-09): the copy below is `merge` as it stood
 * before the split, with its private helpers, and every generated case must give the same fields or the same refusal
 * from the old and the new code.
 */
import {
  DEFAULT_LAYOUT,
  DEFAULT_TERMS,
  MAX_EVENT_INTERESTS,
  NO_EVENT_TEXTS,
  VENUE_RADIUS,
  isTimeZone,
  toInstant,
} from "@questify/shared";
import { describe, expect, it } from "vitest";
import { merge, type EventInput, type InvalidField } from "#src/events/events";
import type { EventFields, EventRecord } from "#src/events/store";

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

// ---- The function as it stood before the split --------------------------------------------------------------------

const OLD_DEFAULTS = {
  kind: "physical",
  access: "public",
  joinMethods: ["code", "qr", "link"],
  timezone: "Asia/Riyadh",
  dayStartHour: 4,
} as const;

const oldBlankToNull = (text: string | null | undefined): string | null => {
  const trimmed = text?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
};

function oldInstantOf(local: string, timeZone: string): Date | undefined {
  try {
    return toInstant(local, timeZone);
  } catch {
    return undefined;
  }
}

function oldInstantFrom(
  sent: string | undefined,
  stored: Date | null | undefined,
  timezone: string,
): Date | undefined {
  return sent === undefined ? (stored ?? undefined) : oldInstantOf(sent, timezone);
}

function oldTimesOf(
  current: EventRecord | undefined,
  input: EventInput,
  timezone: string,
): Readonly<{ startsAt: Date; endsAt: Date }> | Readonly<{ kind: "invalid"; field: InvalidField }> {
  const startsAt = oldInstantFrom(input.startsAt, current?.startsAt, timezone);
  if (startsAt === undefined) {
    return { kind: "invalid", field: "startsAt" };
  }
  const endsAt = oldInstantFrom(input.endsAt, current?.endsAt, timezone);
  if (endsAt === undefined || endsAt <= startsAt) {
    return { kind: "invalid", field: "endsAt" };
  }
  return { startsAt, endsAt };
}

function oldMerge(
  current: EventRecord | undefined,
  input: EventInput,
): EventFields | Readonly<{ kind: "invalid"; field: InvalidField }> {
  const nameAr =
    input.name === undefined ? (current?.name.ar ?? null) : oldBlankToNull(input.name.ar);
  const nameEn =
    input.name === undefined ? (current?.name.en ?? null) : oldBlankToNull(input.name.en);
  if (nameAr === null && nameEn === null) {
    return { kind: "invalid", field: "name" };
  }
  const timezone = input.timezone ?? current?.timezone ?? OLD_DEFAULTS.timezone;
  if (!isTimeZone(timezone)) {
    return { kind: "invalid", field: "timezone" };
  }
  const times = oldTimesOf(current, input, timezone);
  if ("kind" in times) {
    return times;
  }
  const kind = input.kind ?? current?.kind ?? OLD_DEFAULTS.kind;
  const cityId = input.cityId === undefined ? (current?.cityId ?? null) : input.cityId;
  if (kind === "virtual" && cityId !== null) {
    return { kind: "invalid", field: "cityId" };
  }
  const interests = input.interests ?? current?.interests ?? [];
  if (interests.length > MAX_EVENT_INTERESTS || new Set(interests).size !== interests.length) {
    return { kind: "invalid", field: "interests" };
  }
  const access = input.access ?? current?.access ?? OLD_DEFAULTS.access;
  const joinMethods = [
    ...new Set(input.joinMethods ?? current?.joinMethods ?? OLD_DEFAULTS.joinMethods),
  ];
  if (joinMethods.length === 0 || (joinMethods.includes("public_list") && access !== "public")) {
    return { kind: "invalid", field: "joinMethods" };
  }
  return {
    nameAr,
    nameEn,
    kind,
    venueAr:
      input.venue === undefined ? (current?.venue.ar ?? null) : oldBlankToNull(input.venue.ar),
    venueEn:
      input.venue === undefined ? (current?.venue.en ?? null) : oldBlankToNull(input.venue.en),
    access,
    joinMethods,
    timezone,
    dayStartHour: input.dayStartHour ?? current?.dayStartHour ?? OLD_DEFAULTS.dayStartHour,
    ...times,
    venuePin: input.venuePin === undefined ? (current?.venuePin ?? null) : input.venuePin,
    venueRadiusM: input.venueRadiusM ?? current?.venueRadiusM ?? VENUE_RADIUS.default,
    cityId,
    interests,
  };
}

// ---- The generator --------------------------------------------------------------------------------------------------

const BASE: EventRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  joinCode: "ABC234",
  name: { ar: "ملتقى", en: "Meetup" },
  kind: "virtual",
  venue: { ar: "الرياض", en: "Riyadh" },
  access: "unlisted",
  joinMethods: ["link"],
  timezone: "Asia/Dubai",
  dayStartHour: 6,
  startsAt: new Date("2030-11-01T05:00:00Z"),
  endsAt: new Date("2030-11-01T13:00:00Z"),
  status: "draft",
  statusNow: "draft",
  createdAt: new Date("2030-01-01T00:00:00Z"),
  rankingOn: true,
  rankingTodayOn: true,
  shareQuestsOn: true,
  meetSomeoneOn: true,
  miniGamesOn: true,
  communityOn: true,
  flashQuestsOn: true,
  boostsOn: true,
  helpDeskOn: true,
  questRatingsOn: false,
  shopOn: true,
  pollsOn: true,
  mapsOn: true,
  agendaOn: true,
  branding: { accent: null },
  layout: DEFAULT_LAYOUT,
  terms: DEFAULT_TERMS,
  texts: NO_EVENT_TEXTS,
  venuePin: { lat: 24.7136, lng: 46.6753 },
  venueRadiusM: 800,
  cityId: null,
  interests: [],
  suspension: null,
};

const ABSENT = Symbol("absent");
const TEXTS = [
  {},
  { ar: " " },
  { en: "" },
  { en: "Meetup" },
  { ar: "ملتقى", en: "  Meetup  " },
  { ar: "ملتقى" },
  { ar: undefined, en: undefined },
];
const BILINGUALS = [
  { ar: null, en: null },
  { ar: "ملتقى", en: null },
  { ar: null, en: "Meetup" },
  { ar: "ملتقى", en: "Meetup" },
];
const ZONES = ["Asia/Riyadh", "Asia/Dubai", "UTC", "America/New_York", "Mars/Olympus", "", "utc"];
const WALL_TIMES = [
  "2030-11-01T09:00",
  "2030-11-01T17:00",
  "2030-11-01T08:00",
  "2030-11-02T09:00",
  "2030-02-30T10:00",
  "2030-11-01 09:00",
  "",
];
const DATES = [
  null,
  new Date("2030-11-01T05:00:00Z"),
  new Date("2030-11-01T13:00:00Z"),
  new Date("2030-11-02T05:00:00Z"),
];
const KINDS = ["physical", "virtual", "workplace"] as const;
const ACCESS = ["public", "unlisted", "private"] as const;
const METHODS = [
  [],
  ["code"],
  ["link", "link"],
  ["code", "qr", "link"],
  ["public_list"],
  ["public_list", "code"],
  ["qr", "public_list", "qr"],
] as const;
const INTERESTS = [
  [],
  ["music"],
  ["music", "food"],
  ["music", "music"],
  ["a", "b", "c"],
  ["a", "b", "c", "d"],
];
const PINS = [null, { lat: 24.7136, lng: 46.6753 }, { lat: 0, lng: 0 }];
const CITIES = [null, "riyadh", "jeddah"];

function recordOf(r: Rng): EventRecord {
  return {
    ...BASE,
    name: r.next() < 0.1 ? r.pick(BILINGUALS) : r.pick(BILINGUALS.slice(1)),
    kind: r.pick(KINDS),
    venue: r.pick(BILINGUALS),
    access: r.pick(ACCESS),
    joinMethods: r.pick(METHODS.filter((methods) => methods.length > 0)),
    timezone: r.next() < 0.9 ? r.pick(ZONES.slice(0, 4)) : r.pick(ZONES),
    dayStartHour: r.pick([0, 4, 6, 23]),
    startsAt: r.next() < 0.1 ? r.pick(DATES) : r.pick(DATES.slice(1, 3)),
    endsAt: r.next() < 0.1 ? r.pick(DATES) : r.pick(DATES.slice(2)),
    venuePin: r.pick(PINS),
    venueRadiusM: r.pick([100, 800, 20_000]),
    cityId: r.pick(CITIES),
    interests: r.pick(INTERESTS.slice(0, 3)),
  };
}

/** Each field absent (no key) about a third of the time, else one of its values, mostly ones the field takes. */
function inputOf(r: Rng): EventInput {
  const often = <T>(good: readonly T[], all: readonly T[]): readonly T[] =>
    r.next() < 0.15 ? all : good;
  const fields: Record<string, readonly unknown[]> = {
    name: often(TEXTS.slice(3, 6), TEXTS),
    kind: KINDS,
    venue: TEXTS,
    access: ACCESS,
    joinMethods: often(METHODS.slice(1, 4), METHODS),
    timezone: often(ZONES.slice(0, 4), ZONES),
    dayStartHour: [0, 4, 12, 23],
    startsAt: often(WALL_TIMES.slice(0, 4), WALL_TIMES),
    endsAt: often(WALL_TIMES.slice(0, 4), WALL_TIMES),
    venuePin: PINS,
    venueRadiusM: [100, 1000, 20_000, 5],
    cityId: CITIES,
    interests: often(INTERESTS.slice(0, 3), INTERESTS),
    template: ["conference", "nope"],
  };
  const input: Record<string, unknown> = {};
  for (const [name, values] of Object.entries(fields)) {
    const value = r.next() < 0.35 ? ABSENT : r.pick(values);
    if (value !== ABSENT) {
      input[name] = value;
    }
  }
  return input as EventInput;
}

const labelOf = (value: unknown): string =>
  "field" in (value as object) ? `invalid:${String((value as { field: unknown }).field)}` : "done";

describe("event merge characterisation", () => {
  it(`answers as before over ${CASES} generated cases`, () => {
    const r = rng(1_109_2026);
    const seen = new Map<string, number>();
    for (let index = 0; index < CASES; index += 1) {
      const current = r.next() < 0.3 ? undefined : recordOf(r);
      const input = inputOf(r);
      const before = oldMerge(current, input);
      const after = merge(current, input);
      expect({ index, current, input, after }).toStrictEqual({
        index,
        current,
        input,
        after: before,
      });
      expect(keysOf(after)).toStrictEqual(keysOf(before));
      if (!("field" in before)) {
        // The pin and the interests are handed on as the very objects sent or stored.
        const made = after as typeof before;
        expect(made.venuePin === input.venuePin).toBe(before.venuePin === input.venuePin);
        expect(made.interests === current?.interests).toBe(before.interests === current?.interests);
        expect(made.interests === input.interests).toBe(before.interests === input.interests);
      }
      const label = labelOf(before);
      seen.set(label, (seen.get(label) ?? 0) + 1);
    }
    for (const label of [
      "invalid:name",
      "invalid:timezone",
      "invalid:startsAt",
      "invalid:endsAt",
      "invalid:cityId",
      "invalid:interests",
      "invalid:joinMethods",
    ]) {
      expect(seen.get(label) ?? 0, label).toBeGreaterThan(20);
    }
    expect(seen.get("done") ?? 0).toBeGreaterThan(CASES / 10);
  });
});
