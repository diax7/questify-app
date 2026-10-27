import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dailyFixture, questionFields, refusal, type DailyFixture } from "#test/support/daily";
import { TEST_DATABASE_URL } from "#test/support/test-db";

type Kind = "challenge" | "word";
type Cover = { coveredDays: number; coveredPeriods: number; warn: boolean };
type Console = {
  status: {
    challenge: { cadence: string; next: { cadence: string; from: string } | null } & Cover;
    word: { cadence: string; next: unknown; ar: Cover; en: Cover };
  };
  periods: {
    kind: Kind;
    startsOn: string;
    endsOn: string;
    challenge?: { id: number; questions: string[]; sponsor: unknown; finishes: number } | null;
    words?: Record<string, { id: number; word: string; finishes: number }>;
  }[];
  unused: { kind: Kind; language: string | null; startsOn: string }[];
};

const RLO = String.fromCharCode(0x202e);
const BELL = String.fromCharCode(7);
const ISOLATE = String.fromCharCode(0x2066);

/**
 * Daily content, periods and the cadence in the database (T-406, migration 0069, FR-732, FR-1733, FR-1811, FR-1814,
 * ADR-307, ADR-308, ADR-311): Sunday weeks and Questify days, a cadence changed from the next day under a lock the
 * player doors share, content keyed by its period's first day and frozen once started for every role, the 04:00 races
 * crossed both ways, the warnings, unused content, the guess list and the console's reads.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("daily content and the cadence (database)", () => {
  let f: DailyFixture;
  beforeAll(async () => {
    f = await dailyFixture();
  });
  afterAll(async () => {
    await f.close();
  });

  const period = async (kind: Kind, day: string) =>
    (
      await f.owner<{ s: string | null; e: string | null }>(
        "SELECT starts_on::text AS s, ends_on::text AS e FROM daily_period($1, $2)",
        [kind, day],
      )
    )[0];
  const inForce = async (kind: Kind) =>
    (
      await f.owner<{ cadence: string }>(
        `SELECT cadence FROM daily_cadence WHERE kind = $1 AND from_day <= questify_day(now())
         ORDER BY from_day DESC LIMIT 1`,
        [kind],
      )
    )[0]?.cadence;
  /** Puts `cadence` in force for both kinds (a change applies from tomorrow, so the clock moves on a day). */
  const ensure = async (cadence: "daily" | "weekly") => {
    let moved = false;
    for (const kind of ["challenge", "word"] as const) {
      if ((await inForce(kind)) !== cadence) {
        await f.setCadence(kind, cadence);
        moved = true;
      }
    }
    if (moved) await f.goTo(await f.plus(await f.today(), 1));
  };
  const consoleRead = (from: string, to: string) =>
    f.door<Console>("SELECT daily_console($1, $2) AS r", [from, to]);
  const pendingRows = async (kind: Kind) =>
    Number(
      (
        await f.owner<{ n: string }>(
          "SELECT count(*) AS n FROM daily_cadence WHERE kind = $1 AND from_day > questify_day(now())",
          [kind],
        )
      )[0]?.n,
    );
  const doorSql = {
    answer: "SELECT daily_answer_submit($1, $2, $3, $4) AS r",
    guess: "SELECT daily_guess_submit($1, $2, $3) AS r",
    cadence: "SELECT daily_cadence_set($1, $2, $3) AS r",
    challenge: "SELECT daily_challenge_set($1, $2::uuid[], NULL, $3) AS r",
    word: "SELECT daily_word_set($1, $2, $3, $4) AS r",
    question: "SELECT daily_question_save($1, $2::jsonb, $3) AS r",
  };
  const asAdmin = (sql: string, values: unknown[]) => ({ context: f.seat, sql, values });
  /** A weekly challenge on a fresh Sunday, the clock on it, and a new player. */
  const sundayChallenge = async () => {
    await ensure("weekly");
    const sunday = await f.freshSunday();
    const picked = await f.questions();
    const challenge = await f.setChallenge(sunday, picked);
    await f.goTo(sunday);
    return { sunday, picked, challenge, player: await f.newPlayer() };
  };

  describe("periods and the cadence (ADR-307)", () => {
    it("runs weekly from Sunday 2026-01-04, Sunday to Saturday, on the 04:00 Riyadh day", async () => {
      await f.goTo(await f.plus(await f.today(), 0));
      const [boundary] = await f.owner<{ before: string; at: string }>(
        `UPDATE test_clock SET shift = '0 days' RETURNING
           questify_day('2026-10-27 00:59:59.999999+00')::text AS before, questify_day('2026-10-27 01:00:00+00')::text AS at`,
      );
      expect(boundary).toEqual({ before: "2026-10-26", at: "2026-10-27" });
      expect(await period("challenge", "2026-01-04")).toEqual({ s: "2026-01-04", e: "2026-01-10" });
      expect(await period("word", "2026-01-10")).toEqual({ s: "2026-01-04", e: "2026-01-10" });
      expect(await period("challenge", "2026-01-11")).toEqual({ s: "2026-01-11", e: "2026-01-17" });
      expect(await period("challenge", "2026-01-03")).toEqual({ s: null, e: null });
    });

    it("writes a change for tomorrow, keeps one pending row, and asking for today's cadence drops it (MAJOR-2)", async () => {
      await ensure("weekly");
      const sunday = await f.freshSunday();
      const picked = await f.questions();
      const made = await f.setChallenge(sunday, picked);
      const tuesday = await f.plus(sunday, 2);
      await f.goTo(tuesday);
      expect(await f.setCadence("challenge", "daily")).toEqual({
        kind: "challenge",
        cadence: "daily",
        from: await f.plus(tuesday, 1),
        unused: 0,
      });
      await f.setCadence("challenge", "daily");
      expect(await pendingRows("challenge")).toBe(1);
      expect(await f.setCadence("challenge", "weekly")).toEqual({
        kind: "challenge",
        cadence: "weekly",
        unchanged: true,
        unused: 0,
      });
      expect(await pendingRows("challenge")).toBe(0);
      expect(await period("challenge", await f.plus(tuesday, 1))).toEqual({
        s: sunday,
        e: await f.plus(sunday, 6),
      });
      // The running week and its challenge go on.
      await f.goTo(await f.plus(tuesday, 1));
      const player = await f.newPlayer();
      expect((await f.own(player))?.challenge).toMatchObject({ id: made.id });
      const audit = await f.owner<{ action: string; after: { cadence: string } }>(
        "SELECT action, after FROM audit_log WHERE action = 'daily.cadence_set' ORDER BY id DESC LIMIT 1",
      );
      expect(audit[0]?.after.cadence).toBe("weekly");
    });

    it("ends the running week the day before a switch to daily, and gives a short first week back to weekly", async () => {
      await ensure("weekly");
      const sunday = await f.freshSunday();
      const tuesday = await f.plus(sunday, 2);
      await f.goTo(tuesday);
      await f.setCadence("challenge", "daily");
      expect(await period("challenge", tuesday)).toEqual({ s: sunday, e: tuesday });
      const wednesday = await f.plus(tuesday, 1);
      await f.goTo(wednesday);
      expect(await period("challenge", wednesday)).toEqual({ s: wednesday, e: wednesday });
      expect(await f.setCadence("challenge", "weekly")).toMatchObject({
        from: await f.plus(wednesday, 1),
      });
      const thursday = await f.plus(wednesday, 1);
      expect(await period("challenge", thursday)).toEqual({
        s: thursday,
        e: await f.plus(sunday, 6),
      });
      expect(await period("challenge", await f.plus(sunday, 7))).toEqual({
        s: await f.plus(sunday, 7),
        e: await f.plus(sunday, 13),
      });
      // The word kind kept its own cadence.
      expect(await period("word", wednesday)).toEqual({ s: sunday, e: await f.plus(sunday, 6) });
      await f.goTo(thursday);
    });

    it("refuses any write of a cadence row whose day has come, the owner included", async () => {
      const today = await f.today();
      expect(
        await refusal(
          f.owner(
            "INSERT INTO daily_cadence (kind, from_day, cadence) VALUES ('word', $1, 'daily')",
            [today],
          ),
        ),
      ).toBe("DK409:started");
      expect(
        await refusal(
          f.owner("UPDATE daily_cadence SET cadence = 'daily' WHERE from_day = '2026-01-04'"),
        ),
      ).toBe("DK409:started");
      expect(
        await refusal(f.owner("DELETE FROM daily_cadence WHERE from_day = '2026-01-04'")),
      ).toBe("DK409:started");
      expect(await refusal(f.owner("TRUNCATE daily_cadence"))).toBe("42501");
      expect(await refusal(f.setCadence("challenge", "hourly" as "daily"))).toBe("DK422:cadence");
      expect(await refusal(f.setCadence("prize" as Kind, "daily"))).toBe("DK422:kind");
    });
  });

  describe("the cadence door against player doors (MAJOR-1)", () => {
    it("a player door waiting on today's cadence row works its period out after the change commits", async () => {
      const { sunday, picked, challenge, player } = await sundayChallenge();
      const crossed = await f.held(
        asAdmin(doorSql.cadence, ["challenge", "daily", randomUUID()]),
        f.asPlayerStatement(player, doorSql.answer, [challenge.id, picked[0], 1, 2]),
        { before: async () => f.goTo(await f.plus(sunday, 1)) },
      );
      expect(crossed.waited).toBe(true);
      // Monday is its own period now, so Sunday's weekly challenge is over for this door.
      expect((crossed.second as { detail?: string }).detail).toBe("period_over");
      await ensure("weekly");
    });

    it("the cadence door waits for a player door holding the row, then reads the clock after its lock", async () => {
      const { sunday, picked, challenge, player } = await sundayChallenge();
      const crossed = await f.held(
        f.asPlayerStatement(player, doorSql.answer, [challenge.id, picked[0], 1, 2]),
        asAdmin(doorSql.cadence, ["challenge", "daily", randomUUID()]),
        { between: async () => f.goTo(await f.plus(sunday, 1)) },
      );
      expect(crossed.waited).toBe(true);
      // The clock passed 04:00 while it waited: tomorrow is Tuesday, and no row lands on Monday, a day that has come.
      expect((crossed.second as { r: { from: string } }).r.from).toBe(await f.plus(sunday, 2));
      expect(
        await f.owner("SELECT 1 FROM daily_cadence WHERE kind = 'challenge' AND from_day = $1", [
          await f.plus(sunday, 1),
        ]),
      ).toEqual([]);
      await f.goTo(await f.plus(sunday, 2));
      await ensure("weekly");
    });

    it("never makes a content door wait: content doors read the cadence without a lock", async () => {
      const { sunday } = await sundayChallenge();
      const picked = await f.questions();
      const crossed = await f.held(
        asAdmin(doorSql.cadence, ["challenge", "daily", randomUUID()]),
        asAdmin(doorSql.challenge, [await f.plus(sunday, 7), picked, randomUUID()]),
      );
      expect(crossed.waited).toBe(false);
      expect(crossed.second).toHaveProperty("r");
      await f.goTo(await f.plus(sunday, 1));
      await ensure("weekly");
    });
  });

  describe("content (ADR-308, ADR-311)", () => {
    it("shows no challenge on a period without one, and the streak still counts by an event completion", async () => {
      await ensure("weekly");
      const sunday = await f.freshSunday();
      await f.goTo(sunday);
      const player = await f.newPlayer();
      expect(await f.own(player)).toEqual({ challenge: null, word: null });
      await f.play(await f.newEvent({ phase: "live" }), player);
      expect(await f.streakDays(player)).toEqual([sunday]);
    });

    it("leaves out a language with no word, and shows no game with none at all", async () => {
      const sunday = await f.freshSunday();
      const word = await f.setWord("ar", sunday, "كتابة");
      await f.goTo(sunday);
      const player = await f.newPlayer();
      expect((await f.own(player))?.word).toMatchObject({
        languages: ["ar"],
        words: [{ language: "ar", id: word.id }],
        play: null,
      });
    });

    it("uses a question once, refuses a retired, unknown or repeated one, and needs exactly three", async () => {
      const sunday = await f.freshSunday();
      const [q1, q2, q3, q4, q5] = await f.questions(5);
      await f.setChallenge(sunday, [q1 ?? "", q2 ?? "", q3 ?? ""]);
      const later = await f.plus(sunday, 7);
      const used = await f.setChallenge(later, [q4 ?? "", q1 ?? "", q5 ?? ""]).then(
        () => null,
        (e: { detail: string; hint: string }) => e,
      );
      expect(used).toMatchObject({ detail: "used", hint: "2" });
      await f.door("SELECT daily_question_retire($1, $2) AS r", [q4, randomUUID()]);
      expect(
        await refusal(f.setChallenge(later, [q4 ?? "", q5 ?? "", (await f.questions(1))[0] ?? ""])),
      ).toBe("DK409:retired");
      expect(await refusal(f.setChallenge(later, [q5 ?? "", q5 ?? "", q5 ?? ""]))).toBe(
        "DK422:questions",
      );
      expect(await refusal(f.setChallenge(later, [q5 ?? "", randomUUID(), randomUUID()]))).toBe(
        "DK422:questions",
      );
      expect(await refusal(f.setChallenge(later, [q5 ?? ""]))).toBe("DK422:questions");
      expect(
        await refusal(f.door("SELECT daily_question_retire($1, $2) AS r", [q1, randomUUID()])),
      ).toBe("DK409:scheduled");
      // A deferred rule holds three questions per challenge even for the owner.
      expect(
        await refusal(
          f.owner(
            `WITH c AS (INSERT INTO daily_challenge (starts_on) VALUES ($1) RETURNING id)
             INSERT INTO daily_challenge_question (challenge_id, position, question_id) SELECT id, 1, $2 FROM c`,
            [later, q5],
          ),
        ),
      ).toMatch(/^23514/);
    });

    it("refuses control and bidi characters in prompts, options and sponsor names", async () => {
      const bad = questionFields(1);
      expect(await refusal(f.saveQuestion({ ...bad, prompt: { ar: `سؤال${RLO}`, en: "Q" } }))).toBe(
        "DK422:prompt",
      );
      const options = bad.options.map((o, i) => (i === 0 ? { ...o, en: `Opt${BELL}` } : o));
      expect(await refusal(f.saveQuestion({ ...bad, options }))).toBe("DK422:options");
      expect(await refusal(f.saveQuestion({ ...bad, options: bad.options.slice(0, 1) }))).toBe(
        "DK422:options",
      );
      expect(await refusal(f.saveQuestion({ ...bad, answer: 4 }))).toBe("DK422:answer");
      expect(await refusal(f.saveQuestion({ ...bad, prompt: { ar: "  ", en: "Q" } }))).toBe(
        "DK422:prompt",
      );
      const sunday = await f.freshSunday();
      const picked = await f.questions();
      expect(
        await refusal(f.setChallenge(sunday, picked, { ar: `شركة${ISOLATE}`, en: "Acme" })),
      ).toBe("DK422:sponsor");
      expect(await refusal(f.setChallenge(sunday, picked, { ar: "شركة", en: "" }))).toBe(
        "DK422:sponsor",
      );
      const trimmed = await f.saveQuestion({ ...bad, prompt: { ar: "  سؤال  ", en: " Q " } });
      expect(trimmed).toMatchObject({
        prompt: { ar: "سؤال", en: "Q" },
        status: "ready",
        scheduledOn: null,
      });
    });

    it("keys content by its period's first day (DK422 not_period_start) and refuses a started day", async () => {
      await ensure("weekly");
      const sunday = await f.freshSunday();
      const picked = await f.questions();
      expect(await refusal(f.setChallenge(await f.plus(sunday, 2), picked))).toBe(
        "DK422:not_period_start",
      );
      expect(await refusal(f.setWord("en", await f.plus(sunday, 3), "crane"))).toBe(
        "DK422:not_period_start",
      );
      expect(await refusal(f.setChallenge(await f.today(), picked))).toBe("DK409:started");
      expect(await refusal(f.setWord("en", sunday, "cr4ne"))).toBe("DK422:word");
      expect(await refusal(f.setWord("en", sunday, "cranes"))).toBe("DK422:word");
      expect(await refusal(f.setWord("fr" as "en", sunday, "crane"))).toBe("DK422:language");
      await f.setWord("en", sunday, "crane");
      expect(await refusal(f.setWord("en", await f.plus(sunday, 7), "CRANE"))).toBe("DK409:used");
    });

    it("freezes a started period's challenge, its questions and its word for the doors and the owner", async () => {
      await ensure("weekly");
      const sunday = await f.freshSunday();
      const picked = await f.questions();
      const challenge = await f.setChallenge(sunday, picked, { ar: "شركة", en: "Acme" });
      const word = await f.setWord("en", sunday, "slate");
      await f.goTo(sunday);
      const spare = await f.questions();
      const doors = [
        () => f.setChallenge(sunday, spare),
        () => f.door("SELECT daily_challenge_clear($1, $2) AS r", [sunday, randomUUID()]),
        () => f.saveQuestion(questionFields(9), picked[0] ?? ""),
        () => f.door("SELECT daily_question_retire($1, $2) AS r", [picked[1], randomUUID()]),
        () => f.setWord("en", sunday, "light"),
        () => f.door("SELECT daily_word_clear($1, $2, $3) AS r", ["en", sunday, randomUUID()]),
      ];
      for (const work of doors) expect(await refusal(work())).toBe("DK409:started");
      const owner = [
        [
          "UPDATE daily_challenge SET sponsor_ar = NULL, sponsor_en = NULL WHERE id = $1",
          [challenge.id],
        ],
        ["DELETE FROM daily_challenge WHERE id = $1", [challenge.id]],
        ["UPDATE daily_question SET prompt_en = 'Changed' WHERE id = $1", [picked[0]]],
        ["DELETE FROM daily_challenge_question WHERE challenge_id = $1", [challenge.id]],
        ["INSERT INTO daily_challenge (starts_on) VALUES ($1)", [sunday]],
        ["DELETE FROM daily_word WHERE id = $1", [word.id]],
      ] as const;
      for (const [sql, values] of owner)
        expect(await refusal(f.owner(sql, [...values]))).toBe("DK409:started");
      expect(
        await refusal(f.owner("UPDATE daily_word SET display = 'slate' WHERE id = $1", [word.id])),
      ).toBe("42501");
      expect(
        await refusal(f.owner("UPDATE daily_challenge_question SET position = position")),
      ).toBe("42501");
      for (const table of [
        "daily_challenge",
        "daily_word",
        "daily_question",
        "daily_challenge_question",
      ]) {
        expect(await refusal(f.owner(`TRUNCATE ${table} CASCADE`))).toBe("42501");
      }
    });

    it("lists content stranded by a cadence change as unused, and clears it while it has no plays", async () => {
      await ensure("daily");
      const day = await f.freshDay();
      const tuesday = await f.plus(day, 3);
      const [row] = await f.owner<{ dow: number }>(
        "SELECT extract(dow FROM $1::date)::int AS dow",
        [tuesday],
      );
      const stranded = row?.dow === 0 ? await f.plus(tuesday, 1) : tuesday;
      await f.setChallenge(stranded, await f.questions());
      await f.setWord("en", stranded, "brick");
      expect(await f.setCadence("challenge", "weekly")).toMatchObject({ unused: 1 });
      expect(await f.setCadence("word", "weekly")).toMatchObject({ unused: 1 });
      const read = await consoleRead(await f.today(), await f.plus(await f.today(), 14));
      expect(read.unused).toEqual(
        expect.arrayContaining([
          { kind: "challenge", language: null, startsOn: stranded },
          { kind: "word", language: "en", startsOn: stranded },
        ]),
      );
      // Its day passes; with no plays it can still be cleared.
      await f.goTo(await f.plus(stranded, 1));
      expect(
        await f.door("SELECT daily_challenge_clear($1, $2) AS r", [stranded, randomUUID()]),
      ).toEqual({
        startsOn: stranded,
        cleared: true,
      });
      expect(
        await f.door("SELECT daily_word_clear($1, $2, $3) AS r", ["en", stranded, randomUUID()]),
      ).toEqual({
        language: "en",
        startsOn: stranded,
        cleared: true,
      });
      expect(
        await refusal(
          f.door("SELECT daily_challenge_clear($1, $2) AS r", [stranded, randomUUID()]),
        ),
      ).toBe("DK404");
      await ensure("weekly");
    });

    it("refuses to clear a played period's content", async () => {
      const { day, picked, challenge } = await f.challengeToday();
      const player = await f.newPlayer();
      await f.answer(player, challenge.id, picked[0] ?? "", 1, 2);
      await f.goTo(await f.plus(day, 8));
      expect(
        await refusal(f.door("SELECT daily_challenge_clear($1, $2) AS r", [day, randomUUID()])),
      ).toBe("DK409:started");
    });
  });

  describe("the warnings (FR-1733, FR-1811, FR-1814)", () => {
    it("warns the challenge under 7 days under the daily cadence (6 vs 7)", async () => {
      await ensure("daily");
      const first = await f.freshDay();
      for (let i = 0; i < 6; i += 1)
        await f.setChallenge(await f.plus(first, i), await f.questions());
      await f.goTo(first);
      const six = (await consoleRead(first, first)).status.challenge;
      expect(six).toMatchObject({
        cadence: "daily",
        coveredDays: 6,
        coveredPeriods: 6,
        warn: true,
      });
      await f.setChallenge(await f.plus(first, 6), await f.questions());
      expect((await consoleRead(first, first)).status.challenge).toMatchObject({
        coveredDays: 7,
        warn: false,
      });
      await ensure("weekly");
    });

    it("warns the challenge under 2 weeks and each word language under 2 periods (weekly)", async () => {
      await ensure("weekly");
      const sunday = await f.freshSunday();
      await f.setChallenge(sunday, await f.questions());
      await f.setWord("ar", sunday, "مدرسة");
      await f.setWord("ar", await f.plus(sunday, 7), "سلامة");
      await f.setWord("en", sunday, "fudge");
      await f.goTo(sunday);
      const one = (await consoleRead(sunday, sunday)).status;
      expect(one.challenge).toMatchObject({ coveredDays: 7, coveredPeriods: 1, warn: true });
      expect(one.word.ar).toEqual({ coveredDays: 14, coveredPeriods: 2, warn: false });
      expect(one.word.en).toEqual({ coveredDays: 7, coveredPeriods: 1, warn: true });
      await f.setChallenge(await f.plus(sunday, 7), await f.questions());
      expect((await consoleRead(sunday, sunday)).status.challenge).toMatchObject({
        coveredDays: 14,
        coveredPeriods: 2,
        warn: false,
      });
      // A day later the current week covers 6 days from today.
      await f.goTo(await f.plus(sunday, 1));
      expect((await consoleRead(sunday, sunday)).status.challenge).toMatchObject({
        coveredDays: 13,
        warn: false,
      });
    });
  });

  describe("the 04:00 races (MAJOR-1), each crossed both ways", () => {
    let words = 0;
    const nextWord = () => {
      words += 1;
      return (
        ["plumb", "quilt", "vexed", "wharf", "joker", "zesty", "nymph", "gawky", "kiosk", "mirth"][
          words - 1
        ] ?? ""
      );
    };
    const ready = async () => {
      await ensure("weekly");
      const sunday = await f.freshSunday();
      const picked = await f.questions();
      const challenge = await f.setChallenge(sunday, picked);
      await f.listWords("en", ["adieu", "stomp"]);
      const word = await f.setWord("en", sunday, nextWord());
      return {
        sunday,
        picked,
        challenge,
        word,
        player: await f.newPlayer(),
        eve: await f.plus(sunday, -1),
      };
    };

    it("a challenge save holding its row across 04:00: the waiting player reads it as committed", async () => {
      const { sunday, picked, challenge, player } = await ready();
      const fresh = await f.questions();
      const crossed = await f.held(
        asAdmin(doorSql.challenge, [sunday, fresh, randomUUID()]),
        f.asPlayerStatement(player, doorSql.answer, [challenge.id, picked[0], 1, 2]),
        { before: async () => f.goTo(sunday) },
      );
      expect(crossed.waited).toBe(true);
      expect((crossed.second as { detail?: string }).detail).toBe("changed");
      expect(await f.answer(player, challenge.id, fresh[0] ?? "", 1, 2)).toMatchObject({
        answer: { correct: true },
      });
    });

    it("a player door holding the challenge across 04:00: the save checks the clock after its lock", async () => {
      const { sunday, picked, challenge, player, eve } = await ready();
      await f.goTo(sunday);
      const crossed = await f.held(
        f.asPlayerStatement(player, doorSql.answer, [challenge.id, picked[0], 1, 2]),
        asAdmin(doorSql.challenge, [sunday, await f.questions(), randomUUID()]),
        { before: async () => f.goTo(eve), between: async () => f.goTo(sunday) },
      );
      expect(crossed.waited).toBe(true);
      expect((crossed.second as { code?: string; detail?: string }).detail).toBe("started");
    });

    it("a word save replacing the word across 04:00: the old id, read without a lock, is `changed`", async () => {
      const { sunday, word, player } = await ready();
      const crossed = await f.held(
        asAdmin(doorSql.word, ["en", sunday, nextWord(), randomUUID()]),
        f.asPlayerStatement(player, doorSql.guess, [word.id, 1, "adieu"]),
        {
          before: async () => {
            await f.goTo(sunday);
            const seen = (await f.own(player))?.word as { words: { id: number }[] };
            expect(seen.words[0]?.id).toBe(word.id);
          },
        },
      );
      expect(crossed.waited).toBe(true);
      expect((crossed.second as { detail?: string }).detail).toBe("changed");
    });

    it("a player door holding the word across 04:00: the word save is refused by the clock", async () => {
      const { sunday, word, player, eve } = await ready();
      await f.goTo(sunday);
      const crossed = await f.held(
        f.asPlayerStatement(player, doorSql.guess, [word.id, 1, "adieu"]),
        asAdmin(doorSql.word, ["en", sunday, nextWord(), randomUUID()]),
        { before: async () => f.goTo(eve), between: async () => f.goTo(sunday) },
      );
      expect(crossed.waited).toBe(true);
      expect((crossed.second as { detail?: string }).detail).toBe("started");
    });

    it("a question save locks its challenge first, both ways", async () => {
      const { sunday, picked, challenge, player, eve } = await ready();
      const edited = { ...questionFields(1), answer: 3 };
      const adminFirst = await f.held(
        asAdmin(doorSql.question, [picked[0], JSON.stringify(edited), randomUUID()]),
        f.asPlayerStatement(player, doorSql.answer, [challenge.id, picked[0], 1, 3]),
        { before: async () => f.goTo(sunday) },
      );
      expect(adminFirst.waited).toBe(true);
      // Same question id, its committed right answer: 3.
      expect(
        (adminFirst.second as { r: { answer: { right: number; correct: boolean } } }).r.answer,
      ).toMatchObject({
        right: 3,
        correct: true,
      });
      const other = await f.newPlayer();
      const playerFirst = await f.held(
        f.asPlayerStatement(other, doorSql.answer, [challenge.id, picked[0], 1, 1]),
        asAdmin(doorSql.question, [picked[1], JSON.stringify(questionFields(2)), randomUUID()]),
        { before: async () => f.goTo(eve), between: async () => f.goTo(sunday) },
      );
      expect(playerFirst.waited).toBe(true);
      expect((playerFirst.second as { detail?: string }).detail).toBe("started");
    });
  });

  describe("the console's doors and reads", () => {
    it("names the unique keys the API answers by name (changed, used)", async () => {
      const rows = await f.owner<{ conname: string }>(
        `SELECT conname FROM pg_constraint WHERE contype = 'u' AND conrelid IN ('daily_challenge'::regclass,
           'daily_word'::regclass) ORDER BY 1`,
      );
      expect(rows.map((row) => row.conname)).toEqual([
        "daily_challenge_starts_on_key",
        "daily_word_language_starts_on_key",
        "daily_word_language_word_key",
      ]);
    });

    it("adds and removes guess-list words in counts, refusing invalid ones", async () => {
      const result = await f.listWords(
        "en",
        ["Hello", "hello", "abc", "w0rld", "zebra"],
        ["hello", "nope!"],
      );
      expect(result).toMatchObject({ added: 2, removed: 1, refused: ["abc", "w0rld", "nope!"] });
      expect(
        await refusal(
          f.listWords(
            "en",
            Array.from({ length: 20001 }, () => "zebra"),
          ),
        ),
      ).toBe("DK422:add");
      expect(await refusal(f.listWords("fr" as "en", ["zebra"]))).toBe("DK422:language");
      const page = await f.door<{ words: string[]; total: number }>(
        "SELECT word_list_page($1, $2, $3) AS r",
        ["en", " ZEB", 1],
      );
      expect(page).toEqual({ words: ["zebra"], total: 1 });
      const audit = await f.owner<{ after: Record<string, unknown> }>(
        "SELECT after FROM audit_log WHERE action = 'daily.word_list_changed' ORDER BY id DESC LIMIT 1",
      );
      expect(JSON.stringify(audit)).not.toMatch(/zebra|hello/);
    });

    it("reads the schedule by period with finish counts, the bank with answers, and audits without secrets", async () => {
      await ensure("weekly");
      const { day, picked, challenge } = await f.challengeToday({ ar: "شركة", en: "Acme" });
      const player = await f.newPlayer();
      for (let pos = 1; pos <= 3; pos += 1)
        await f.answer(player, challenge.id, picked[pos - 1] ?? "", pos, 2);
      const read = await consoleRead(day, await f.plus(day, 13));
      const challenges = read.periods.filter((p) => p.kind === "challenge");
      expect(challenges.map((p) => p.startsOn)).toEqual([day, await f.plus(day, 7)]);
      expect(challenges[0]?.challenge).toMatchObject({
        id: challenge.id,
        questions: picked,
        sponsor: { ar: "شركة", en: "Acme" },
        finishes: 1,
      });
      expect(challenges[1]?.challenge).toBeNull();
      expect(read.periods.filter((p) => p.kind === "word")[0]?.words).toEqual({});
      expect(await refusal(consoleRead(day, await f.plus(day, 121)))).toBe("DK422:range");
      const bank = await f.door<{ id: string; answer: number; scheduledOn: string | null }[]>(
        "SELECT daily_question_list(NULL, NULL, 3) AS r",
      );
      expect(bank).toHaveLength(3);
      expect(bank.map((q) => q.id)).toEqual(picked.toReversed());
      expect(bank[0]).toMatchObject({ answer: 2, scheduledOn: day });
      const next = await f.door<{ id: string }[]>(
        "SELECT daily_question_list('ready', $1, 2) AS r",
        [bank[2]?.id],
      );
      expect(next).toHaveLength(2);
      const audits = await f.owner<{ action: string; after: unknown }>(
        "SELECT action, after FROM audit_log WHERE action LIKE 'daily.%' ORDER BY id",
      );
      expect(audits.length).toBeGreaterThan(5);
      expect(JSON.stringify(audits)).not.toMatch(/Question|Option|crane|slate|كتابة/);
    });

    it("refuses every console door to anyone but an active platform admin (QY403)", async () => {
      const player = await f.newPlayer();
      const seats = [
        { playerId: player },
        { staffUserId: f.ownerA, organizerId: f.ids.orgA },
        { isAdmin: true },
      ];
      for (const context of seats) {
        for (const sql of [
          "SELECT daily_console(current_date, current_date)",
          "SELECT daily_question_save(NULL, '{}'::jsonb, gen_random_uuid())",
          "SELECT daily_cadence_set('word', 'daily', gen_random_uuid())",
          "SELECT word_list_page('en', '', 1)",
        ]) {
          expect(await refusal(f.run(context, sql))).toBe("QY403");
        }
      }
    });
  });
});
