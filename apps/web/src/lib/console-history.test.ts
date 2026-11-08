import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MESSAGES } from "@questify/shared";
import { HISTORY_GROUPS, historyKeyOf, historyReasonKeyOf } from "#src/lib/console-history.ts";

const API = join(__dirname, "../../../api");
const ACTION = /^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/;

/** Actions an audit writer can produce that are shown by their stored name, each with why. */
const UNWORDED: Readonly<Record<string, string>> = {};

/**
 * Writers whose action is built at run time, with every action they can produce. A new writer of this kind fails
 * the test below until it is added here, so a new action cannot slip past the check.
 */
const DYNAMIC: Readonly<Record<string, readonly string[]>> = {
  set_audience: ["category.audience", "reward.audience"],
  admin_tier_change: ["player.revoke_tiers", "player.restore_tiers"],
  souvenir_action: ["souvenir.activate", "souvenir.stop", "souvenir.delete"],
};

/** SQL functions that take the action (or its last word) as an argument: the argument that holds it, and its prefix. */
const WRAPPERS: Readonly<Record<string, Readonly<{ arg: number; prefix: string }>>> = {
  catalog_audit: { arg: 0, prefix: "" },
  invitation_audit: { arg: 2, prefix: "" },
  souvenir_audit: { arg: 1, prefix: "" },
  questify_audit: { arg: 1, prefix: "questify." },
  daily_audit: { arg: 1, prefix: "daily." },
  owner_email_audit: { arg: 2, prefix: "owner_email." },
};

function filesUnder(dir: string, pattern: RegExp): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

const readAll = (files: string[]) => files.map((file) => readFileSync(file, "utf8"));

/** The text inside a bracket opened just before `from`, and the index after its closing one (quotes are skipped). */
function balanced(text: string, from: number): { body: string; end: number } {
  let depth = 1;
  let quoted = false;
  let index = from;
  for (; index < text.length && depth > 0; index += 1) {
    const char = text.charAt(index);
    if (char === "'") {
      quoted = !quoted;
    } else if (!quoted) {
      depth += char === "(" ? 1 : char === ")" ? -1 : 0;
    }
  }
  return { body: text.slice(from, index - 1), end: index };
}

/** Splits a list at its top-level commas. */
function splitTop(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = "";
  for (const char of list) {
    if (char === "'") {
      quoted = !quoted;
    }
    if (!quoted && char === ",") {
      if (depth === 0) {
        parts.push(current);
        current = "";
        continue;
      }
    }
    if (!quoted) {
      depth += char === "(" ? 1 : char === ")" ? -1 : 0;
    }
    current += char;
  }
  return [...parts, current];
}

const sqlLiterals = (text: string): string[] =>
  [...text.matchAll(/'([^']*)'/g)].map((one) => one[1] ?? "").filter((one) => ACTION.test(one));

function functionAt(text: string, position: number): string {
  const found = [
    ...text.slice(0, position).matchAll(/CREATE (?:OR REPLACE )?FUNCTION ([a-z_0-9]+)/g),
  ];
  return found.at(-1)?.[1] ?? "(none)";
}

type Found = { actions: Set<string>; dynamicIn: Set<string> };

