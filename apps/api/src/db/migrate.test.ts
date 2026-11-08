import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EXIT_FAILED,
  EXIT_LOCK_CLASH,
  MAX_LOCK_CLASH_RETRIES,
  MigrationLockClashError,
  migrate,
  migrationExitCode,
  retryDelayMs,
} from "#src/db/migrate";

const LOCK_TIMEOUT = "SET LOCAL lock_timeout = '10s'";

const MIGRATIONS = join(import.meta.dirname, "..", "..", "migrations");

class SqlError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

type Script = (sql: string, nth: number) => unknown;
type Sleep = (milliseconds: number) => Promise<void>;

const fakeSleep = () => vi.fn<Sleep>(() => Promise.resolve());

/** A client that records every statement and fails the ones the script names; no database is involved. */
function scriptedClient(script: Script): { client: Client; statements: string[] } {
  const statements: string[] = [];
  const seen = new Map<string, number>();
  const client = {
    query(sql: string) {
      statements.push(sql);
      const nth = (seen.get(sql) ?? 0) + 1;
      seen.set(sql, nth);
      const failure = script(sql, nth);
      return failure === undefined
        ? Promise.resolve({ rows: [] })
        : Promise.reject(failure as Error);
    },
  };
  return { client: client as unknown as Client, statements };
}

describe("retryDelayMs", () => {
  it("doubles the base for each retry and spreads it between half and one and a half times", () => {
    expect([1, 2, 3].map((retry) => retryDelayMs(retry, () => 0.5))).toEqual([1000, 2000, 4000]);
    expect([1, 2, 3].map((retry) => retryDelayMs(retry, () => 0))).toEqual([500, 1000, 2000]);
    expect([1, 2, 3].map((retry) => retryDelayMs(retry, () => 0.999))).toEqual([1499, 2998, 5996]);
  });
});

describe("migrationExitCode", () => {
  it("is 75 for a lock clash that used every attempt, so the deploy loop may run it again", () => {
    const clash = new MigrationLockClashError("0001_a.sql", "40P01", 4, new Error("deadlock"));
    expect(migrationExitCode(clash)).toBe(EXIT_LOCK_CLASH);
    expect(EXIT_LOCK_CLASH).toBe(75);
  });

  it("is 1 for every other failure, including a plain error that carries a lock-clash code", () => {
    expect(migrationExitCode(new Error("syntax error"))).toBe(EXIT_FAILED);
    expect(migrationExitCode(new SqlError("deadlock detected", "40P01"))).toBe(EXIT_FAILED);
    expect(migrationExitCode("boom")).toBe(EXIT_FAILED);
  });
});

describe("migrate retry, without a database", () => {
  let dir: string;
  const sql = "CREATE TABLE a (id int);";
  const insert = "INSERT INTO schema_migration (version, checksum) VALUES ($1, $2)";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "migrate-unit-"));
    await writeFile(join(dir, "0001_a.sql"), sql);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("runs the file again in a new transaction when COMMIT itself loses a deadlock", async () => {
    const { client, statements } = scriptedClient((text, nth) =>
      text === "COMMIT" && nth === 1 ? new SqlError("deadlock detected", "40P01") : undefined,
    );
    const sleep = fakeSleep();
    const result = await migrate(client, dir, { sleep, random: () => 0.5, log: () => undefined });
    expect(result.applied).toEqual(["0001_a.sql"]);
    expect(statements.slice(3, -1)).toEqual([
      "BEGIN",
      LOCK_TIMEOUT,
      sql,
      insert,
      "COMMIT",
      "ROLLBACK",
      "BEGIN",
      LOCK_TIMEOUT,
      sql,
      insert,
      "COMMIT",
    ]);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(1000);
  });

  it("does not run the file again when the rollback fails, and says the state is unknown", async () => {
    const { client } = scriptedClient((text) => {
      if (text === sql) {
        return new SqlError("deadlock detected", "40P01");
      }
      return text === "ROLLBACK" ? new Error("connection terminated") : undefined;
    });
    const sleep = fakeSleep();
    const run = migrate(client, dir, { sleep, log: () => undefined });
    await expect(run).rejects.toThrow(
      /failed \(deadlock detected\) and the rollback also failed \(connection terminated\)/,
    );
    await expect(run).rejects.not.toBeInstanceOf(MigrationLockClashError);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives up after the retries and names the SQLSTATE in the error", async () => {
    const { client, statements } = scriptedClient((text) =>
      text === sql ? new SqlError("canceling statement due to lock timeout", "55P03") : undefined,
    );
    const sleep = fakeSleep();
    const lines: string[] = [];
    const run = migrate(client, dir, { sleep, random: () => 0.5, log: (line) => lines.push(line) });
    await expect(run).rejects.toMatchObject({
      name: "MigrationLockClashError",
      file: "0001_a.sql",
      sqlstate: "55P03",
      attempts: MAX_LOCK_CLASH_RETRIES + 1,
      message: expect.stringContaining("SQLSTATE 55P03, lock timeout"),
    });
    expect(sleep.mock.calls).toEqual([[1000], [2000], [4000]]);
    expect(lines).toHaveLength(3);
    expect(statements.filter((text) => text === "BEGIN")).toHaveLength(4);
    expect(statements.filter((text) => text === "ROLLBACK")).toHaveLength(4);
    expect(statements).not.toContain("COMMIT");
  });
});

