import { describe, expect, it } from "vitest";
import { translatorFor } from "#src/lib/language.ts";
import { claimOf, deadlineLocal, stepBody, stepRequest, stepWords } from "#src/lib/results-step.ts";

const en = translatorFor("en");
const ar = translatorFor("ar");
const ZONE = "Asia/Riyadh";

describe("the deadline the owner picked (claimOf)", () => {
  const cases: readonly [string, string, boolean][] = [
    ["empty", "", false],
    ["a full local value", "2026-12-01T10:00", true],
  ];
  it.each(cases)("%s", (_name, local, readable) => {
    const claim = claimOf(local, ZONE, "en");
    expect(claim !== null).toBe(readable);
  });

  it("throws on text that is no local date-time (a date field never gives one)", () => {
    expect(() => claimOf("not a date", ZONE, "en")).toThrow(RangeError);
  });

  it("reads the wall clock in the event's zone (UTC+3)", () => {
    const claim = claimOf("2026-12-01T10:00", ZONE, "en");
    expect(claim?.at.toISOString()).toBe("2026-12-01T07:00:00.000Z");
    expect(claim?.shown).toBe("Tue, 1 Dec 2026, 10:00 (Riyadh time)");
    expect(claimOf("2026-12-01T10:00", ZONE, "ar")?.shown).toContain("ديسمبر");
  });
});

describe("the deadline field's value", () => {
  const cases: readonly [string, string | null, string | null, string][] = [
    ["typed wins", "2026-12-02T09:30", "2026-12-01T07:00:00.000Z", "2026-12-02T09:30"],
    ["an emptied field stays empty", "", "2026-12-01T07:00:00.000Z", ""],
    ["no typing and no default", null, null, ""],
    ["no typing: the default in the zone", null, "2026-12-01T07:00:00.000Z", "2026-12-01T10:00"],
  ];
  it.each(cases)("%s", (_name, typed, fallback, expected) => {
    expect(deadlineLocal(typed, fallback, ZONE)).toBe(expected);
  });
});

describe("the confirm sheet's words", () => {
  it("confirm", () => {
    expect(stepWords(en, "confirm")).toEqual({
      title: en("results.confirmTitle"),
      action: en("results.confirm"),
    });
  });
  it("reveal", () => {
    expect(stepWords(ar, "reveal")).toEqual({
      title: ar("results.revealTitle"),
      action: ar("results.reveal"),
    });
  });
});

describe("the confirm sheet's body", () => {
  it("confirm without flags is the plain line", () => {
    expect(stepBody(en, "confirm", [], undefined)).toBe(en("results.confirmBody"));
  });
  it("confirm with flags names them with the Arabic comma", () => {
    expect(stepBody(en, "confirm", ["@a", "@b"], "ignored")).toBe(
      `${en("results.confirmBody")} ${en("results.confirmFlagged", { names: "@a، @b" })}`,
    );
  });
  it("confirm with one flag", () => {
    expect(stepBody(ar, "confirm", ["@a"], undefined)).toBe(
      `${ar("results.confirmBody")} ${ar("results.confirmFlagged", { names: "@a" })}`,
    );
  });
  it("reveal names the deadline", () => {
    expect(stepBody(en, "reveal", ["@a"], "1 Dec")).toBe(
      en("results.revealBody", { deadline: "1 Dec" }),
    );
  });
  it("reveal with no readable deadline names an empty one", () => {
    expect(stepBody(en, "reveal", [], undefined)).toBe(en("results.revealBody", { deadline: "" }));
  });
});

describe("the request a step sends", () => {
  const places = [{ enrollmentId: "e1" }, { enrollmentId: "e2" }];
  const at = new Date("2026-12-01T07:00:00.000Z");
  it("confirm sends the places seen, in order", () => {
    expect(stepRequest(en, "confirm", { places } as never, at)).toEqual({
      path: "/results/confirm",
      payload: { expected: ["e1", "e2"] },
      said: en("results.confirmed"),
    });
  });
  it("confirm with no places sends an empty list", () => {
    expect(stepRequest(en, "confirm", { places: [] } as never, undefined).payload).toEqual({
      expected: [],
    });
  });
  it("reveal sends the deadline as an instant", () => {
    expect(stepRequest(ar, "reveal", { places } as never, at)).toEqual({
      path: "/results/reveal",
      payload: { claimUntil: "2026-12-01T07:00:00.000Z" },
      said: ar("results.revealed"),
    });
  });
  it("reveal without a readable deadline sends an empty one", () => {
    expect(stepRequest(en, "reveal", { places } as never, undefined).payload).toEqual({
      claimUntil: "",
    });
  });
});
