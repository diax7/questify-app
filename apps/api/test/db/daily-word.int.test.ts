import { randomInt } from "node:crypto";
import { DAILY_LETTERS } from "@questify/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dailyFixture, refusal, type DailyFixture } from "#test/support/daily";
import { TEST_DATABASE_URL } from "#test/support/test-db";

type Reply = {
  guess: { attempt: number; guess: string; marks: string };
  finished: { solved: boolean; attempts: number; xp: number; word: string } | null;
  levelUp: { level: number } | null;
  dailyStreak: { days: number; today: boolean } | null;
  replayed: boolean;
};
type WordGame = {
  period: { startsOn: string; endsOn: string };
  length: number;
  languages: string[];
  words: { language: string; id: number }[];
  play: {
    language: string;
    wordId: number;
    guesses: { guess: string; marks: string }[];
    finished: Reply["finished"];
  } | null;
};

/** The two-pass marking rule, written independently of the SQL one. */
function reference(word: string, guess: string): string {
  const w = [...word];
  const g = [...guess];
  const marks = g.map((letter, i) => (letter === w[i] ? "2" : "0"));
  const spare = w.filter((letter, i) => letter !== g[i]);
  return marks
    .map((mark, i) => {
      if (mark === "2") return mark;
      const at = spare.indexOf(g[i] ?? "");
      if (at === -1) return "0";
      spare.splice(at, 1);
      return "1";
    })
    .join("");
}

/** Five letters drawn from `letters`, with repeats. */
const pick = (letters: string) =>
  Array.from({ length: 5 }, () => letters[randomInt(letters.length)]).join("");

const ENGLISH = [
  "adieu",
  "stomp",
  "light",
  "brick",
  "fudge",
  "crane",
  "slate",
  "eerie",
  "geese",
  "speed",
];
const ARABIC = ["كتابة", "مدرسة", "سلامة", "قلمان", "بحيرة"];