const TRANSACTION_CONTROL = /^(BEGIN|COMMIT|END|ABORT|ROLLBACK|START\s+TRANSACTION)\b/i;

/** A character that continues an identifier, so a `$` or a quote after it opens nothing. */
const IDENTIFIER_CHAR = /[A-Za-z0-9_$\u0080-￿]/;
/** A dollar-quote opening at the start of the text: `$$` or `$tag$` (a tag never starts with a digit, so `$1` is not one). */
const DOLLAR_OPEN = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;

/** The end (exclusive) of a block comment opening at `start`; PostgreSQL nests them. */
function blockCommentEnd(sql: string, start: number): number {
  let depth = 0;
  let at = start;
  while (at < sql.length) {
    if (sql.startsWith("/*", at)) {
      depth += 1;
      at += 2;
    } else if (sql.startsWith("*/", at)) {
      depth -= 1;
      at += 2;
      if (depth === 0) {
        return at;
      }
    } else {
      at += 1;
    }
  }
  return sql.length;
}

/** The end (exclusive) of a quoted string or identifier opening at `start` with `quote`; doubled quotes stay inside. */
function quotedEnd(sql: string, start: number, quote: string, backslashEscapes: boolean): number {
  let at = start + 1;
  while (at < sql.length) {
    const char = sql[at];
    if (backslashEscapes && char === "\\") {
      at += 2;
    } else if (char === quote && sql[at + 1] === quote) {
      at += 2;
    } else if (char === quote) {
      return at + 1;
    } else {
      at += 1;
    }
  }
  return sql.length;
}

/** The end (exclusive) of whatever opens at `at` and is not top-level text (a comment, a quote, a dollar body), or -1. */
function skippedEnd(sql: string, at: number): number {
  const before = at > 0 ? (sql[at - 1] ?? "") : "";
  if (sql.startsWith("--", at)) {
    const newline = sql.indexOf("\n", at);
    return newline === -1 ? sql.length : newline;
  }
  if (sql.startsWith("/*", at)) {
    return blockCommentEnd(sql, at);
  }
  const char = sql[at];
  if (char === "'") {
    // E'...' reads backslash escapes; U&'...' and plain strings only double their quotes.
    const escaped = /[Ee]/.test(before) && !IDENTIFIER_CHAR.test(sql[at - 2] ?? " ");
    return quotedEnd(sql, at, "'", escaped);
  }
  if (char === '"') {
    return quotedEnd(sql, at, '"', false);
  }
  if (char === "$" && !IDENTIFIER_CHAR.test(before)) {
    const open = DOLLAR_OPEN.exec(sql.slice(at, at + 64));
    if (open !== null) {
      const close = sql.indexOf(open[0], at + open[0].length);
      return close === -1 ? sql.length : close + open[0].length;
    }
  }
  return -1;
}