/** The action of every `INSERT INTO audit_log` in a migration: its literals, or the function that builds it. */
function readInserts(text: string, found: Found): void {
  for (const insert of text.matchAll(/INSERT INTO (?:public\.)?audit_log\s*\(/g)) {
    const columns = balanced(text, insert.index + insert[0].length);
    const place = columns.body
      .split(",")
      .map((one) => one.trim())
      .indexOf("action");
    const rest = text.slice(columns.end);
    const values = /^\s*VALUES\s*\(/i.exec(rest);
    const list = values
      ? balanced(rest, values[0].length).body
      : rest.slice(0, rest.indexOf(";")).replace(/^\s*SELECT\s+/i, "");
    const expression = splitTop(list)[place] ?? "";
    if (/\|\|/.test(expression) || !/^\s*(CASE\b[\s\S]*\bEND|'[^']*')\s*$/.test(expression)) {
      found.dynamicIn.add(functionAt(text, insert.index));
    }
    sqlLiterals(expression).forEach((one) => found.actions.add(one));
  }
}

/** The actions named in calls of the SQL functions that write an audit entry for the caller. */
function readWrapperCalls(text: string, found: Found): void {
  for (const [name, { arg, prefix }] of Object.entries(WRAPPERS)) {
    for (const call of text.matchAll(new RegExp(`(?:PERFORM|SELECT)\\s+${name}\\(`, "g"))) {
      const { body } = balanced(text, call.index + call[0].length);
      const expression = splitTop(body)[arg] ?? "";
      if (/\|\|/.test(expression)) {
        found.dynamicIn.add(functionAt(text, call.index));
      }
      [...expression.matchAll(/'([a-z_.]+)'/g)]
        .map((one) => prefix + (one[1] ?? ""))
        .filter((one) => ACTION.test(one))
        .forEach((one) => found.actions.add(one));
    }
  }
}

/** The actions the API's TypeScript passes to `recordAudit` or its helpers: the literals after each `action`. */
function readTypeScript(text: string, found: Found): void {
  const windows = [
    ...[...text.matchAll(/\baction\b[^;]*?(?:,\s*\n|;)/g)].map((one) => one[0]),
    ...[...text.matchAll(/const \[action,[\s\S]{0,300}/g)].map((one) => one[0]),
  ];
  for (const window of windows) {
    for (const one of window.matchAll(/["'`]([a-z][a-z_.]*)["'`]/g)) {
      if (ACTION.test(one[1] ?? "")) {
        found.actions.add(one[1] ?? "");
      }
    }
  }
}

function writtenActions(): Found {
  const found: Found = { actions: new Set(), dynamicIn: new Set() };
  const sources = filesUnder(join(API, "src"), /\.ts$/).filter((file) => !/\.test\./.test(file));
  readAll(sources).forEach((text) => readTypeScript(text, found));
  for (const text of readAll(filesUnder(join(API, "migrations"), /\.sql$/))) {
    readInserts(text, found);
    readWrapperCalls(text, found);
  }
  return found;
}

describe("the words for every audit action the API can write", () => {
  const found = writtenActions();
  // The writers that build their action at run time, apart from the wrappers (their calls are read above).
  const unknownBuilders = [...found.dynamicIn].filter(
    (name) => !(name in DYNAMIC) && !(name in WRAPPERS),
  );
  const all = new Set([...found.actions, ...Object.values(DYNAMIC).flat()]);

  it("finds the writers of every kind", () => {
    expect(all.size).toBeGreaterThan(250);
    for (const sample of [
      "event.create",
      "event.rank_prizes",
      "organizer.feature_override.set",
      "organizer.member.leave",
      "event.player_unban",
      "event.lifecycle",
      "souvenir.stop",
      "daily.word_set",
      "owner_email.stop",
      "catalog.xp_table.revert",
      "invitation.hold",
      "player.revoke_tiers",
    ]) {
      expect(all.has(sample), sample).toBe(true);
    }
  });

  it("knows every writer that builds its action at run time", () => {
    expect(unknownBuilders).toEqual([]);
  });

  it("has words for every action, or lists it as shown by its stored name", () => {
    const without = [...all].filter(
      (action) => historyKeyOf(action) === undefined && !(action in UNWORDED),
    );
    expect(without.toSorted()).toEqual([]);
  });

  it("lists only actions that are still written and still without words", () => {
    const stale = Object.keys(UNWORDED).filter(
      (action) => !all.has(action) || historyKeyOf(action) !== undefined,
    );
    expect(stale).toEqual([]);
  });

  it("words only actions that some writer can still produce", () => {
    const idle = HISTORY_GROUPS.flatMap(([, actions]) => actions).filter(
      (action) => !all.has(action),
    );
    expect(idle).toEqual([]);
  });
});

describe("the history texts", () => {
  const keys = Object.keys(MESSAGES).filter((key) => key.startsWith("console.history."));
  const used = new Set<string>(HISTORY_GROUPS.map(([key]) => key));

  it("gives each action to one text, and each text to at least one action", () => {
    const actions = HISTORY_GROUPS.flatMap(([, list]) => list);
    expect(actions.filter((action, at) => actions.indexOf(action) !== at)).toEqual([]);
    expect(HISTORY_GROUPS.filter(([, list]) => list.length === 0)).toEqual([]);
    const kept = new Set(["console.history.reason"]);
    expect(keys.filter((key) => !used.has(key) && !kept.has(key))).toEqual([]);
  });

  it("reads the console's own reads and searches as one text", () => {
    expect(historyKeyOf("console.player_ledger_read")).toBe("console.history.read");
    expect(historyKeyOf("console.players_search")).toBe("console.history.read");
    expect(historyKeyOf("marketing.consent_read")).toBe("console.history.read");
  });

  it("is written in the past, with no «تم», no Eastern digits and no full stop", () => {
    for (const key of keys) {
      const text = MESSAGES[key as keyof typeof MESSAGES];
      expect(text.ar, key).not.toMatch(/(^|\s)تم(ت|وا)?(\s|$)/);
      expect(text.ar + text.en, key).not.toMatch(/[٠-٩]|[.。]$/);
      expect(text.ar.trim(), key).not.toBe("");
      expect(text.en.trim(), key).not.toBe("");
    }
  });
});

describe("the reason beside a take-down", () => {
  it("words the six fixed codes with the reports' own words", () => {
    for (const code of ["offensive", "hateful", "sexual", "spam", "misleading", "other"]) {
      expect(historyReasonKeyOf("content.unpublish", code)).toBe(`reports.reason.${code}`);
    }
  });

  it("leaves a typed reason, an unknown code and any other action to be shown as they are", () => {
    expect(historyReasonKeyOf("organizer.suspend", "spam")).toBeUndefined();
    expect(historyReasonKeyOf("content.unpublish", "Unpaid invoice")).toBeUndefined();
    expect(historyReasonKeyOf("content.unpublish", "constructor")).toBeUndefined();
  });
});
