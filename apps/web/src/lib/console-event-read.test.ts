import { describe, expect, it } from "vitest";
import type { ActivationView } from "#src/lib/activation.ts";
import { readConsoleEvent } from "#src/lib/console.ts";

const VIEW: ActivationView = {
  state: "activated",
  requestedAt: null,
  note: null,
  limit: { mode: "hard", value: 300 },
  players: 240,
  alerts: [80],
  addons: ["bigScreen"],
};

const EVENT = {
  id: "e1",
  joinCode: "SPRING",
  name: { ar: null, en: "Spring" },
  status: "draft",
  statusNow: "draft",
  timezone: "Asia/Riyadh",
  startsAt: null,
  endsAt: null,
  organizer: { id: "o1", name: "Najd" },
  ownerEmail: "owner@najd.sa",
};

const withEvent = (change: Record<string, unknown>) => ({
  ...VIEW,
  event: { ...EVENT, ...change },
});

describe("readConsoleEvent, branch by branch", () => {
  const accepted: readonly [string, unknown][] = [
    ["the plain answer", withEvent({})],
    ["a name with both languages", withEvent({ name: { ar: "ربيع", en: "Spring" } })],
    ["a name with neither language", withEvent({ name: { ar: null, en: null } })],
    ["times as strings", withEvent({ startsAt: "2026-10-22T09:00:00Z", endsAt: "x" })],
    ["no owner e-mail", withEvent({ ownerEmail: null })],
    ["an organizer with only a name", withEvent({ organizer: { name: "Najd" } })],
    ["an extra field on the event", withEvent({ extra: 1 })],
  ];
  it.each(accepted)("returns the answer itself for %s", (_name, answer) => {
    expect(readConsoleEvent(answer)).toBe(answer);
  });

  const refused: readonly [string, unknown][] = [
    ["null", null],
    ["a string", "x"],
    ["a number", 3],
    ["an answer with no event", VIEW],
    ["an event that is null", { ...VIEW, event: null }],
    ["an event that is a string", { ...VIEW, event: "e1" }],
    ["a broken activation view", { ...withEvent({}), state: "paid" }],
    ["an activation view missing its players", { ...withEvent({}), players: "1" }],
    ["a numeric id", withEvent({ id: 1 })],
    ["a missing id", withEvent({ id: undefined })],
    ["a numeric join code", withEvent({ joinCode: 1 })],
    ["a name that is a string", withEvent({ name: "Spring" })],
    ["a name that is null", withEvent({ name: null })],
    ["a name with a numeric ar", withEvent({ name: { ar: 1, en: null } })],
    ["a name with a missing en", withEvent({ name: { ar: null } })],
    ["a numeric status", withEvent({ status: 1 })],
    ["a numeric statusNow", withEvent({ statusNow: 1 })],
    ["a missing statusNow", withEvent({ statusNow: undefined })],
    ["a numeric timezone", withEvent({ timezone: 1 })],
    ["a numeric startsAt", withEvent({ startsAt: 1 })],
    ["a missing startsAt", withEvent({ startsAt: undefined })],
    ["a numeric endsAt", withEvent({ endsAt: 1 })],
    ["a missing endsAt", withEvent({ endsAt: undefined })],
    ["an organizer that is null", withEvent({ organizer: null })],
    ["an organizer that is a string", withEvent({ organizer: "Najd" })],
    ["an organizer with a numeric name", withEvent({ organizer: { name: 1 } })],
    ["an organizer with no name", withEvent({ organizer: {} })],
    ["a numeric ownerEmail", withEvent({ ownerEmail: 3 })],
    ["a missing ownerEmail", withEvent({ ownerEmail: undefined })],
  ];
  it.each(refused)("returns undefined for %s", (_name, answer) => {
    expect(readConsoleEvent(answer)).toBeUndefined();
  });
});