/**
 * The statements of a file at its top level, split at `;`: comments, quoted strings, quoted identifiers and dollar-quoted
 * bodies removed in one left-to-right scan, so whichever opens first wins: a `$$` inside a comment or a string opens no
 * body, and a `--` or a quote inside a dollar body starts nothing.
 */
function topLevelStatements(sql: string): string[] {
  let text = "";
  let at = 0;
  while (at < sql.length) {
    const end = skippedEnd(sql, at);
    if (end === -1) {
      text += sql[at];
      at += 1;
    } else {
      text += " ";
      at = end;
    }
  }
  return text
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement !== "");
}

const endsTransaction = (sql: string): boolean =>
  topLevelStatements(sql).some((statement) => TRANSACTION_CONTROL.test(statement));

describe("the check that a migration leaves the transaction alone", () => {
  it.each([
    "BEGIN;",
    "COMMIT;",
    "commit",
    "END;",
    "ABORT;",
    "ROLLBACK;",
    "COMMIT AND CHAIN;",
    "START TRANSACTION;",
    "SELECT 1; COMMIT;",
    "CREATE TABLE a (id int);\nEND\n",
    // A `$$` inside a comment or a string opens no body that could hide the statement after it.
    "-- a$$hole\nCOMMIT;\nSELECT $$x$$;",
    "/* $$ */ COMMIT; SELECT $$x$$;",
    "SELECT 'a$$b';\nCOMMIT;\nSELECT $$x$$;",
    "SELECT U&'\\0041$$';\nROLLBACK;\nSELECT $$x$$;",
    "SELECT E'it\\'s $$';\nEND;\nSELECT $$x$$;",
    'SELECT 1 AS "a$$b";\nCOMMIT;\nSELECT $$x$$;',
    "DO $$ BEGIN PERFORM 1; END $$; COMMIT;",
    "DO $body$ BEGIN PERFORM '$$'; END $body$;\nCOMMIT;",
    "/* a /* b */ c */ COMMIT;",
  ])("catches %j", (sql) => {
    expect(endsTransaction(sql)).toBe(true);
  });

  it.each([
    "CREATE TABLE a (id int);",
    "DO $$ BEGIN PERFORM 1; END; $$;",
    "CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $body$ BEGIN COMMIT; END $body$;",
    "-- COMMIT;\nSELECT 1;",
    "/* ROLLBACK; */ SELECT 1;",
    "INSERT INTO t VALUES ('COMMIT; END;');",
    "SELECT 'it''s; END';",
    // A `$$` inside a comment or a string, a `--` or a quote inside a dollar body.
    "-- a$$hole\nCREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$;",
    "-- a$$hole\nCREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$\nBEGIN\n  RETURN;\nEND $$;",
    "/* a$$hole */ DO $$ BEGIN PERFORM 1; END $$;",
    "SELECT 'a$$b';\nDO $$ BEGIN PERFORM 1; END $$;",
    "DO $$ BEGIN -- it's done; COMMIT;\nPERFORM 1; END $$;",
    "DO $$ BEGIN PERFORM 'it''s'; /* $x$ */ END $$;",
    "DO $$ DECLARE m text := U&'\\E000\\E001'; BEGIN PERFORM m; END $$;",
    "SELECT U&'d\\0061t\\+000061 $$';\nDO $$ BEGIN PERFORM 1; END $$;",
    "SELECT U&'it''s; COMMIT';",
    "SELECT E'it\\'s; COMMIT';",
    'SELECT 1 AS "x; COMMIT";',
    "/* a /* b */ COMMIT; */ SELECT 1;",
    "SELECT $1::text; SELECT a$b FROM t;",
  ])("lets %j pass", (sql) => {
    expect(endsTransaction(sql)).toBe(false);
  });
});

describe("the migration files", () => {
  it("never end the runner's transaction themselves, because a retry relies on one file being one transaction", async () => {
    const names = (await readdir(MIGRATIONS)).filter((name) => name.endsWith(".sql"));
    expect(names.length).toBeGreaterThan(100);
    const offenders: string[] = [];
    for (const name of names) {
      if (endsTransaction(await readFile(join(MIGRATIONS, name), "utf8"))) {
        offenders.push(name);
      }
    }
    expect(offenders).toEqual([]);
  });
});
