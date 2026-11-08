import { appendFileSync } from "node:fs";
import { it } from "vitest";
import { RECHECK_PAGE } from "#src/join/name-recheck";
import {
  TEST_DATABASE_URL,
  addMember,
  createTestDatabase,
  seedTwoTenants,
} from "#test/support/test-db";

/**
 * Times the three reads that name players for other players (ranking_names, screen_ranking, event_results) as 0176 had
 * them, as the first 0177 had them (the word-list check run on every read), and as 0177 has them now (a stored flag),
 * plus the sweep after a word add, the one that also checks the answers stored before 0177 (ADR-817). Not an assertion: a timing check is flaky on a shared
 * runner. Run by hand: `FULL_NAME_TIMING=/path/to/out.txt pnpm vitest run apps/api/test/perf/full-name-timing`.
 * Each figure is the median of 30 `EXPLAIN (ANALYZE, BUFFERS)` runs after 3 warm-ups, the three versions taken by turns.
 */
const OUT = process.env["FULL_NAME_TIMING"];
const say = (line: string) => appendFileSync(String(OUT), `${line}\n`);
const PLAYERS = 2000;
const OTHER_ANSWERS = 100_000;
/** The slowest name measured for the check (0178): 200 characters of short Arabic words, each with many prefixes. */
const SLOWEST = "وبالكم ".repeat(29).slice(0, 200);
/** Pages of the sweep timed with the slowest name in every answer. */
const SLOW_PAGES = 20;

/** 0176's reads: no check. */
const BASE = `
CREATE OR REPLACE FUNCTION public_full_name(target_enrollment uuid) RETURNS text
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT display_name_text(a.value)
  FROM enrollment n JOIN event e ON e.id = n.event_id
  JOIN event_join_field f ON f.event_id = e.id AND f.kind = 'full_name'
  JOIN join_answer a ON a.enrollment_id = n.id AND a.field_id = f.id
  WHERE n.id = target_enrollment AND n.status = 'active'
    AND e.name_audience = 'everyone' AND e.name_display <> 'username' AND n.name_notice = 'everyone'
$$;
CREATE OR REPLACE FUNCTION full_name_part(target_enrollment uuid) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT jsonb_build_object('fullName', public_full_name(target_enrollment))
                   WHERE public_full_name(target_enrollment) IS NOT NULL), '{}'::jsonb)
$$;`;

/** The first 0177 (e91a194e): the check, with its CTEs inlined into the list scan, on every read. */
const FIRST = `
CREATE OR REPLACE FUNCTION first_full_name_blocked(name text) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  WITH folded AS (
    SELECT regexp_replace(
             username_fold(regexp_replace(coalesce(display_name_text(name), ''),
               '[̀-ͯؐ-ؚـً-ٰٟۖ-ۜ۟-۪ۤۧۨ-ۭ]',
               '', 'g')),
             '[^a-zء-غف-ي0-9]+', '_', 'g') AS v),
  forms AS (
    SELECT regexp_split_to_array(v, '[_0-9]+') AS tokens,
           regexp_replace(v, '[_0-9]', '', 'g') AS bare,
           regexp_replace(translate(v, '013457', 'oieast'), '[_0-9]', '', 'g') AS mapped
    FROM folded)
  SELECT EXISTS (
    SELECT 1 FROM username_word w, forms
    WHERE (w.match = 'word' AND w.word = ANY (forms.tokens))
       OR (w.match = 'part' AND (position(w.word IN forms.bare) > 0 OR position(w.word IN forms.mapped) > 0)))
$$;
CREATE OR REPLACE FUNCTION public_full_name(target_enrollment uuid) RETURNS text
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT display_name_text(a.value)
  FROM enrollment n JOIN event e ON e.id = n.event_id
  JOIN event_join_field f ON f.event_id = e.id AND f.kind = 'full_name'
  JOIN join_answer a ON a.enrollment_id = n.id AND a.field_id = f.id
  WHERE n.id = target_enrollment AND n.status = 'active'
    AND e.name_audience = 'everyone' AND e.name_display <> 'username' AND n.name_notice = 'everyone'
    AND NOT first_full_name_blocked(a.value)
$$;`;

type Plan = { "Execution Time": number; Plan: Record<string, number> };

const median = (values: number[]): number => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

