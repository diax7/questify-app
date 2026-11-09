import { TICKET_TEXT_MAX, type EventTicketKind, type MessageKey } from "@questify/shared";
import { describe, expect, it } from "vitest";
import type { SendAnswer } from "#src/event/help.ts";
import type { CenterCard } from "#src/help/center.ts";
import type { DeviceFacts } from "#src/help/device.ts";
import {
  cardBodyOf,
  deviceNoteOf,
  isReady,
  kindOf,
  placeholderKey,
  questLineOf,
  saidFor,
  saidProblem,
  saidText,
  type CenterInitial,
  type CenterSending,
} from "#src/help/ticket-form.ts";

const FACTS: DeviceFacts = {
  appVersion: "1.2.3",
  platform: "android",
  osVersion: "14",
  model: "Pixel",
};

describe("the kind a card sends", () => {
  it.each<[CenterCard, EventTicketKind | null, string | null]>([
    ["report", null, "report_player"],
    ["report", "question", "report_player"],
    ["app", null, "app_problem"],
    ["app", "prize", "app_problem"],
    ["suggestion", null, "suggestion"],
    ["suggestion", "problem", "suggestion"],
    ["event", null, null],
    ["event", "question", "question"],
    ["event", "prize", "prize"],
    ["event", "problem", "problem"],
  ])("%s card, chosen %s sends %s", (card, chosen, expected) => {
    expect(kindOf(card, chosen)).toBe(expected);
  });
});

describe("the hint in the request's box", () => {
  it.each([
    ["report_player", "help.placeholder.report"],
    ["question", "help.placeholder.question"],
    ["prize", "help.placeholder.problem"],
    ["problem", "help.placeholder.problem"],
    ["app_problem", "help.placeholder.app"],
    ["suggestion", "help.placeholder.suggestion"],
    ["praise", "help.placeholder.question"],
  ])("%s shows %s", (kind, key) => {
    expect(placeholderKey(kind)).toBe(key);
  });
});

describe("when the send button may be pressed", () => {
  const long = "x".repeat(TICKET_TEXT_MAX + 1);
  it.each<[string | null, string, string, DeviceFacts | null | undefined, boolean]>([
    [null, "hello", "", undefined, false],
    ["question", "hello", "", undefined, true],
    ["question", "", "", undefined, false],
    ["question", "   ", "", undefined, false],
    ["question", long, "", undefined, false],
    ["question", "x".repeat(TICKET_TEXT_MAX), "", undefined, true],
    ["report_player", "hello", "", undefined, false],
    ["report_player", "hello", "ab", undefined, false],
    ["report_player", "hello", "@ab", undefined, false],
    ["report_player", "hello", " @abc ", undefined, true],
    ["report_player", "hello", "abc", undefined, true],
    ["report_player", "", "abc", undefined, false],
    ["app_problem", "hello", "", null, false],
    ["app_problem", "hello", "", undefined, true],
    ["app_problem", "hello", "", FACTS, true],
    ["app_problem", "", "", FACTS, false],
    ["suggestion", "hello", "", null, true],
    ["prize", "hello", "ab", null, true],
  ])("kind %s, text %j, username %j, facts %j gives %s", (kind, text, username, facts, ready) => {
    expect(isReady(kind, text, username, facts)).toBe(ready);
  });
});

const t = (key: MessageKey) => `T:${key}`;

describe("what the form says after a send", () => {
  const message = { ar: "م", en: "m" };
  it.each<[SendAnswer, MessageKey | null, ReturnType<typeof saidFor>]>([
    [{ kind: "refused", message }, null, { problem: message }],
    [{ kind: "refused", message }, "help.sent", { problem: message }],
    [{ kind: "refused", message: null }, null, { problem: null }],
    [{ kind: "sent" }, "help.sent", { text: "T:help.sent" }],
    [{ kind: "network" }, "join.network", { text: "T:join.network" }],
    [{ kind: "too_many" }, "help.tooMany", { text: "T:help.tooMany" }],
    [{ kind: "signed_out" }, null, null],
  ])("answer %o with line %s", (answer, line, expected) => {
    expect(saidFor(answer, line, t)).toEqual(expected);
  });

  it("calls the translator only when there is a line", () => {
    const calls: string[] = [];
    saidFor({ kind: "signed_out" }, null, (key) => (calls.push(key), key));
    saidFor({ kind: "refused", message: null }, "help.sent", (key) => (calls.push(key), key));
    expect(calls).toEqual([]);
  });

  it.each([
    [null, null, null],
    [{ text: "hello" }, "hello", null],
    [{ text: "" }, "", null],
    [{ problem: { ar: "م", en: "m" } }, null, { ar: "م", en: "m" }],
    [{ problem: null }, null, null],
  ])("reads %o as text %j and problem %j", (said, text, problem) => {
    expect(saidText(said as never)).toEqual(text);
    expect(saidProblem(said as never)).toEqual(problem);
  });
});