/**
 * The daily word in the database (T-406, migration 0069, FR-1810, ADR-310): five letters, the Arabic folding, list-only
 * guesses that use no attempt when refused, two-pass marks, one game a period in one language, 50 XP when solved and
 * none when not, the word only at the end, and its replacement caught by its id.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("the daily word (database)", () => {
  let f: DailyFixture;
  beforeAll(async () => {
    f = await dailyFixture();
    await f.listWords("en", ENGLISH);
    await f.listWords("ar", ARABIC);
  });
  afterAll(async () => {
    await f.close();
  });

  const guess = (player: string, word: number, attempt: number, text: string) =>
    f.guess(player, word, attempt, text) as Promise<Reply>;
  const own = async (player: string) => (await f.own(player))?.word as WordGame | null;
  const count = async (sql: string, values: unknown[] = []) =>
    Number((await f.owner<{ n: string }>(`SELECT count(*) AS n FROM ${sql}`, values))[0]?.n);
  let spare = 0;
  /** A fresh word not used before in `language` (the guess list gets it too). */
  const fresh = (language: "ar" | "en") => {
    spare += 1;
    const letters = language === "en" ? "bcdfghjklmnpqrstvwxz" : "بتثجحخدذرزسشصضطظعغفقكلمنهوي";
    const chars = [...letters];
    return Array.from({ length: 5 }, (_, i) => chars[(spare * 11 + i * 3) % chars.length]).join("");
  };
  const wordToday = async (words: Partial<Record<"ar" | "en", string>>) => {
    const day = await f.freshSunday();
    const ids: Partial<Record<"ar" | "en", number>> = {};
    for (const [language, word] of Object.entries(words) as ["ar" | "en", string][]) {
      ids[language] = (await f.setWord(language, day, word)).id;
    }
    await f.goTo(day);
    return { day, ids };
  };

  it("pays 50 XP when solved, with the word as written, and keeps the streak (FR-1810)", async () => {
    const word = fresh("en");
    const { ids } = await wordToday({ en: word });
    const player = await f.newPlayer();
    for (const [n, text] of ["adieu", "stomp", "light"].entries()) {
      const reply = await guess(player, ids.en ?? 0, n + 1, text);
      expect(reply.finished).toBeNull();
      expect(JSON.stringify(reply)).not.toContain(word);
    }
    const solved = await guess(player, ids.en ?? 0, 4, word.toUpperCase());
    expect(solved.guess).toEqual({ attempt: 4, guess: word, marks: "22222" });
    expect(solved.finished).toEqual({ solved: true, attempts: 4, xp: 50, word });
    expect(await f.xpOf(player)).toBe(50);
    expect(await f.xpHolds(player)).toBe(true);
    expect(await f.streakDays(player)).toEqual([await f.today()]);
    expect(await refusal(guess(player, ids.en ?? 0, 5, "adieu"))).toBe("DW409:finished");
  });

  it("reveals the word after six misses with no XP and no XP entry, and still keeps the streak", async () => {
    const word = fresh("en");
    const { ids } = await wordToday({ en: word });
    const player = await f.newPlayer();
    let last: Reply | undefined;
    for (const [n, text] of ["adieu", "stomp", "light", "brick", "fudge", "crane"].entries()) {
      last = await guess(player, ids.en ?? 0, n + 1, text);
    }
    expect(last?.finished).toEqual({ solved: false, attempts: 6, xp: 0, word });
    expect(await count("xp_entry WHERE player_id = $1", [player])).toBe(0);
    expect(await f.streakDays(player)).toEqual([await f.today()]);
    expect((await own(player))?.play?.finished).toEqual({
      solved: false,
      attempts: 6,
      xp: 0,
      word,
    });
  });

  it("marks duplicate letters right, in both languages, and agrees with a reference on 500 random pairs", async () => {
    const table: [string, string, string][] = [
      ["crane", "eerie", "00102"],
      ["eerie", "geese", "02102"],
      ["speed", "eerie", "11000"],
      ["abbey", "babes", "11220"],
      ["llama", "level", "20001"],
      ["سلامة", "سلسلة", "22002"],
      ["مدرسة", "سمسمة", "11002"],
    ];
    for (const [word, attempt, marks] of table) {
      const [row] = await f.owner<{ m: string }>("SELECT daily_marks($1, $2) AS m", [
        word,
        attempt,
      ]);
      expect(row?.m, `${word} ${attempt}`).toBe(marks);
    }
    const words: string[] = [];
    const guesses: string[] = [];
    for (let i = 0; i < 500; i += 1) {
      const letters = i % 2 === 0 ? "abcde" : "ابتثج";
      words.push(pick(letters));
      guesses.push(pick(letters));
    }
    const rows = await f.owner<{ m: string }>(
      "SELECT daily_marks(w, g) AS m FROM unnest($1::text[], $2::text[]) WITH ORDINALITY t (w, g, n) ORDER BY n",
      [words, guesses],
    );
    expect(rows.map((row) => row.m)).toEqual(words.map((w, i) => reference(w, guesses[i] ?? "")));
  });

  it("uses no attempt for a guess of the wrong length, other letters or not in the list", async () => {
    const word = fresh("en");
    const { ids } = await wordToday({ en: word });
    const player = await f.newPlayer();
    expect(await refusal(guess(player, ids.en ?? 0, 1, "abcd"))).toBe("DW422:length");
    expect(await refusal(guess(player, ids.en ?? 0, 1, "abcdef"))).toBe("DW422:length");
    expect(await refusal(guess(player, ids.en ?? 0, 1, "ab1de"))).toBe("DW422:letters");
    expect(await refusal(guess(player, ids.en ?? 0, 1, "كتابة"))).toBe("DW422:letters");
    expect(await refusal(guess(player, ids.en ?? 0, 1, "zzzzz"))).toBe("DW422:not_a_word");
    expect(await count("daily_play WHERE player_id = $1", [player])).toBe(0);
    expect((await guess(player, ids.en ?? 0, 1, " Adieu ")).guess.attempt).toBe(1);
    expect(await refusal(guess(player, ids.en ?? 0, 3, "stomp"))).toBe("DW409:out_of_order");
    expect(await refusal(guess(player, ids.en ?? 0, 7, "stomp"))).toBe("DW422:attempt");
  });

  it("always accepts the period's own word, even once it is removed from the list", async () => {
    const word = fresh("en");
    const { ids } = await wordToday({ en: word });
    expect((await f.listWords("en", [], [word])).removed).toBe(1);
    const player = await f.newPlayer();
    expect((await guess(player, ids.en ?? 0, 1, word)).finished?.solved).toBe(true);
  });

  it("folds Arabic input: أ إ آ ٱ to ا, diacritics and the tatweel dropped; the reveal keeps the hamza", async () => {
    const day = await f.freshSunday();
    const made = await f.setWord("ar", day, "أَمـانة");
    expect(made.word).toBe("أمانة");
    const [stored] = await f.owner<{ word: string; display: string }>(
      "SELECT word, display FROM daily_word WHERE id = $1",
      [made.id],
    );
    expect(stored).toEqual({ word: "امانة", display: "أمانة" });
    await f.goTo(day);
    const player = await f.newPlayer();
    const solved = await guess(player, made.id, 1, "إمانـة");
    expect(solved.guess).toEqual({ attempt: 1, guess: "امانة", marks: "22222" });
    expect(solved.finished?.word).toBe("أمانة");
  });

  it("plays one game a period, in the language of the first guess", async () => {
    const { ids } = await wordToday({ en: fresh("en"), ar: fresh("ar") });
    const player = await f.newPlayer();
    const game = await own(player);
    expect(game?.languages).toEqual(["ar", "en"]);
    expect(game?.words.map((w) => w.language)).toEqual(["ar", "en"]);
    expect(game?.length).toBe(5);
    await guess(player, ids.en ?? 0, 1, "adieu");
    expect(await refusal(guess(player, ids.ar ?? 0, 2, "كتابة"))).toBe("DW409:other_language");
    expect(await refusal(guess(player, ids.ar ?? 0, 1, "كتابة"))).toBe("DW409:other_language");
    expect((await own(player))?.play).toMatchObject({
      language: "en",
      guesses: [{ guess: "adieu" }],
    });
  });

  it("replays an attempt and the finishing one; another guess in a taken attempt names nothing", async () => {
    const word = fresh("en");
    const { ids } = await wordToday({ en: word });
    const player = await f.newPlayer();
    const first = await guess(player, ids.en ?? 0, 1, "adieu");
    expect(await guess(player, ids.en ?? 0, 1, "ADIEU")).toEqual({ ...first, replayed: true });
    const err = await f.guess(player, ids.en ?? 0, 1, "stomp").then(
      () => null,
      (e: { code: string; detail: string; message: string; hint?: string }) => e,
    );
    expect(err).toMatchObject({ code: "DW409", detail: "attempt_taken" });
    expect(`${err?.message}|${err?.hint ?? ""}`).not.toMatch(/adieu|stomp/);
    await guess(player, ids.en ?? 0, 2, word);
    const replay = await guess(player, ids.en ?? 0, 2, word);
    expect(replay).toMatchObject({
      finished: { solved: true, attempts: 2, xp: 50, word },
      levelUp: null,
      replayed: true,
    });
    expect(await f.xpOf(player)).toBe(50);
  });

  it("answers an unknown word id `changed` and a known word of another period `period_over`", async () => {
    const old = fresh("en");
    const day = await f.freshSunday();
    const first = await f.setWord("en", day, old);
    const replaced = await f.setWord("en", day, fresh("en"));
    expect(replaced.id).not.toBe(first.id);
    const later = await f.setWord("en", await f.plus(day, 7), fresh("en"));
    await f.goTo(day);
    const player = await f.newPlayer();
    expect(await refusal(guess(player, first.id, 1, "adieu"))).toBe("DW409:changed");
    expect(await refusal(guess(player, later.id, 1, "adieu"))).toBe("DW409:period_over");
    expect(await count("daily_play WHERE player_id = $1", [player])).toBe(0);
    expect((await own(player))?.words).toEqual([{ language: "en", id: replaced.id }]);
  });

  it("never shows an unfinished word in any read", async () => {
    const word = fresh("ar");
    const { ids } = await wordToday({ ar: word });
    const player = await f.newPlayer();
    await guess(player, ids.ar ?? 0, 1, "كتابة");
    const game = JSON.stringify(await f.own(player));
    expect(game).not.toContain(word);
    expect((await own(player))?.play?.finished).toBeNull();
  });

  it("holds the same 33 Arabic and 26 English letters as the shared keyboard", async () => {
    const [row] = await f.owner<{ ar: string; en: string }>(
      "SELECT daily_letters('ar') AS ar, daily_letters('en') AS en",
    );
    expect([...(row?.ar ?? "")]).toEqual([...DAILY_LETTERS.ar]);
    expect([...(row?.en ?? "")]).toEqual([...DAILY_LETTERS.en]);
    expect(DAILY_LETTERS.ar).toHaveLength(33);
    for (const folded of ["أ", "إ", "آ", "ٱ", "ـ"]) expect(DAILY_LETTERS.ar).not.toContain(folded);
  });

  it("pays at most 1000 XP for a solved word at the field's maximum, and falls back above it (MAJOR-3)", async () => {
    const word = fresh("en");
    const { ids } = await wordToday({ en: word });
    await f.xpSetting({ dailyWordXp: 1000 });
    try {
      const top = await f.newPlayer();
      expect((await guess(top, ids.en ?? 0, 1, word)).finished?.xp).toBe(1000);
      await f.xpSetting({ dailyWordXp: 1001 });
      const fallback = await f.newPlayer();
      expect((await guess(fallback, ids.en ?? 0, 1, word)).finished?.xp).toBe(50);
    } finally {
      await f.owner("UPDATE platform_setting SET value = value - 'dailyWordXp' WHERE key = 'xp'");
    }
  });

  it("refuses at once when its switch is off, and shows no game", async () => {
    const { ids } = await wordToday({ en: fresh("en") });
    const player = await f.newPlayer();
    await f.switchFeature("dailyWord", false);
    try {
      expect(await refusal(guess(player, ids.en ?? 0, 1, "adieu"))).toBe("DW404:unavailable");
      expect((await f.own(player))?.word).toBeNull();
    } finally {
      await f.switchFeature("dailyWord", true);
    }
  });

  it("keeps guesses append-only for every role", async () => {
    const { ids } = await wordToday({ en: fresh("en") });
    const player = await f.newPlayer();
    await guess(player, ids.en ?? 0, 1, "adieu");
    expect(await refusal(f.owner("UPDATE daily_guess SET marks = '22222'"))).toBe("42501");
    expect(await refusal(f.owner("DELETE FROM daily_guess"))).toBe("42501");
    expect(await refusal(f.owner("TRUNCATE daily_guess"))).toBe("42501");
  });
});
