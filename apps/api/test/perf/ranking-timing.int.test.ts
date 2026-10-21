import { appendFileSync } from "node:fs";
import { it } from "vitest";
import { TEST_DATABASE_URL, createTestDatabase, seedTwoTenants } from "#test/support/test-db";

/**
 * Times the set form of the ranking rule (ranked_enrollments) at 20,000 players, with no exclusion list and with 100
 * entries (T-208). Not an assertion: a timing check is flaky on a 2-core runner. Run it by hand when the rule changes:
 * `RANKING_TIMING=/path/to/out.txt pnpm vitest run apps/api/test/perf`. Measured 2026-10-21 on the dev machine: about
 * 27 ms with no list, about 65 ms with 100 entries (T-106 measured about 50 ms before exclusions existed).
 */
const OUT = process.env["RANKING_TIMING"];
const say = (line: string) => appendFileSync(String(OUT), `${line}\n`);

it.skipIf(OUT === undefined || TEST_DATABASE_URL === undefined)(
  "times ranked_enrollments at 20,000 players",
  async () => {
    const db = await createTestDatabase();
    try {
      const ids = await seedTwoTenants(db.owner);
      const q = (sql: string, values: unknown[] = []) => db.owner.query(sql, values);
      await q("INSERT INTO player (username) SELECT 'tp_' || n FROM generate_series(1, 20000) n");
      await q(
        `INSERT INTO player_contact (player_id, phone_e164, email)
         SELECT id, '+9665' || lpad((row_number() OVER ())::text, 8, '0'),
                'u' || (row_number() OVER ()) || '@d' || ((row_number() OVER ()) % 300) || '.sa'
         FROM player WHERE username LIKE 'tp%'`,
      );
      await q(
        "INSERT INTO enrollment (organizer_id, event_id, player_id) SELECT $1, $2, id FROM player WHERE username LIKE 'tp%'",
        [ids.orgA, ids.eventA],
      );
      // Points without 20,000 completions: the ledger triggers are off for this one statement.
      await q("ALTER TABLE enrollment DISABLE TRIGGER USER");
      await q(
        `UPDATE enrollment SET score = 1 + (random() * 1000)::int, score_version = (random() * 1e9)::bigint
         WHERE event_id = $1`,
        [ids.eventA],
      );
      await q("ALTER TABLE enrollment ENABLE TRIGGER USER");
      const staff = (
        await q(
          "INSERT INTO staff_user (email, password_hash) VALUES ('t@t.test', 'x') RETURNING id",
        )
      ).rows[0].id;
      for (const entries of [0, 100]) {
        await q("DELETE FROM event_exclusion");
        if (entries > 0) {
          await q(
            `INSERT INTO event_exclusion (organizer_id, event_id, kind, value, created_by)
             SELECT $1::uuid, $2::uuid, 'phone', '+9665' || lpad(n::text, 8, '0'), $3::uuid FROM generate_series(1, 50) n
             UNION ALL
             SELECT $1::uuid, $2::uuid, 'email_domain', 'd' || n || '.sa', $3::uuid FROM generate_series(1, 50) n`,
            [ids.orgA, ids.eventA, staff],
          );
        }
        await q("ANALYZE");
        const times: number[] = [];
        let counts = "";
        for (let i = 0; i < 5; i += 1) {
          const start = performance.now();
          const result = await q(
            "SELECT count(*) FILTER (WHERE ranked) AS ranked, count(*) AS total FROM ranked_enrollments($1)",
            [ids.eventA],
          );
          times.push(performance.now() - start);
          counts = JSON.stringify(result.rows[0]);
        }
        say(`${entries} entries: ${counts} ms ${times.map((t) => Math.round(t)).join(",")}`);
      }
    } finally {
      await db.close();
    }
  },
  300_000,
);
