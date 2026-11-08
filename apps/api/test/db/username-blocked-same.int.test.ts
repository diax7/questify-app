import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OLD_USERNAME_BLOCKED, comparedNames } from "#test/db/username-blocked-names";
import { TEST_DATABASE_URL, createTestDatabase, type TestDatabase } from "#test/support/test-db";

/**
 * `username_blocked` restated by 0179 (FOLLOWUPS batch 24): PL/pgSQL with the name folded once, where 0118's SQL body
 * folded it and ran three regexes once per list row. The answers must not change, so this compares the two on every list
 * word's look-alikes (digits, cases, separators, letters around it, unfolded Arabic letters), every corpus and test name
 * as a username, and seeded random names: more than 10,000 in all, with test words and retired names added.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("username_blocked restated (database)", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
    await db.owner.query(OLD_USERNAME_BLOCKED);
    await db.owner.query(
      "INSERT INTO username_word (word, match, language) VALUES ('qxbad', 'word', 'en'), ('خبيث', 'part', 'ar'), ('qxz', 'part', 'en')",
    );
    await db.owner.query("INSERT INTO username_retired (fold) VALUES ('ساره'), ('nora')");
  });
  afterAll(async () => {
    await db.close();
  });

  it("gives 0118's answer for more than 10,000 names, refused and passed", async () => {
    const words = (
      await db.owner.query<{ word: string }>("SELECT word FROM username_word ORDER BY word")
    ).rows.map((row) => row.word);
    const names = comparedNames(words, 4000);
    expect(names.length).toBeGreaterThan(10_000);
    const { rows } = await db.owner.query<{ name: string; was: boolean; now: boolean }>(
      `SELECT n AS name, old_username_blocked(n) AS was, username_blocked(n) AS now
       FROM unnest($1::text[]) n`,
      [names],
    );
    expect(rows.filter((row) => row.was !== row.now)).toEqual([]);
    const refused = rows.filter((row) => row.now).length;
    expect(refused).toBeGreaterThan(3000);
    expect(rows.length - refused).toBeGreaterThan(3000);
  });

  it("answers no name with false, as 0118 did", async () => {
    const { rows } = await db.owner.query(
      "SELECT old_username_blocked(NULL) AS was, username_blocked(NULL) AS now",
    );
    expect(rows).toEqual([{ was: false, now: false }]);
  });

  it("is PL/pgSQL with no SET clause, closed to everyone, so the name is folded once a call", async () => {
    const { rows } = await db.owner.query(
      `SELECT l.lanname AS language, p.proconfig AS config, p.provolatile AS volatility, p.prosecdef AS definer,
              p.proacl IS NOT NULL AND array_length(p.proacl, 1) = 1 AS owner_only
       FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
       WHERE p.oid = 'username_blocked(text)'::regprocedure`,
    );
    expect(rows).toEqual([
      { language: "plpgsql", config: null, volatility: "s", definer: false, owner_only: true },
    ]);
  });
});