describe("the lines above and below the box", () => {
  it.each<[string | null, string, string | null]>([
    [null, "question", null],
    [null, "report_player", null],
    ["Find the code", "question", "Find the code"],
    ["Find the code", "app_problem", "Find the code"],
    ["Find the code", "report_player", null],
    ["", "problem", ""],
  ])("quest %j on a %s request shows %j", (title, kind, expected) => {
    expect(questLineOf(title, kind)).toBe(expected);
  });

  it.each<[string, DeviceFacts | null | undefined, boolean]>([
    ["app_problem", FACTS, true],
    ["app_problem", null, false],
    ["app_problem", undefined, false],
    ["suggestion", FACTS, false],
    ["question", FACTS, false],
  ])("a %s request with facts %j shows the device line: %s", (kind, facts, shown) => {
    const note = deviceNoteOf(kind, facts);
    expect(note !== null).toBe(shown);
    if (shown) {
      expect(note).toContain("1.2.3");
    }
  });
});

const sending = (sendingOff: CenterSending["sendingOff"]): CenterSending => ({
  id: "e1",
  sendingOff,
});

const form = (fields: object) => ({
  kind: "form",
  eventId: null,
  questId: null,
  questTitle: null,
  initialKind: null,
  ...fields,
});

describe("what a card shows below its title", () => {
  const initial: CenterInitial = {
    card: "event",
    kind: "prize",
    questId: "q1",
    questTitle: "Find the code",
  };
  it.each<[CenterCard, CenterCard | null]>([
    ["report", null],
    ["report", "event"],
    ["app", "suggestion"],
    ["event", null],
  ])("a card %s while %s is open stays closed", (card, open) => {
    expect(cardBodyOf(card, open, sending(null), initial)).toEqual({ kind: "closed" });
  });

  it.each<[CenterCard]>([["report"], ["event"]])("%s needs an event from the profile", (card) => {
    expect(cardBodyOf(card, card, null, undefined)).toEqual({ kind: "picker" });
  });

  it.each<[CenterCard, CenterSending | null, object]>([
    ["report", sending(undefined), { kind: "loading" }],
    ["event", sending(undefined), { kind: "loading" }],
    ["report", sending("feature_off"), { kind: "off", why: "feature_off" }],
    ["event", sending("not_member"), { kind: "off", why: "not_member" }],
    ["event", sending("sending_closed"), { kind: "off", why: "sending_closed" }],
    ["report", sending(null), form({ eventId: "e1" })],
    [
      "event",
      sending(null),
      form({ eventId: "e1", questId: "q1", questTitle: "Find the code", initialKind: "prize" }),
    ],
    ["app", null, form({})],
    ["suggestion", null, form({})],
    ["app", sending(undefined), form({})],
    ["suggestion", sending("feature_off"), form({})],
    ["app", sending(null), form({})],
  ])("card %s with event %j", (card, event, expected) => {
    expect(cardBodyOf(card, card, event, initial)).toEqual(expected);
  });

  it("passes the opening quest only to the card it was meant for", () => {
    const forApp: CenterInitial = { card: "app", kind: null, questId: "q2", questTitle: null };
    expect(cardBodyOf("app", "app", null, forApp)).toEqual(form({ questId: "q2" }));
    expect(cardBodyOf("event", "event", sending(null), forApp)).toEqual(form({ eventId: "e1" }));
    expect(cardBodyOf("report", "report", sending(null), initial)).toEqual(form({ eventId: "e1" }));
  });
});
