import { describe, expect, it } from "vitest";
import {
  asksDatesNext,
  problemText,
  saveQuestion,
  sessionEnded,
  type SaveQuestion,
} from "#src/lib/event-form-rules.ts";
import { draftOf, type EventView } from "#src/lib/events.ts";
import { translatorFor } from "#src/lib/language.ts";
import { describeProblem } from "#src/lib/sign-in-errors.ts";

const en = translatorFor("en");
const ar = translatorFor("ar");

const EVENT: EventView = {
  id: "e1",
  joinCode: "ABC234",
  name: { ar: "ملتقى نجد", en: null },
  kind: "physical",
  venue: { ar: null, en: "Riyadh Front" },
  venuePin: null,
  venueRadiusM: 1000,
  cityId: null,
  access: "public",
  joinMethods: ["code", "qr"],
  timezone: "Asia/Riyadh",
  dayStartHour: 4,
  startsAt: "2030-11-01T06:00:00.000Z",
  endsAt: "2030-11-01T14:00:00.000Z",
  status: "scheduled",
  statusNow: "scheduled",
  ranking: true,
  rankingToday: true,
  shareQuests: true,
  meetSomeone: true,
  miniGames: true,
  community: true,
};
const DRAFT_EVENT: EventView = { ...EVENT, status: "draft", statusNow: "draft" };

describe("which refusals end the session", () => {
  const cases: readonly [string, unknown, boolean][] = [
    ["unauthenticated", { code: "unauthenticated" }, true],
    ["session_expired", { code: "session_expired" }, true],
    ["another code", { code: "invalid_event" }, false],
    ["a numeric code", { code: 401 }, false],
    ["no code", { message: "x" }, false],
    ["no body", undefined, false],
    ["a string body", "unauthenticated", false],
    ["null", null, false],
  ];
  it.each(cases)("%s", (_name, body, ended) => {
    expect(sessionEnded(body)).toBe(ended);
  });
});

describe("the words for a refusal", () => {
  const fields = [
    "name",
    "timezone",
    "startsAt",
    "endsAt",
    "joinMethods",
    "cityId",
    "interests",
    "template",
  ] as const;
  it.each(fields)("invalid_event on %s names the field to fix", (field) => {
    const body = { code: "invalid_event", details: { field } };
    expect(problemText(body, "en", en)).toBe(
      en(`events.invalid.${field}` as "events.invalid.name"),
    );
    expect(problemText(body, "ar", ar)).toBe(
      ar(`events.invalid.${field}` as "events.invalid.name"),
    );
  });

  const generic: readonly [string, unknown][] = [
    ["an unknown field", { code: "invalid_event", details: { field: "venue" } }],
    ["a numeric field", { code: "invalid_event", details: { field: 3 } }],
    ["no field", { code: "invalid_event", details: {} }],
    ["no details", { code: "invalid_event" }],
    ["another code with a known field", { code: "forbidden", details: { field: "name" } }],
    ["no body", undefined],
    ["null", null],
  ];
  it.each(generic)("%s falls back to the API's own message", (_name, body) => {
    expect(problemText(body, "en", en)).toBe(describeProblem(body, "en", en).text);
    expect(problemText(body, "ar", ar)).toBe(describeProblem(body, "ar", ar).text);
  });
});

describe("what a save must confirm first", () => {
  const live: EventView = { ...EVENT, status: "live", statusNow: "live" };
  const base = draftOf(EVENT);
  const cases: readonly [string, Parameters<typeof saveQuestion>, SaveQuestion | null][] = [
    ["nothing changed", [base, EVENT], null],
    ["access changed", [{ ...base, access: "private" }, EVENT], "access"],
    ["zone changed on a scheduled event", [{ ...base, timezone: "Asia/Dubai" }, EVENT], "dates"],
    ["start changed on a live event", [{ ...base, startsAt: "2030-11-01T10:00" }, live], "dates"],
    ["end changed on a live event", [{ ...base, endsAt: "2030-11-01T18:00" }, live], "dates"],
    [
      "times changed on a draft",
      [{ ...draftOf(DRAFT_EVENT), startsAt: "2030-11-01T10:00" }, DRAFT_EVENT],
      null,
    ],
    [
      "access and times changed: access first",
      [{ ...base, access: "private", startsAt: "2030-11-01T10:00" }, EVENT],
      "access",
    ],
    ["only the name changed", [{ ...base, nameEn: "New" }, EVENT], null],
  ];
  it.each(cases)("%s", (_name, args, expected) => {
    expect(saveQuestion(...args)).toBe(expected);
  });
});

describe("whether the access answer leads to the times question", () => {
  const base = draftOf(EVENT);
  const moved = { ...base, access: "private" as const, startsAt: "2030-11-01T10:00" };
  const cases: readonly [string, Parameters<typeof asksDatesNext>, boolean][] = [
    ["access asked, times moved", ["access", moved, EVENT], true],
    ["access asked, times kept", ["access", { ...base, access: "private" }, EVENT], false],
    ["dates already asked", ["dates", moved, EVENT], false],
    ["nothing asked", [null, moved, EVENT], false],
    ["no draft", ["access", null, EVENT], false],
    ["no event", ["access", moved, null], false],
    ["a draft event never moves times", ["access", moved, DRAFT_EVENT], false],
  ];
  it.each(cases)("%s", (_name, args, expected) => {
    expect(asksDatesNext(...args)).toBe(expected);
  });
});
