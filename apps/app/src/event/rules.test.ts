import { describe, expect, it } from "vitest";
import { readRules, rulesAnswer } from "#src/event/rules-api.ts";

const RULES = { block: { ar: ["سطر"], en: ["A line"] }, text: { ar: null, en: "Bring your ID." } };
const ok = (body: unknown) => ({ kind: "ok" as const, status: 200, body, headers: new Headers() });
const error = (status: number) => ({
  kind: "error" as const,
  status,
  code: "not_found",
  message: null,
  details: {},
  headers: new Headers(),
});

describe("the event's official rules", () => {
  it("reads the rules and refuses anything else", () => {
    expect(readRules({ rules: RULES })).toEqual(RULES);
    expect(readRules({ rules: { block: null, text: { ar: "اقرأ", en: null } } })).toBeDefined();
    expect(readRules({ rules: { block: { ar: [1], en: [] }, text: RULES.text } })).toBeUndefined();
    expect(readRules({ rules: { block: null, text: { ar: 1, en: null } } })).toBeUndefined();
    expect(readRules({ rules: { block: null, text: { ar: null, en: 2 } } })).toBeUndefined();
    expect(readRules({ rules: { block: null } })).toBeUndefined();
    expect(readRules({ rules: null })).toBeUndefined();
    expect(readRules("x")).toBeUndefined();
  });

  it("answers the rules, none for a 404, and network for anything else", () => {
    expect(rulesAnswer(ok({ rules: RULES }))).toEqual({ kind: "rules", rules: RULES });
    expect(rulesAnswer(ok({ nope: 1 }))).toEqual({ kind: "network" });
    expect(rulesAnswer(error(404))).toEqual({ kind: "none" });
    expect(rulesAnswer(error(500))).toEqual({ kind: "network" });
    expect(rulesAnswer({ kind: "network" })).toEqual({ kind: "network" });
    expect(rulesAnswer({ kind: "signed_out" })).toEqual({ kind: "network" });
  });
});
