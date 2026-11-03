import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { it } from "vitest";
import { questifyFixture, type QuestifyFixture } from "#test/support/questify";
import { TEST_DATABASE_URL } from "#test/support/test-db";

/**
 * Times the seat limit at scale (T-221, ADR-630 to ADR-632): one accept-all call on a live Private event with 20,000
 * seated players and 5,000 requests, welcome points, one active souvenir rule and the decision push (the realistic
 * worst); the per-row cost of each AFTER trigger on an acceptance (the same call with that trigger switched off); the
 * hot path every `UPDATE enrollment` statement pays (10,000 single-row score updates, 1,000 quest scans); and the
 * largest bulk ledger writer (a bulk award of 2,000, one nested enrollment update per ledger row). Not an assertion (a
 * timing check is flaky on a 2-core runner): run it by hand when the seat triggers, accept-all or the other
 * `enrollment` triggers change,
 * `SEAT_TIMING=/path/to/out.txt [SEAT_PROFILE=1] pnpm vitest run apps/api/test/perf/seat-limit-timing.int.test.ts`.
 * Gate: one call (1,000 since ADR-631; 5,000 measured 14 to 29 s here) under 5 s, the API's statement limit, 3.5 s
 * targeted on the laptop; the hot path within its budget (50 µs a statement).
 */
const OUT = process.env["SEAT_TIMING"];
const PROFILE = process.env["SEAT_PROFILE"] === "1";
const say = (line: string) => appendFileSync(String(OUT), `${line}\n`);
const SEATED = 20_000;
const WAITING = 5_000;
const median = (values: number[]) =>
  values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;

type Spec = Readonly<{ limit: number | null; seated?: number; waiting?: number }>;

/** A live Private event with `seated` active players and `waiting` requests, then its limit, welcome and souvenir. */
async function fixture(f: QuestifyFixture, spec: Spec): Promise<string> {
  const event = await f.newEvent({ phase: "live", access: "private" });
  const tag = randomUUID().slice(0, 8);
  await f.owner(
    `WITH p AS (INSERT INTO player (username) SELECT 'st_' || $2 || '_' || g FROM generate_series(1, $3::integer + $4::integer) g
                RETURNING id),
          n AS (SELECT id, row_number() OVER () AS k FROM p)
     INSERT INTO enrollment (organizer_id, event_id, player_id, status)
     SELECT e.organizer_id, e.id, n.id, CASE WHEN n.k <= $3::integer THEN 'active' ELSE 'pending' END
     FROM n CROSS JOIN event e WHERE e.id = $1`,
    [event, tag, spec.seated ?? SEATED, spec.waiting ?? WAITING],
  );
  await f.owner(
    `UPDATE event SET welcome_points = 10, player_limit_mode = $2, player_limit = $3 WHERE id = $1`,
    [event, spec.limit === null ? "none" : "hard", spec.limit],
  );
  const [rule] = await f.run<{ id: string }>(
    f.team(),
    "SELECT souvenir_save($1, NULL, $2, $3) AS id",
    [
      event,
      {
        kind: "frame",
        name: { ar: "تذكار", en: "Souvenir" },
        visualKey: "frame-01",
        audience: "joined",
        categoryId: null,
        rankFrom: null,
        rankTo: null,
      },
      randomUUID(),
    ],
  );
  await f.run(f.team(), "SELECT souvenir_action($1, $2, 'activate', $3)", [
    event,
    rule?.id,
    randomUUID(),
  ]);
  await f.owner("ANALYZE");
  return event;
}

/** One accept-all call: its time and what it answered. */
async function acceptAll(f: QuestifyFixture, event: string) {
  const started = performance.now();
  const [row] = await f.run<{ accepted: number; remaining: number }>(
    f.team(),
    "SELECT * FROM accept_all_join_requests($1, $2)",
    [event, randomUUID()],
  );
  return {
    ms: Math.round(performance.now() - started),
    accepted: row?.accepted ?? 0,
    remaining: row?.remaining,
  };
}

/** The same call with one AFTER trigger switched off; per accepted row. */
async function withoutTrigger(f: QuestifyFixture, trigger: string | null) {
  const event = await fixture(f, { limit: null });
  if (trigger !== null) await f.owner(`ALTER TABLE enrollment DISABLE TRIGGER ${trigger}`);
  try {
    const call = await acceptAll(f, event);
    return { trigger: trigger ?? "all on", perRow: call.ms / Math.max(call.accepted, 1), ...call };
  } finally {
    if (trigger !== null) await f.owner(`ALTER TABLE enrollment ENABLE TRIGGER ${trigger}`);
  }
}

/** `n` single-row score updates on the slice of seated rows from `from`, in one server-side loop: µs a statement. */
async function scoreUpdates(f: QuestifyFixture, event: string, from: number, n: number) {
  await f.db.owner
    .query(`CREATE OR REPLACE FUNCTION pg_temp.score_loop(target uuid, skip integer, n integer)
    RETURNS double precision LANGUAGE plpgsql AS $$
    DECLARE ids uuid[]; started timestamptz;
    BEGIN
      ids := ARRAY(SELECT id FROM enrollment WHERE event_id = target AND status = 'active' ORDER BY id
                   OFFSET skip LIMIT n);
      started := clock_timestamp();
      FOR i IN 1 .. cardinality(ids) LOOP
        UPDATE enrollment SET score = score + 1 WHERE id = ids[i];
      END LOOP;
      RETURN extract(epoch FROM clock_timestamp() - started) * 1e6 / cardinality(ids);
    END $$`);
  const { rows } = await f.db.owner.query<{ us: number }>(
    "SELECT pg_temp.score_loop($1, $2, $3) AS us",
    [event, from, n],
  );
  return rows[0]?.us ?? 0;
}

