import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "#src/db/context";
import { dailyFixture, type DailyFixture } from "#test/support/daily";
import { TEST_DATABASE_URL } from "#test/support/test-db";

/** The doors the API role holds that read or write the daily tables: the three player doors and the console's. */
const PLAYER_DOORS = ["daily_answer_submit", "daily_guess_submit", "own_daily"];
const CONSOLE_DOORS = [
  "daily_cadence_set",
  "daily_challenge_clear",
  "daily_challenge_set",
  "daily_console",
  "daily_question_list",
  "daily_question_retire",
  "daily_question_save",
  "daily_word_clear",
  "daily_word_set",
  "word_list_change",
  "word_list_page",
];

type Failure = { code?: string; detail?: string; hint?: string; message?: string };
const failureOf = (work: Promise<unknown>) =>
  work.then(
    () => null,
    (error: Failure) => error,
  );

/**
 * The daily games between players and seats (T-406, plan "Security", MINOR-5). Questify-level data has no tenant, so
 * the boundary is the player: B's reads show nothing of A's play and no door takes a player id. No granted door
 * answers a right option before the caller answered it, or a word before the caller finished it, in a result, a
 * refusal's message, detail or hint, an audit row or a replay; the period and content checks refuse future, past and
 * stale ids before anything secret is worked out. Staff and organizer seats never reach the player doors, and only an
 * active platform admin reaches the console's.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)(
  "the daily games between players (security)",
  () => {
    let f: DailyFixture;
    const WORD = "quilt";
    let today = "";
    let picked: string[] = [];
    let challenge = 0;
    let word = 0;
    let past = { challenge: 0, question: "", word: 0 };
    let future = { challenge: 0, question: "", word: 0 };
    let a = "";
    let b = "";

    beforeAll(async () => {
      f = await dailyFixture();
      await f.listWords("en", ["adieu", "stomp", "light"]);
      // A past period's content, played by nobody.
      const before = await f.freshSunday();
      const old = await f.setChallenge(before, await f.questions(3, 3));
      const oldWord = await f.setWord("en", before, "plumb");
      // Today's content, with a right option (3) no player has answered yet.
      today = await f.freshSunday();
      picked = await f.questions(3, 3);
      challenge = (await f.setChallenge(today, picked)).id;
      word = (await f.setWord("en", today, WORD)).id;
      const next = await f.plus(today, 7);
      const later = await f.setChallenge(next, await f.questions(3, 3));
      const laterWord = await f.setWord("en", next, "vexed");
      await f.goTo(today);
      past = { challenge: old.id, question: old.questions[0] ?? "", word: oldWord.id };
      future = { challenge: later.id, question: later.questions[0] ?? "", word: laterWord.id };
      a = await f.newPlayer();
      b = await f.newPlayer();
      await f.answer(a, challenge, picked[0] ?? "", 1, 3);
      await f.guess(a, word, 1, "adieu");
    });
    afterAll(async () => {
      await f.close();
    });

    /** Nothing in this value names the word, or a right option the caller has not answered. */
    const secretFree = (value: unknown) => {
      const text = JSON.stringify(value) ?? "";
      expect(text).not.toContain(WORD);
      expect(text).not.toMatch(/"right"|"answer"/);
    };

    it("lists the granted doors that touch the daily tables, so a new one cannot skip this suite", async () => {
      const { rows } = await f.db.owner.query<{ name: string }>(
        `SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND has_function_privilege('questify_app', p.oid, 'EXECUTE')
         AND p.prosrc ~ '(daily_(question|challenge|word|play|answer|guess|finish|cadence)|word_guess_list)'
       ORDER BY 1`,
      );
      expect(rows.map((row) => row.name)).toEqual([...PLAYER_DOORS, ...CONSOLE_DOORS].toSorted());
    });

    it("shows B nothing of A's play and never the right option or the word B has not reached", async () => {
      const seen = (await f.own(b)) as {
        challenge: { questions: { answered: unknown }[]; finished: unknown };
        word: { play: unknown };
      };
      expect(seen.challenge.questions.map((q) => q.answered)).toEqual([null, null, null]);
      expect(seen.challenge.finished).toBeNull();
      expect(seen.word.play).toBeNull();
      secretFree(seen);
      // A's own read shows A's answer and guess, still never the word.
      const mine = (await f.own(a)) as {
        challenge: { questions: { answered: unknown }[] };
        word: unknown;
      };
      expect(mine.challenge.questions[0]?.answered).toEqual({ choice: 3, correct: true, right: 3 });
      expect(JSON.stringify(mine.word)).not.toContain(WORD);
      // A non-finishing reply names no word; B's first answer names only its own question's right option.
      secretFree(await f.guess(b, word, 1, "stomp"));
      const reply = await f.answer(b, challenge, picked[0] ?? "", 1, 1);
      expect(reply).toMatchObject({ answer: { position: 1, right: 3 }, finished: null });
      // B's plays are B's own: A's rows are untouched, and no door takes a player id.
      const plays = await f.owner<{ player_id: string }>(
        "SELECT DISTINCT player_id FROM daily_play WHERE player_id IN ($1, $2) ORDER BY 1",
        [a, b],
      );
      expect(plays).toHaveLength(2);
      const { rows } = await f.db.owner.query<{ args: string }>(
        `SELECT pg_get_function_arguments(p.oid) AS args FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = ANY ($1)`,
        [PLAYER_DOORS],
      );
      expect(rows.map((row) => row.args).join(" ")).not.toMatch(/player|who/);
    });

    it("refuses future, past and stale ids before anything secret is worked out, naming nothing secret", async () => {
      const third = await f.newPlayer();
      const cases: [() => Promise<unknown>, string][] = [
        // A choice no question has, on another period's challenge: the period answers first.
        [() => f.answer(third, future.challenge, future.question, 1, 4), "period_over"],
        [() => f.answer(third, past.challenge, past.question, 1, 4), "period_over"],
        [() => f.answer(third, challenge, picked[1] ?? "", 1, 4), "changed"],
        [() => f.answer(third, challenge + 1000000, picked[0] ?? "", 1, 4), "changed"],
        // A guess that is no word, on another period's word: the period answers first, no marks are made.
        [() => f.guess(third, future.word, 1, "zzzzz"), "period_over"],
        [() => f.guess(third, past.word, 1, "zzzzz"), "period_over"],
        [() => f.guess(third, word + 1000000, 1, "zzzzz"), "changed"],
      ];
      for (const [work, reason] of cases) {
        const failure = await failureOf(work());
        expect(failure?.detail).toBe(reason);
        expect(`${failure?.message ?? ""}|${failure?.hint ?? ""}`).not.toMatch(
          /quilt|plumb|vexed|right|answer is/,
        );
      }
      expect(await f.owner("SELECT 1 FROM daily_play WHERE player_id = $1", [third])).toEqual([]);
      // A taken position or attempt names no stored value.
      for (const [work, reason] of [
        [() => f.answer(a, challenge, picked[0] ?? "", 1, 1), "answered"],
        [() => f.guess(a, word, 1, "light"), "attempt_taken"],
      ] as const) {
        const failure = await failureOf(work());
        expect(failure?.detail).toBe(reason);
        expect(`${failure?.message ?? ""}|${failure?.hint ?? ""}`).not.toMatch(/adieu|[0-9]/);
      }
      // A replay answers only what the caller already saw.
      secretFree(await f.guess(a, word, 1, "adieu"));
      // No audit row names a word or a right option.
      const audits = await f.owner<{ after: unknown }>(
        "SELECT after FROM audit_log WHERE action LIKE 'daily.%'",
      );
      expect(audits.length).toBeGreaterThan(0);
      expect(JSON.stringify(audits)).not.toMatch(/quilt|plumb|vexed|"answer":/);
    });

    it("keeps staff and organizer seats out of the player doors, and everyone but an admin out of the console's", async () => {
      const seats: RequestContext[] = [
        { staffUserId: f.ownerA, organizerId: f.ids.orgA },
        { staffUserId: f.ownerA },
        { isAdmin: true, staffUserId: f.ownerA },
      ];
      for (const context of seats) {
        expect((await f.run<{ r: unknown }>(context, "SELECT own_daily() AS r"))[0]?.r).toBeNull();
        for (const sql of [
          `SELECT daily_answer_submit(${challenge}, '${picked[0]}', 1::smallint, 1::smallint)`,
          `SELECT daily_guess_submit(${word}, 2::smallint, 'adieu')`,
        ]) {
          expect((await failureOf(f.run(context, sql)))?.code).toBe("PI401");
        }
      }
      const consoleCalls = [
        "SELECT daily_console(current_date, current_date)",
        "SELECT daily_question_list(NULL, NULL, 10)",
        "SELECT daily_question_save(NULL, '{}'::jsonb, gen_random_uuid())",
        `SELECT daily_question_retire('${picked[0]}', gen_random_uuid())`,
        `SELECT daily_challenge_set(current_date + 30, '{}', NULL, gen_random_uuid())`,
        "SELECT daily_challenge_clear(current_date + 30, gen_random_uuid())",
        "SELECT daily_word_set('en', current_date + 30, 'crane', gen_random_uuid())",
        "SELECT daily_word_clear('en', current_date + 30, gen_random_uuid())",
        "SELECT word_list_change('en', '{crane}', '{}', gen_random_uuid())",
        "SELECT word_list_page('en', '', 1)",
        "SELECT daily_cadence_set('word', 'daily', gen_random_uuid())",
      ];
      expect(consoleCalls).toHaveLength(CONSOLE_DOORS.length);
      for (const context of [...seats, { playerId: a }, { playerId: randomUUID() }]) {
        for (const sql of consoleCalls) {
          expect(
            (await failureOf(f.run(context, sql)))?.code,
            `${JSON.stringify(context)} ${sql}`,
          ).toBe("QY403");
        }
      }
    });
  },
);
