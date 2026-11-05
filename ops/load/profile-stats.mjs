// Arithmetic of the one-at-a-time profile (profile.mjs, T-804e): per-function time from two `pg_stat_user_functions`
// snapshots, and per-statement time from auto_explain's notices.

const round2 = (/** @type {number} */ value) => Math.round(value * 100) / 100;

/**
 * @typedef {{ name: string; calls: number; total: number; self: number }} FunctionStat
 *   one row of pg_stat_user_functions: calls, total_time and self_time in ms
 */

/**
 * Each function's calls and ms a completion between two snapshots, most self time first; functions not called in
 * between are left out. A function only in `after` counts from zero.
 *
 * @param {readonly FunctionStat[]} before
 * @param {readonly FunctionStat[]} after
 * @param {number} completions the completions made between the snapshots, at least 1
 */
export function functionsPerCompletion(before, after, completions) {
  if (!(completions >= 1)) {
    throw new RangeError(`completions must be at least 1; got ${completions}.`);
  }
  const old = new Map(before.map((row) => [row.name, row]));
  return after
    .map((row) => {
      const was = old.get(row.name) ?? { calls: 0, total: 0, self: 0 };
      return {
        name: row.name,
        calls: round2((row.calls - was.calls) / completions),
        totalMs: round2((row.total - was.total) / completions),
        selfMs: round2((row.self - was.self) / completions),
      };
    })
    .filter((row) => row.calls > 0)
    .toSorted((a, b) => b.selfMs - a.selfMs || a.name.localeCompare(b.name));
}

const PREFIX = /^duration: ([0-9.]+) ms\s+plan:\s*/;

/**
 * One auto_explain notice in JSON format (`duration: <ms> ms  plan:` then the plan), or null for any other notice.
 *
 * @param {string} message
 * @returns {{ ms: number; query: string; triggers: { name: string; ms: number; calls: number }[] } | null}
 */
export function parseExplain(message) {
  const head = PREFIX.exec(message);
  if (head === null) {
    return null;
  }
  const plan = JSON.parse(message.slice(head[0].length));
  return {
    ms: Number(head[1]),
    query: String(plan["Query Text"] ?? "")
      .replaceAll(/\s+/g, " ")
      .trim(),
    triggers: (plan.Triggers ?? []).map((t) => ({
      name: String(t["Trigger Name"]),
      ms: Number(t.Time),
      calls: Number(t.Calls),
    })),
  };
}

/**
 * Statements and triggers by time a completion, most first. A statement's time includes the statements it runs
 * (a function call holds its body's), so the rows overlap; a trigger's time is counted once, on the statement firing it.
 *
 * @param {readonly NonNullable<ReturnType<typeof parseExplain>>[]} plans
 * @param {number} completions at least 1
 */
export function statementsPerCompletion(plans, completions) {
  if (!(completions >= 1)) {
    throw new RangeError(`completions must be at least 1; got ${completions}.`);
  }
  const statements = new Map();
  const triggers = new Map();
  for (const plan of plans) {
    addTime(statements, plan.query, plan.ms, 1);
    for (const trigger of plan.triggers) {
      addTime(triggers, trigger.name, trigger.ms, trigger.calls);
    }
  }
  return {
    statements: rowsOf(statements, "query", completions),
    triggers: rowsOf(triggers, "trigger", completions),
  };
}

function addTime(into, key, ms, calls) {
  const row = into.get(key) ?? { ms: 0, calls: 0 };
  into.set(key, { ms: row.ms + ms, calls: row.calls + calls });
}

function rowsOf(into, key, completions) {
  return [...into.entries()]
    .map(([name, row]) => ({
      [key]: name,
      calls: round2(row.calls / completions),
      ms: round2(row.ms / completions),
    }))
    .toSorted((a, b) => b.ms - a.ms || String(a[key]).localeCompare(String(b[key])));
}
