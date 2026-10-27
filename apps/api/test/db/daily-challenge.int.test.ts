import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dailyFixture, refusal, type DailyFixture } from "#test/support/daily";
import { TEST_DATABASE_URL } from "#test/support/test-db";

type Reply = {
  answer: { position: number; choice: number; correct: boolean; right: number };
  finished: { correct: number; xp: number } | null;
  levelUp: { level: number } | null;
  dailyStreak: { days: number; today: boolean } | null;
  replayed: boolean;
};
type Challenge = {
  id: number;
  period: { startsOn: string; endsOn: string };
  sponsor: { ar: string; en: string } | null;
  questions: {
    id: string;
    position: number;
    options: { ar: string; en: string }[];
    answered: { choice: number; correct: boolean; right: number } | null;
  }[];
  finished: { correct: number; xp: number } | null;
};

/**
 * The daily challenge in the database (T-406, migration 0069, FR-730, FR-731, ADR-309): three answers in order, each
 * final, the finish paying 20 XP plus 10 a right answer once through xp_entry's `daily` source and keeping the daily
 * streak; the period and content checks before anything secret; replays by the natural key; the switch; the XP field
 * ranges; levels and gems; the lock order against every live path that shares the player's rows.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("the daily challenge (database)", () => {
  let f: DailyFixture;
  beforeAll(async () => {
    f = await dailyFixture();
  });
  afterAll(async () => {
    await f.close();
  });

  const answer = (player: string, c: number, q: string, pos: number, choice: number) =>
    f.answer(player, c, q, pos, choice) as Promise<Reply>;
  const own = async (player: string) => (await f.own(player))?.challenge as Challenge | null;
  /** All three answers; the right option is 2. */
  const playAll = async (player: string, c: number, picked: string[], choices = [2, 2, 2]) => {
    let last: Reply | undefined;
    for (let pos = 1; pos <= 3; pos += 1) {
      last = await answer(player, c, picked[pos - 1] ?? "", pos, choices[pos - 1] ?? 1);
    }
    return last as Reply;
  };
  const count = async (sql: string, values: unknown[] = []) =>
    Number((await f.owner<{ n: string }>(`SELECT count(*) AS n FROM ${sql}`, values))[0]?.n);

  it("pays 20 XP plus 10 a right answer once at the third answer, as one daily XP entry", async () => {
    const { picked, challenge } = await f.challengeToday();
    const player = await f.newPlayer();
    const first = await answer(player, challenge.id, picked[0] ?? "", 1, 2);
    expect(first).toMatchObject({
      answer: { position: 1, choice: 2, correct: true, right: 2 },
      finished: null,
      levelUp: null,
      replayed: false,
    });
    expect(await count("xp_entry WHERE player_id = $1", [player])).toBe(0);
    await answer(player, challenge.id, picked[1] ?? "", 2, 1);
    const last = await answer(player, challenge.id, picked[2] ?? "", 3, 2);
    expect(last.answer).toEqual({ position: 3, choice: 2, correct: true, right: 2 });
    expect(last.finished).toEqual({ correct: 2, xp: 40 });
    expect(await f.xpOf(player)).toBe(40);
    const rows = await f.owner<{ source: string; delta: number; daily_finish_id: string | null }>(
      "SELECT source, delta, daily_finish_id FROM xp_entry WHERE player_id = $1",
      [player],
    );
    expect(rows).toEqual([{ source: "daily", delta: 40, daily_finish_id: expect.any(String) }]);
    expect(await f.xpHolds(player)).toBe(true);
    expect(await f.streakDays(player)).toEqual([await f.today()]);
    expect(last.dailyStreak).toMatchObject({ days: 1, today: true });
  });

  it("pays 20 XP for a finish with no right answer: answering is what earns", async () => {
    const { picked, challenge } = await f.challengeToday();
    const player = await f.newPlayer();
    const last = await playAll(player, challenge.id, picked, [1, 3, 1]);
    expect(last.finished).toEqual({ correct: 0, xp: 20 });
    expect(await f.xpOf(player)).toBe(20);
  });

  it("keeps every answer final: a replay answers the stored one, another choice or order is refused", async () => {
    const { picked, challenge } = await f.challengeToday();
    const player = await f.newPlayer();
    const q = (n: number) => picked[n - 1] ?? "";
    expect(await refusal(answer(player, challenge.id, q(2), 2, 2))).toBe("DC409:out_of_order");
    await answer(player, challenge.id, q(1), 1, 3);
    const again = await answer(player, challenge.id, q(1), 1, 3);
    expect(again).toMatchObject({
      answer: { choice: 3, correct: false, right: 2 },
      replayed: true,
    });
    const err = await f.answer(player, challenge.id, q(1), 1, 2).then(
      () => null,
      (e: { code: string; detail: string; message: string; hint?: string }) => e,
    );
    expect(err).toMatchObject({ code: "DC409", detail: "answered" });
    // No stored value is named by the refusal (MINOR-5).
    expect(`${err?.message}|${err?.hint ?? ""}`).not.toMatch(/3|2/);
    expect(await refusal(answer(player, challenge.id, q(3), 3, 2))).toBe("DC409:out_of_order");
    expect(await refusal(answer(player, challenge.id, q(2), 2, 4))).toBe("DC422:choice");
    expect(await refusal(answer(player, challenge.id, q(2), 2, 0))).toBe("DC422:choice");
    expect(await refusal(answer(player, challenge.id, q(2), 4, 1))).toBe("DC422:position");
    expect(
      await count("daily_answer a JOIN daily_play y ON y.id = a.play_id WHERE y.player_id = $1", [
        player,
      ]),
    ).toBe(1);
  });

  it("replays the third answer with the finish read from daily_finish, and pays nothing twice", async () => {
    const { picked, challenge } = await f.challengeToday();
    const player = await f.newPlayer();
    await playAll(player, challenge.id, picked);
    const replay = await answer(player, challenge.id, picked[2] ?? "", 3, 2);
    expect(replay).toMatchObject({
      finished: { correct: 3, xp: 50 },
      levelUp: null,
      replayed: true,
    });
    const early = await answer(player, challenge.id, picked[0] ?? "", 1, 2);
    expect(early).toMatchObject({ finished: { correct: 3, xp: 50 }, replayed: true });
    expect(await f.xpOf(player)).toBe(50);
    expect(await count("daily_finish WHERE player_id = $1", [player])).toBe(1);
  });

  it("refuses a stale question, an unknown challenge and another period's challenge before anything is written", async () => {
    const { picked, challenge, day } = await f.challengeToday();
    const player = await f.newPlayer();
    expect(await refusal(answer(player, challenge.id, picked[1] ?? "", 1, 2))).toBe(
      "DC409:changed",
    );
    expect(await refusal(answer(player, challenge.id + 100000, picked[0] ?? "", 1, 2))).toBe(
      "DC409:changed",
    );
    // A known challenge of a later period (set while today is still this one) is not current.
    const later = await f.plus(day, 7);
    const next = await f.setChallenge(later, await f.questions());
    expect(await refusal(answer(player, next.id, next.questions[0] ?? "", 1, 2))).toBe(
      "DC409:period_over",
    );
    expect(await count("daily_play WHERE player_id = $1", [player])).toBe(0);
    // The next period gives a new challenge; the old one is over.
    await f.goTo(later);
    expect(await refusal(answer(player, challenge.id, picked[0] ?? "", 1, 2))).toBe(
      "DC409:period_over",
    );
    expect((await own(player))?.id).toBe(next.id);
  });

  it("is one play for the whole week under the weekly cadence", async () => {
    const { picked, challenge, day } = await f.challengeToday();
    const player = await f.newPlayer();
    await answer(player, challenge.id, picked[0] ?? "", 1, 2);
    await f.goTo(await f.plus(day, 6));
    expect(await refusal(answer(player, challenge.id, picked[0] ?? "", 1, 1))).toBe(
      "DC409:answered",
    );
    const last = await playAll(player, challenge.id, picked);
    expect(last.finished).toEqual({ correct: 3, xp: 50 });
    expect((await own(player))?.period).toEqual({ startsOn: day, endsOn: await f.plus(day, 6) });
    expect(await count("daily_play WHERE player_id = $1", [player])).toBe(1);
  });

  it("never shows the right option of an unanswered question, and shows the sponsor for its period only", async () => {
    const { picked, challenge, day } = await f.challengeToday({ ar: "شركة", en: "Acme" });
    const player = await f.newPlayer();
    const before = await own(player);
    expect(before?.sponsor).toEqual({ ar: "شركة", en: "Acme" });
    expect(before?.questions.map((q) => q.answered)).toEqual([null, null, null]);
    expect(JSON.stringify(before)).not.toMatch(/"right"|"answer"/);
    expect(before?.questions[0]?.options).toHaveLength(3);
    await answer(player, challenge.id, picked[0] ?? "", 1, 1);
    const after = await own(player);
    expect(after?.questions.map((q) => q.answered)).toEqual([
      { choice: 1, correct: false, right: 2 },
      null,
      null,
    ]);
    expect(JSON.stringify(after?.questions.slice(1))).not.toMatch(/"right"/);
    // Another player sees nothing of this play.
    const other = await f.newPlayer();
    expect((await own(other))?.questions.map((q) => q.answered)).toEqual([null, null, null]);
    // The next period has no sponsor and, here, no challenge at all.
    await f.goTo(await f.plus(day, 7));
    expect(await own(player)).toBeNull();
  });

  it("refuses at once when the switch goes off mid-play: the play stays unfinished, no XP, no streak", async () => {
    const { picked, challenge } = await f.challengeToday();
    const player = await f.newPlayer();
    await answer(player, challenge.id, picked[0] ?? "", 1, 2);
    await answer(player, challenge.id, picked[1] ?? "", 2, 2);
    await f.switchFeature("dailyChallenge", false);
    try {
      expect(await refusal(answer(player, challenge.id, picked[2] ?? "", 3, 2))).toBe(
        "DC404:unavailable",
      );
      expect((await f.own(player))?.challenge).toBeNull();
      expect(await count("daily_finish WHERE player_id = $1", [player])).toBe(0);
      expect(await f.xpOf(player)).toBe(0);
      expect(await f.streakDays(player)).toEqual([]);
    } finally {
      await f.switchFeature("dailyChallenge", true);
    }
  });

  it("refuses a caller who is not an active player", async () => {
    const { picked, challenge } = await f.challengeToday();
    expect(await refusal(answer(randomUUID(), challenge.id, picked[0] ?? "", 1, 2))).toBe("PI401");
    expect(await f.own(randomUUID())).toBeNull();
  });

  it("keeps the daily streak with no event play, once a day, and only while its switch is on (FR-731)", async () => {
    const { picked, challenge } = await f.challengeToday();
    const player = await f.newPlayer();
    const yesterday = await f.plus(await f.today(), -1);
    await f.owner("INSERT INTO questify_streak_day (player_id, day) VALUES ($1, $2)", [
      player,
      yesterday,
    ]);
    const partial = await answer(player, challenge.id, picked[0] ?? "", 1, 2);
    expect(partial.dailyStreak).toMatchObject({ days: 1, today: false });
    const last = await playAll(player, challenge.id, picked);
    expect(last.dailyStreak).toMatchObject({ days: 2, today: true });
    expect(await f.streakDays(player)).toEqual([yesterday, await f.today()]);

    // A day already counted by an event completion writes nothing new.
    const counted = await f.newPlayer();
    await f.play(await f.newEvent({ phase: "live" }), counted);
    await playAll(counted, challenge.id, picked);
    expect(await f.streakDays(counted)).toEqual([await f.today()]);

    await f.switchFeature("dailyStreak", false);
    try {
      const off = await f.newPlayer();
      const done = await playAll(off, challenge.id, picked);
      expect(done.finished?.xp).toBe(50);
      expect(done.dailyStreak).toBeNull();
      expect(await f.streakDays(off)).toEqual([]);
    } finally {
      await f.switchFeature("dailyStreak", true);
    }
  });

  it("pays at most 1000 XP with every field at its maximum, and a field out of range falls back (MAJOR-3)", async () => {
    const { picked, challenge } = await f.challengeToday();
    await f.xpSetting({ dailyFinishXp: 400, dailyRightXp: 200 });
    try {
      const top = await f.newPlayer();
      expect((await playAll(top, challenge.id, picked)).finished).toEqual({ correct: 3, xp: 1000 });
      await f.xpSetting({ dailyFinishXp: 401, dailyRightXp: "7" });
      const fallback = await f.newPlayer();
      expect((await playAll(fallback, challenge.id, picked)).finished).toEqual({
        correct: 3,
        xp: 50,
      });
      await f.xpSetting({ dailyFinishXp: 0, dailyRightXp: 0 });
      const nothing = await f.newPlayer();
      expect((await playAll(nothing, challenge.id, picked)).finished).toEqual({
        correct: 3,
        xp: 0,
      });
      expect(await count("xp_entry WHERE player_id = $1", [nothing])).toBe(0);
    } finally {
      await f.owner(
        "UPDATE platform_setting SET value = value - 'dailyFinishXp' - 'dailyRightXp' WHERE key = 'xp'",
      );
    }
  });

  it("levels up at once from daily XP and pays the level's gems at the next sync", async () => {
    const { picked, challenge } = await f.challengeToday();
    const player = await f.newPlayer();
    await f.play(await f.newEvent({ phase: "live" }), player);
    await f.xpSetting({ dailyFinishXp: 100 });
    try {
      const last = await playAll(player, challenge.id, picked);
      expect(last.finished?.xp).toBe(130);
      expect(last.levelUp?.level).toBe(2);
      // The level's item is granted at once, with the XP.
      expect(
        (last.levelUp as { items?: { id: string }[] } | null)?.items?.map((item) => item.id),
      ).toEqual(["level-2"]);
      expect(
        await count("player_item WHERE player_id = $1 AND item_id = 'level-2'", [player]),
      ).toBe(1);
    } finally {
      await f.owner("UPDATE platform_setting SET value = value - 'dailyFinishXp' WHERE key = 'xp'");
    }
    const synced = (
      await f.asPlayer<{ r: { gems: { earned: number } } }>(player, "SELECT questify_sync() AS r")
    )[0]?.r;
    expect(synced?.gems.earned).toBeGreaterThan(0);
    expect(
      await count("gem_entry WHERE player_id = $1 AND source = 'level' AND source_level = 2", [
        player,
      ]),
    ).toBe(1);
    expect(await f.xpHolds(player)).toBe(true);
  });

  it("refuses forged daily XP rows, and no gem source or gem writer knows the daily games", async () => {
    const { picked, challenge } = await f.challengeToday();
    const player = await f.newPlayer();
    await playAll(player, challenge.id, picked);
    const [finish] = await f.owner<{ id: string }>(
      "SELECT id FROM daily_finish WHERE player_id = $1",
      [player],
    );
    const forge = (sql: string, values: unknown[]) => refusal(f.owner(sql, values));
    // A second entry for the same finish, a daily entry with no finish, a negative one, another player's finish.
    expect(
      await forge(
        "INSERT INTO xp_entry (player_id, delta, source, daily_finish_id) VALUES ($1, 5, 'daily', $2)",
        [player, finish?.id],
      ),
    ).toMatch(/^23505/);
    expect(
      await forge("INSERT INTO xp_entry (player_id, delta, source) VALUES ($1, 5, 'daily')", [
        player,
      ]),
    ).toMatch(/^23514/);
    expect(
      await forge(
        "INSERT INTO xp_entry (player_id, delta, source, daily_finish_id) VALUES ($1, -5, 'daily', $2)",
        [player, finish?.id],
      ),
    ).toMatch(/^23514/);
    // A 0-XP finish has no entry: another player cannot claim it, nor a quest-shaped row name it.
    await f.xpSetting({ dailyFinishXp: 0, dailyRightXp: 0 });
    const zero = await f.newPlayer();
    await playAll(zero, challenge.id, picked);
    await f.owner(
      "UPDATE platform_setting SET value = value - 'dailyFinishXp' - 'dailyRightXp' WHERE key = 'xp'",
    );
    const [empty] = await f.owner<{ id: string }>(
      "SELECT id FROM daily_finish WHERE player_id = $1",
      [zero],
    );
    const other = await f.newPlayer();
    expect(
      await forge(
        "INSERT INTO xp_entry (player_id, delta, source, daily_finish_id) VALUES ($1, 5, 'daily', $2)",
        [other, empty?.id],
      ),
    ).toMatch(/^23503/);
    expect(
      await forge(
        `INSERT INTO xp_entry (player_id, delta, source, daily_finish_id, ledger_entry_id, quest_id)
         VALUES ($1, 5, 'quest', $2, NULL, NULL)`,
        [zero, empty?.id],
      ),
    ).toMatch(/^23514/);
    const [gems] = await f.owner<{ def: string }>(
      "SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'gem_entry_shape'",
    );
    expect(gems?.def).not.toMatch(/daily/);
    const writers = await f.owner<{ name: string }>(
      `SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prosrc ~ 'INSERT INTO gem_entry' ORDER BY 1`,
    );
    expect(writers.map((w) => w.name)).toEqual(["gem_buy", "questify_sync"]);
    const daily = await f.owner<{ name: string }>(
      `SELECT p.proname AS name FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname LIKE 'daily%' AND p.prosrc ~ '(gem_entry|ledger_entry|enrollment)'`,
    );
    expect(daily).toEqual([]);
  });

  it("keeps the four play tables append-only for every role, the owner included", async () => {
    const { picked, challenge } = await f.challengeToday();
    const player = await f.newPlayer();
    await playAll(player, challenge.id, picked);
    for (const table of ["daily_play", "daily_answer", "daily_finish"]) {
      expect(await refusal(f.owner(`UPDATE ${table} SET created_at = now()`))).toBe("42501");
      expect(await refusal(f.owner(`DELETE FROM ${table}`))).toBe("42501");
      expect(await refusal(f.owner(`TRUNCATE ${table} CASCADE`))).toBe("42501");
    }
  });

  describe("crossing other writers of the same player (no deadlock; one streak row; paid once)", () => {
    const sql = "SELECT daily_answer_submit($1, $2, $3, $4) AS r";
    const ready = async () => {
      const { picked, challenge } = await f.challengeToday();
      const player = await f.newPlayer();
      await answer(player, challenge.id, picked[0] ?? "", 1, 2);
      await answer(player, challenge.id, picked[1] ?? "", 2, 2);
      const last = f.asPlayerStatement(player, sql, [challenge.id, picked[2], 3, 2]);
      return { player, picked, challenge, last };
    };

    it("two copies of one answer: one writes, the other replays; another choice is refused", async () => {
      const { player, last } = await ready();
      const crossed = await f.held(last, last);
      expect(crossed.waited).toBe(true);
      expect((crossed.second as { r: Reply }).r.replayed).toBe(true);
      expect(await f.xpOf(player)).toBe(50);
      const other = await ready();
      const differ = await f.held(other.last, {
        ...other.last,
        values: [...(other.last.values ?? []).slice(0, 3), 1],
      });
      expect((differ.second as { detail?: string }).detail).toBe("answered");
    });

    it("the challenge's last answer and the word's sixth guess together, both orders: both paid, one streak row", async () => {
      for (const [challengeFirst, target] of [
        [true, "crane"],
        [false, "slate"],
      ] as const) {
        const day = await f.freshSunday();
        const picked = await f.questions();
        const challenge = await f.setChallenge(day, picked);
        await f.listWords("en", ["adieu", "stomp", "light", "brick", "fudge"]);
        const word = await f.setWord("en", day, target);
        await f.goTo(day);
        const player = await f.newPlayer();
        await answer(player, challenge.id, picked[0] ?? "", 1, 2);
        await answer(player, challenge.id, picked[1] ?? "", 2, 2);
        for (const [n, text] of ["adieu", "stomp", "light", "brick", "fudge"].entries()) {
          await f.guess(player, word.id, n + 1, text);
        }
        const last = f.asPlayerStatement(player, sql, [challenge.id, picked[2], 3, 2]);
        const sixth = f.asPlayerStatement(player, "SELECT daily_guess_submit($1, $2, $3) AS r", [
          word.id,
          6,
          "adieu",
        ]);
        const crossed = challengeFirst ? await f.held(last, sixth) : await f.held(sixth, last);
        expect(crossed.waited).toBe(true);
        expect(crossed.second).toHaveProperty("r");
        expect(await f.streakDays(player)).toEqual([day]);
        expect(await count("daily_finish WHERE player_id = $1", [player])).toBe(2);
        expect(await f.xpOf(player)).toBe(50);
        expect(await f.xpHolds(player)).toBe(true);
      }
    });

    it("the same player's first event completion of the day, both orders: one streak row, both paid", async () => {
      for (const daily of [true, false]) {
        const { player, last } = await ready();
        const event = await f.newEvent({ phase: "live" });
        await f.join(event, player);
        const [quest] = await f.owner<{ id: string }>(
          `INSERT INTO quest (event_id, category_id, type, title_en, points, repeat_cap)
           SELECT $1, id, 'scan_qr', 'Entrance', 10, 1 FROM category WHERE event_id = $1 LIMIT 1 RETURNING id`,
          [event],
        );
        const scan = f.asPlayerStatement(
          player,
          "SELECT * FROM complete_quest($1, 'qr', 1, NULL, $2, NULL)",
          [quest?.id, randomUUID()],
        );
        const crossed = daily ? await f.held(last, scan) : await f.held(scan, last);
        expect(crossed.second).not.toBeInstanceOf(Error);
        expect(await f.streakDays(player)).toEqual([await f.today()]);
        expect(await f.xpOf(player)).toBe(150);
        expect(await f.xpHolds(player)).toBe(true);
      }
    });

    it("questify_sync and gem_buy, both orders", async () => {
      for (const other of [
        "SELECT questify_sync() AS r",
        "SELECT gem_buy('shop-map-reader', 40, gen_random_uuid()) AS r",
      ]) {
        for (const dailyFirst of [true, false]) {
          const { player, last } = await ready();
          await f.owner("UPDATE player_xp SET gems = 100 WHERE player_id = $1", [player]);
          const statement = f.asPlayerStatement(player, other, []);
          const crossed = dailyFirst
            ? await f.held(last, statement)
            : await f.held(statement, last);
          expect(crossed.second).toHaveProperty("r");
          expect(await f.xpOf(player)).toBe(50);
          expect(await f.xpHolds(player)).toBe(true);
        }
      }
    });

    it("erase_player, both orders: no deadlock, and nothing is written once the erasure commits", async () => {
      for (const dailyFirst of [true, false]) {
        const { player, last, challenge, picked } = await ready();
        const token = await f.deletionToken(player);
        const erase = {
          context: {},
          sql: "SELECT * FROM erase_player($1, true, $2)",
          values: [token, randomUUID()],
        };
        const crossed = dailyFirst ? await f.held(last, erase) : await f.held(erase, last);
        expect(crossed.waited).toBe(true);
        if (dailyFirst) {
          expect((crossed.second as { outcome: string }).outcome).toBe("erased");
          expect(await count("daily_finish WHERE player_id = $1", [player])).toBe(1);
        } else {
          expect((crossed.second as { code?: string }).code).toBe("PI401");
          expect(await count("daily_finish WHERE player_id = $1", [player])).toBe(0);
        }
        expect(await refusal(answer(player, challenge.id, picked[2] ?? "", 3, 2))).toBe("PI401");
      }
    });
  });
});
