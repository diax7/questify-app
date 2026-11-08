import { cp, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withRequestContext } from "#src/db/context";
import {
  TEST_DATABASE_URL,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

const MIGRATIONS = join(import.meta.dirname, "../../migrations");
const PREFIX = "questify-pre-0178-";

/** Stored names and the flag each must carry under 0177, then after 0178's recheck mark and the sweep. */
const STORED: readonly (readonly [string, boolean, boolean])[] = [
  ["Siriporn Chaiyaporn", true, false],
  ["Ade Shittu", true, false],
  ["رضا کسمایی", true, false],
  ["Sara Ahmed", false, false],
  ["Mr Shithead", true, true],
  ["fucks", true, true],
  ["Ali Fuckali", true, true],
  ["motherfuckers", true, true],
  ["sluts", true, true],
  ["ياشرموطة", true, true],
  ["الشرموطات", true, true],
  ["القحبة", false, true],
];

const expected = (column: 1 | 2) =>
  STORED.map((row) => [row[0], row[column]] as const).toSorted(([a], [b]) => a.localeCompare(b));

/**
 * The move from 0177 to 0178 on stored names (ADR-817, Q-754): a database at 0177 with its answers swept, then 0178
 * applied, which changes the rule with no list row touched and so marks the recheck itself; the tick's sweep then shows
 * the real names 0177 hid and keeps the abusive ones hidden.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("full names from 0177 to 0178 (database)", () => {
  let db: TestDatabase;
  let directory = "";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), PREFIX));
    for (const file of await readdir(MIGRATIONS)) {
      if (file < "0178") {
        await cp(join(MIGRATIONS, file), join(directory, file));
      }
    }
    db = await createTestDatabase(directory);
  });
  afterAll(async () => {
    await db.close();
    if (
      dirname(resolve(directory)) !== resolve(tmpdir()) ||
      !basename(directory).startsWith(PREFIX)
    ) {
      throw new Error("unsafe fixture directory");
    }
    await rm(directory, { recursive: true, force: true });
  });

  const owner = async <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
    (await db.owner.query<T>(sql, values)).rows;
  const sweepAll = async () => {
    for (;;) {
      const rows = await withRequestContext(
        db.app,
        {},
        async () => (await db.app.query<{ n: number }>("SELECT name_flag_sweep(2000) AS n")).rows,
      );
      if ((rows[0]?.n ?? 0) < 2000) {
        return;
      }
    }
  };
  const flags = async () =>
    (
      await owner<{ value: string; name_blocked: boolean }>(
        "SELECT value, name_blocked FROM join_answer WHERE value = ANY ($1)",
        [STORED.map(([name]) => name)],
      )
    )
      .map((row) => [row.value, row.name_blocked] as const)
      .toSorted(([a], [b]) => a.localeCompare(b));

  it("sweeps the stored names again after 0178: real names shown, abusive ones still hidden", async () => {
    const ids = await seedTwoTenants(db.owner);
    const [event] = await owner<{ id: string }>(
      `INSERT INTO event (organizer_id, join_code, name_en, status, access, starts_at, ends_at)
       VALUES ($1, 'MOVE178', 'Names Day', 'live', 'public', now() - interval '1 hour', now() + interval '1 day')
       RETURNING id`,
      [ids.orgA],
    );
    const [field] = await owner<{ id: string }>(
      "INSERT INTO event_join_field (organizer_id, event_id, kind, position) VALUES ($1, $2, 'full_name', 0) RETURNING id",
      [ids.orgA, event?.id],
    );
    for (const [index, [name]] of STORED.entries()) {
      const [player] = await owner<{ id: string }>(
        "INSERT INTO player (username) VALUES ($1) RETURNING id",
        [`moved_${index}`],
      );
      const [enrollment] = await owner<{ id: string }>(
        `INSERT INTO enrollment (organizer_id, event_id, player_id, status, name_notice, joined_via)
         VALUES ($1, $2, $3, 'active', 'everyone', 'code') RETURNING id`,
        [ids.orgA, event?.id, player?.id],
      );
      await owner(
        `INSERT INTO join_answer (enrollment_id, field_id, organizer_id, event_id, value) VALUES ($1, $2, $3, $4, $5)`,
        [enrollment?.id, field?.id, ids.orgA, event?.id, name],
      );
    }
    await sweepAll();
    expect(await flags()).toEqual(expected(1));
    expect(await owner("SELECT pending FROM full_name_recheck")).toEqual([{ pending: false }]);

    await db.owner.query("BEGIN");
    await db.owner.query(
      await readFile(join(MIGRATIONS, "0178_full_name_whole_words.sql"), "utf8"),
    );
    await db.owner.query("COMMIT");
    expect(await owner("SELECT pending, after_enrollment FROM full_name_recheck")).toEqual([
      { pending: true, after_enrollment: null },
    ]);
    // Until the sweep reaches it, a stored name shows as 0177 flagged it.
    expect(await flags()).toEqual(expected(1));
    await sweepAll();
    expect(await flags()).toEqual(expected(2));
    expect(await owner("SELECT pending FROM full_name_recheck")).toEqual([{ pending: false }]);
  });
});