it.skipIf(OUT === undefined || TEST_DATABASE_URL === undefined)(
  "times the name reads before and after the stored flag",
  async () => {
    const db = await createTestDatabase();
    try {
      const ids = await seedTwoTenants(db.owner);
      const q = (sql: string, values: unknown[] = []) => db.owner.query(sql, values);
      const staff = await addMember(db.owner, ids.orgA);
      const event = ids.eventA;
      const field = (
        await q(
          "INSERT INTO event_join_field (organizer_id, event_id, kind, position) VALUES ($1, $2, 'full_name', 0) RETURNING id",
          [ids.orgA, event],
        )
      ).rows[0].id as string;
      await q("UPDATE event SET name_display = 'both', name_audience = 'everyone' WHERE id = $1", [
        event,
      ]);
      await q(
        `INSERT INTO player (username) SELECT 'fn_' || n FROM generate_series(1, ${PLAYERS}) n`,
      );
      await q(
        `INSERT INTO enrollment (organizer_id, event_id, player_id, name_notice)
         SELECT $1, $2, id, 'everyone' FROM player WHERE username LIKE 'fn\\_%'`,
        [ids.orgA, event],
      );
      await q("ALTER TABLE enrollment DISABLE TRIGGER USER");
      await q(
        "UPDATE enrollment SET score = 1 + (random() * 1000)::int, score_version = (random() * 1e9)::bigint WHERE event_id = $1",
        [event],
      );
      await q("ALTER TABLE enrollment ENABLE TRIGGER USER");
      await q(
        `INSERT INTO join_answer (enrollment_id, field_id, organizer_id, event_id, value)
         SELECT n.id, $1, $2, $3, 'Mohammed Abdullah Al-Qahtani ' || p.username
         FROM enrollment n JOIN player p ON p.id = n.player_id WHERE n.event_id = $3`,
        [field, ids.orgA, event],
      );
      // Other events' Full name answers, for the sweep: one event of 100,000 enrollments.
      const other = (
        await q(
          `INSERT INTO event (organizer_id, join_code, name_en, status, starts_at, ends_at)
           VALUES ($1, 'BULK1', 'Bulk', 'live', now() - interval '1 hour', now() + interval '1 day') RETURNING id`,
          [ids.orgB],
        )
      ).rows[0].id as string;
      const otherField = (
        await q(
          "INSERT INTO event_join_field (organizer_id, event_id, kind, position) VALUES ($1, $2, 'full_name', 0) RETURNING id",
          [ids.orgB, other],
        )
      ).rows[0].id as string;
      await q(
        `INSERT INTO player (username) SELECT 'bk_' || n FROM generate_series(1, ${OTHER_ANSWERS}) n`,
      );
      await q(
        `INSERT INTO enrollment (organizer_id, event_id, player_id)
         SELECT $1, $2, id FROM player WHERE username LIKE 'bk\\_%'`,
        [ids.orgB, other],
      );
      await q("ALTER TABLE join_answer DISABLE TRIGGER join_answer_name_flag");
      await q(
        `INSERT INTO join_answer (enrollment_id, field_id, organizer_id, event_id, value)
         SELECT n.id, $1, $2, $3, 'نورة عبدالعزيز السبيعي ' || p.username
         FROM enrollment n JOIN player p ON p.id = n.player_id WHERE n.event_id = $3`,
        [otherField, ids.orgB, other],
      );
      await q("ALTER TABLE join_answer ENABLE TRIGGER join_answer_name_flag");
      // The revealed results: 100 places.
      await q(
        "INSERT INTO event_result (event_id, organizer_id, revealed_at, claim_until) VALUES ($1, $2, now(), now() + interval '7 days')",
        [event, ids.orgA],
      );
      await q(
        `INSERT INTO result_place (event_id, rank, enrollment_id, score, score_version)
         SELECT $1, row_number() OVER (ORDER BY score DESC, id), id, score, score_version
         FROM enrollment WHERE event_id = $1 AND name_notice = 'everyone' ORDER BY score DESC, id LIMIT 100`,
        [event],
      );
      await q(
        "INSERT INTO event_entitlement (event_id, organizer_id, feature) VALUES ($1, $2, 'bigScreen')",
        [event, ids.orgA],
      );
      const device = (
        await q(
          `INSERT INTO paired_device (organizer_id, event_id, kind, label, secret_hash, paired_by_staff, activated_at)
           VALUES ($1, $2, 'screen', 'Hall', decode(repeat('ab', 32), 'hex'), $3, now()) RETURNING id`,
          [ids.orgA, event, staff],
        )
      ).rows[0].id as string;
      const reader = (
        await q(
          "SELECT n.id, n.player_id FROM enrollment n WHERE n.event_id = $1 AND n.name_notice = 'everyone' LIMIT 1",
          [event],
        )
      ).rows[0] as { id: string; player_id: string };
      const page = (
        await q(
          "SELECT array_agg(id) AS ids FROM (SELECT id FROM enrollment WHERE event_id = $1 ORDER BY score DESC LIMIT 10) t",
          [event],
        )
      ).rows[0].ids as string[];
      await q("ANALYZE");

      const reads = {
        ranking_names: [
          "SELECT * FROM ranking_names($1, $2::uuid[])",
          [event, [...page, reader.id]],
          reader.player_id,
          "",
        ],
        screen_ranking: ["SELECT screen_ranking()", [], "", device],
        event_results: ["SELECT * FROM event_results($1)", [event], reader.player_id, ""],
      } as const;
      const versions: Record<string, string> = {
        "0176": BASE,
        "first 0177": FIRST,
        "0177 now": "",
      };
      const nowBodies = (
        await q(
          `SELECT string_agg(pg_get_functiondef(p.oid), E';\n') AS sql FROM pg_proc p
           WHERE p.proname IN ('public_full_name', 'full_name_part') AND p.pronamespace = 'public'::regnamespace`,
        )
      ).rows[0].sql as string;
      versions["0177 now"] = `${nowBodies};`;
      await q(FIRST.split("CREATE OR REPLACE FUNCTION public_full_name")[0] ?? "");

      const timings: Record<string, { ms: number[]; buffers: number[] }> = {};
      const runOnce = async (version: string, name: keyof typeof reads, keep: boolean) => {
        const [sql, values, player, screen] = reads[name];
        await q(
          "SELECT set_config('app.player_id', $1, false), set_config('app.device_id', $2, false)",
          [player, screen],
        );
        const plan = (await q(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, [...values]))
          .rows[0]["QUERY PLAN"][0] as Plan;
        if (keep) {
          const key = `${name} | ${version}`;
          timings[key] ??= { ms: [], buffers: [] };
          timings[key].ms.push(plan["Execution Time"]);
          timings[key].buffers.push(
            (plan.Plan["Shared Hit Blocks"] ?? 0) + (plan.Plan["Shared Read Blocks"] ?? 0),
          );
        }
      };
      for (let round = 0; round < 33; round += 1) {
        for (const [version, body] of Object.entries(versions)) {
          await q(body);
          for (const name of Object.keys(reads) as (keyof typeof reads)[]) {
            await runOnce(version, name, round >= 3);
          }
        }
      }
      await q(
        "SELECT set_config('app.player_id', '', false), set_config('app.device_id', $1, false)",
        [device],
      );
      say(
        `screen: ${JSON.stringify((await q("SELECT screen_ranking() AS s")).rows[0].s).slice(0, 300)}`,
      );
      const load = (await q("SELECT count(*)::int AS n FROM join_answer")).rows[0].n as number;
      say(`players in the event ${PLAYERS}, join_answer rows ${load}, 100 result places, 11 ids`);
      for (const [key, value] of Object.entries(timings)) {
        say(`${key}: ${median(value.ms).toFixed(2)} ms, ${median(value.buffers)} buffers`);
      }

      // A word add (the list trigger marks the sweep) and the sweep's pages over every Full name answer, each its own
      // statement here, as the tick runs them.
      await q("INSERT INTO username_word (word, match, language) VALUES ('zorvex', 'part', 'en')");
      const pages: number[] = [];
      const sweepStart = performance.now();
      for (;;) {
        const start = performance.now();
        const seen = (await q("SELECT name_flag_sweep($1) AS n", [RECHECK_PAGE])).rows[0]
          .n as number;
        pages.push(performance.now() - start);
        if (seen < RECHECK_PAGE) {
          break;
        }
      }
      say(
        `sweep: ${pages.length} pages of up to ${RECHECK_PAGE}, median ${Math.round(median(pages))} ms a page, ` +
          `slowest ${Math.round(Math.max(...pages))} ms, ` +
          `${Math.round(performance.now() - sweepStart)} ms in all`,
      );
      // The worst case: the slowest name in every bulk answer, the sweep marked again, its first pages timed.
      await q("ALTER TABLE join_answer DISABLE TRIGGER join_answer_name_flag");
      await q("UPDATE join_answer SET value = $1 WHERE event_id = $2", [SLOWEST, other]);
      await q("ALTER TABLE join_answer ENABLE TRIGGER join_answer_name_flag");
      await q("DELETE FROM username_word WHERE word = 'zorvex'");
      const slow: number[] = [];
      for (let run = 0; run < SLOW_PAGES; run += 1) {
        const start = performance.now();
        await q("SELECT name_flag_sweep($1)", [RECHECK_PAGE]);
        slow.push(performance.now() - start);
      }
      say(
        `sweep, the slowest name in every answer: ${SLOW_PAGES} pages of ${RECHECK_PAGE}, ` +
          `median ${Math.round(median(slow))} ms a page, slowest ${Math.round(Math.max(...slow))} ms`,
      );
    } finally {
      await db.close();
    }
  },
  1_200_000,
);
