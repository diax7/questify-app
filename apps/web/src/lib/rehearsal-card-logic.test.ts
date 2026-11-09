import { describe, expect, it } from "vitest";
import {
  rehearsalActionPath,
  rehearsalOf,
  rehearsalWords,
  type RehearsalView,
} from "#src/lib/rehearsal.ts";

const EMPTY = { accounts: 0, completions: 0, points: 0, reservations: 0, flags: 0 };
const VIEW: RehearsalView = {
  code: "ABCD-2345",
  open: true,
  cap: 25,
  now: EMPTY,
  firstPlayAt: null,
  erasedAt: null,
  erased: null,
  wipedAtGoLive: null,
};

describe("the card read from an API answer (rehearsalOf)", () => {
  const cases: readonly [string, { ok: boolean; body: unknown }, RehearsalView | undefined][] = [
    ["a good answer", { ok: true, body: { rehearsal: VIEW } }, VIEW],
    ["a failed call with a good body", { ok: false, body: { rehearsal: VIEW } }, undefined],
    ["a failed call with a refusal", { ok: false, body: { code: "forbidden" } }, undefined],
    ["no body", { ok: true, body: undefined }, undefined],
    ["null body", { ok: true, body: null }, undefined],
    ["no card in the body", { ok: true, body: {} }, undefined],
    [
      "a card of the wrong shape",
      { ok: true, body: { rehearsal: { ...VIEW, cap: "25" } } },
      undefined,
    ],
  ];
  it.each(cases)("%s", (_name, result, expected) => {
    expect(rehearsalOf(result)).toEqual(expected);
  });
});

describe("where a confirmed action goes", () => {
  const base = "/v1/organizers/o1/events/e1/rehearsal";
  it("Change code posts to code", () => {
    expect(rehearsalActionPath(base, "rotate")).toBe(`${base}/code`);
  });
  it("Erase rehearsal posts to erase", () => {
    expect(rehearsalActionPath(base, "erase")).toBe(`${base}/erase`);
  });
});

describe("the confirmation's words", () => {
  it("Change code", () => {
    expect(rehearsalWords("rotate")).toEqual({
      title: "rehearsal.rotateConfirm",
      action: "rehearsal.rotate",
    });
  });
  it("Erase rehearsal", () => {
    expect(rehearsalWords("erase")).toEqual({
      title: "rehearsal.eraseConfirm",
      action: "rehearsal.erase",
    });
  });
});
