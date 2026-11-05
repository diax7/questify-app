import { describe, expect, it } from "vitest";
import { functionsPerCompletion, parseExplain, statementsPerCompletion } from "./profile-stats.mjs";

describe("functionsPerCompletion", () => {
  const before = [
    { name: "record_completion", calls: 10, total: 50, self: 20 },
    { name: "idle", calls: 4, total: 8, self: 8 },
  ];

  it("divides what was spent between the snapshots by the completions, most self time first", () => {
    const after = [
      { name: "record_completion", calls: 110, total: 650, self: 220 },
      { name: "idle", calls: 4, total: 8, self: 8 },
      { name: "xp_credit", calls: 100, total: 300, self: 300 },
    ];
    expect(functionsPerCompletion(before, after, 100)).toEqual([
      { name: "xp_credit", calls: 1, totalMs: 3, selfMs: 3 },
      { name: "record_completion", calls: 1, totalMs: 6, selfMs: 2 },
    ]);
  });

  it("rounds to 0.01 and keeps a function called less than once a completion", () => {
    const after = [{ name: "record_completion", calls: 11, total: 50.333, self: 20.111 }];
    expect(functionsPerCompletion(before, after, 3)).toEqual([
      { name: "record_completion", calls: 0.33, totalMs: 0.11, selfMs: 0.04 },
    ]);
  });

  it("refuses fewer than one completion", () => {
    expect(() => functionsPerCompletion(before, before, 0)).toThrow(RangeError);
  });
});

describe("parseExplain", () => {
  it("reads the duration, the statement and its triggers from a JSON plan", () => {
    const plan = {
      "Query Text": "INSERT INTO ledger_entry\n   (a) VALUES ($1)",
      Plan: { "Node Type": "ModifyTable" },
      Triggers: [{ "Trigger Name": "ledger_xp", Relation: "ledger_entry", Time: 3.2, Calls: 1 }],
    };
    expect(parseExplain(`duration: 4.512 ms  plan:\n${JSON.stringify(plan, null, 2)}`)).toEqual({
      ms: 4.512,
      query: "INSERT INTO ledger_entry (a) VALUES ($1)",
      triggers: [{ name: "ledger_xp", ms: 3.2, calls: 1 }],
    });
  });

  it("answers null for any other notice and an empty list for a plan without triggers", () => {
    expect(parseExplain("relation already exists, skipping")).toBeNull();
    expect(parseExplain('duration: 0.1 ms  plan:\n{"Query Text": "SELECT 1"}')?.triggers).toEqual(
      [],
    );
  });
});

describe("statementsPerCompletion", () => {
  it("adds statements by text and triggers by name, a completion's share, most first", () => {
    const plans = [
      { ms: 2, query: "SELECT a", triggers: [] },
      { ms: 4, query: "INSERT b", triggers: [{ name: "ledger_xp", ms: 3, calls: 1 }] },
      { ms: 2, query: "SELECT a", triggers: [] },
      { ms: 4, query: "INSERT b", triggers: [{ name: "ledger_xp", ms: 1, calls: 1 }] },
    ];
    expect(statementsPerCompletion(plans, 2)).toEqual({
      statements: [
        { query: "INSERT b", calls: 1, ms: 4 },
        { query: "SELECT a", calls: 1, ms: 2 },
      ],
      triggers: [{ trigger: "ledger_xp", calls: 1, ms: 2 }],
    });
  });

  it("refuses fewer than one completion", () => {
    expect(() => statementsPerCompletion([], 0)).toThrow(RangeError);
  });
});