/** `n` quest scans by the seated players of the slice from `from`: ms a scan, measured from the client. */
async function scans(f: QuestifyFixture, event: string, quest: string, from: number, n: number) {
  const players = await f.owner<{ player_id: string }>(
    `SELECT player_id FROM enrollment WHERE event_id = $1 AND status = 'active' ORDER BY id DESC
     OFFSET $2 LIMIT $3`,
    [event, from, n],
  );
  const started = performance.now();
  for (const { player_id } of players) {
    await f.asPlayer(player_id, "SELECT * FROM complete_quest($1, 'code', NULL, 'ABC', $2, NULL)", [
      quest,
      randomUUID(),
    ]);
  }
  return (performance.now() - started) / players.length;
}

/** One bulk ledger insert of 2,000 award rows (the bulk award's largest list) on the slice from `from`: ms. */
async function bulkLedger(f: QuestifyFixture, event: string, from: number) {
  const started = performance.now();
  await f.owner(
    `INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor,
                               staff_user_id)
     SELECT organizer_id, event_id, id, 'award', 5, 5, 'staff', $2 FROM enrollment
     WHERE event_id = $1 AND status = 'active' ORDER BY id OFFSET $3 LIMIT 2000`,
    [event, f.ownerA, from],
  );
  return performance.now() - started;
}

const round = (value: number) => Math.round(value * 100) / 100;

type Probe = (run: number) => Promise<number>;

/**
 * The hot path with the seat update trigger on and off, alternating on fresh slices of the same fixture (four runs
 * each), so the difference is the trigger's own cost. On 0145 (no such trigger) it runs every probe with the row guard.
 */
async function onAndOff(f: QuestifyFixture, probe: Probe) {
  const [present] = await f.owner<{ n: number }>(
    "SELECT count(*)::integer AS n FROM pg_trigger WHERE tgname = 'enrollment_seat_limit_update'",
  );
  const toggle = async (on: boolean) => {
    if (present?.n === 1) {
      await f.owner(
        `ALTER TABLE enrollment ${on ? "ENABLE" : "DISABLE"} TRIGGER enrollment_seat_limit_update`,
      );
    }
  };
  const on: number[] = [];
  const off: number[] = [];
  try {
    for (let run = 0; run < 8; run += 1) {
      await toggle(run % 2 === 0);
      (run % 2 === 0 ? on : off).push(await probe(run));
    }
  } finally {
    await toggle(true);
  }
  return { on: round(median(on)), off: round(median(off)), extra: round(median(on) - median(off)) };
}

async function hotPath(f: QuestifyFixture) {
  const hot = await fixture(f, { limit: 25_000, waiting: 0 });
  const updates = await onAndOff(f, (run) => scoreUpdates(f, hot, run * 2_000, 2_000));
  say(
    `  hot path: single-row score update ${updates.on} µs with the update trigger, ${updates.off} µs without ` +
      `(+${updates.extra} µs; 2,000 a run, server side)`,
  );
  const [quest] = await f.owner<{ id: string }>(
    `INSERT INTO quest (event_id, category_id, type, title_en, points, type_config)
     SELECT $1, id, 'enter_code', 'Timing quest', 10, '{"code":"ABC"}' FROM category WHERE event_id = $1 LIMIT 1
     RETURNING id`,
    [hot],
  );
  const scan = await onAndOff(f, (run) => scans(f, hot, quest?.id ?? "", run * 250, 250));
  say(
    `  hot path: quest scan ${scan.on} ms with the update trigger, ${scan.off} ms without (+${scan.extra} ms; ` +
      `250 complete_quest calls a run, client side)`,
  );
  const bulk = await onAndOff(f, (run) => bulkLedger(f, hot, run * 2_000));
  say(
    `  bulk ledger: one insert of 2,000 award rows ${bulk.on} ms with the update trigger, ${bulk.off} ms without ` +
      `(+${bulk.extra} ms)`,
  );
}

it.skipIf(OUT === undefined || TEST_DATABASE_URL === undefined)(
  "times accept-all at 20,000 seated, the per-row trigger profile, the hot path and a bulk ledger write",
  async () => {
    const f = await questifyFixture();
    try {
      const [version] = await f.owner<{ v: string }>(
        "SELECT current_setting('server_version') AS v",
      );
      const calls = [];
      for (let run = 0; run < 3; run += 1)
        calls.push(await acceptAll(f, await fixture(f, { limit: 25_000 })));
      const notices = await f.owner<{ n: number }>(
        "SELECT count(*)::integer AS n FROM notice WHERE kind = 'join_accepted'",
      );
      say(
        `T-221 PostgreSQL ${version?.v}: accept-all on a hard limit of 25,000 with ${SEATED} seated and ${WAITING} ` +
          `waiting, 3 fresh fixtures: ${calls.map((c) => `${c.ms} ms (accepted ${c.accepted}, remaining ${c.remaining})`).join("; ")}` +
          `; median ${median(calls.map((c) => c.ms))} ms; ${notices[0]?.n} join_accepted notices in all`,
      );
      const profiled = PROFILE
        ? [null, "enqueue_souvenir_on_join", "enrollment_welcome", "enrollment_push_decision"]
        : [];
      for (const trigger of profiled) {
        const runs = [];
        for (let run = 0; run < 3; run += 1) runs.push(await withoutTrigger(f, trigger));
        say(
          `  no limit, ${trigger ?? "every trigger on"}${trigger === null ? "" : " off"}: median ` +
            `${median(runs.map((r) => r.ms))} ms for ${runs[0]?.accepted} rows, ` +
            `${median(runs.map((r) => r.perRow)).toFixed(3)} ms a row`,
        );
      }
      await hotPath(f);
    } finally {
      await f.close();
    }
  },
  1_800_000,
);
