import { ABUSIVE_NAMES, ACCEPTED_PASSES, REAL_NAMES } from "#test/db/full-name-corpus";

/**
 * 0118's `username_blocked`, as `old_username_blocked`: the version 0179 restated (FOLLOWUPS batch 24). Kept here so a
 * test can compare the two answers name by name, and the timing can measure both on one database.
 */
export const OLD_USERNAME_BLOCKED = `
CREATE OR REPLACE FUNCTION old_username_blocked(name text) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  WITH folded AS (SELECT username_fold(name) AS v),
  forms AS (
    SELECT regexp_split_to_array(v, '[_0-9]+') AS tokens,
           regexp_replace(v, '[_0-9]', '', 'g') AS bare,
           regexp_replace(translate(v, '013457', 'oieast'), '[_0-9]', '', 'g') AS mapped
    FROM folded)
  SELECT EXISTS (
    SELECT 1 FROM username_word w, forms
    WHERE (w.match = 'word' AND w.word = ANY (forms.tokens))
       OR (w.match = 'part' AND (position(w.word IN forms.bare) > 0 OR position(w.word IN forms.mapped) > 0)))
    OR EXISTS (SELECT 1 FROM username_retired r, folded WHERE r.fold = folded.v)
$$;`;

/** The usernames the username, word-list and full-name tests name, refused or not. */
const TEST_NAMES = [
  "ass_king",
  "ass",
  "x_ass_7",
  "megafucker",
  "f_u_c_k_it",
  "pornstar_1",
  "class_act",
  "bass_player",
  "Sussex_fan",
  "therapist_1",
  "basement_9",
  "gc_fan",
  "shota_k",
  "sh1t_storm",
  "5hit",
  "b1tch_99",
  "user_2024",
  "b00k_worm",
  "falcon_7",
  "شرموطة",
  "شرموطه_1",
  "شرموط",
  "كس_123",
  "سكسي",
  "كسمك",
  "زبي",
  "كسب",
  "خولة",
  "فرج_الله",
  "نيكول",
  "jackass",
  "dumbass_7",
  "the_dickhead",
  "كسامك",
  "كسأمك",
  "jackassery",
  "dumbasses",
  "smartass",
  "ساره",
  "سارة",
  "nora",
  "Nora",
  "NORA",
  "nora_1",
  "qxbad",
  "qxbad_1",
  "aqxbad",
  "qxz",
  "aqxza",
  "خبيث",
  "الخبيثة",
  "",
  "_",
  "123",
  "___",
  "0",
];

/** Digit spellings the check reads as letters, the other way round. */
const DIGITS: readonly (readonly [string, string])[] = [
  ["o", "0"],
  ["i", "1"],
  ["e", "3"],
  ["a", "4"],
  ["s", "5"],
  ["t", "7"],
];
/** Letters `username_fold` folds, the other way round: each name is also tried with its unfolded letters. */
const UNFOLD: readonly (readonly [string, string])[] = [
  ["ا", "أ"],
  ["ا", "إ"],
  ["ا", "آ"],
  ["ه", "ة"],
  ["ي", "ى"],
];

/** A small seeded generator, so a failure names the same names on every run. */
const seeded = (start: number) => {
  let state = start;
  return (below: number) => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state % below;
  };
};

/** The look-alikes of one word: digits, cases, separators, letters around it, and Arabic letters before folding. */
const lookAlikes = (word: string): string[] => {
  const forms = [
    word,
    word.toUpperCase(),
    `${word.charAt(0).toUpperCase()}${word.slice(1)}`,
    `${word}_7`,
    `x_${word}`,
    `ab${word}cd`,
    `${word}s`,
    `${word}${word}`,
    word.split("").join("_"),
    `${word.slice(0, 1)}_${word.slice(1)}`,
    `${word.slice(0, -1)}`,
    `${word}9${word.slice(0, 2)}`,
  ];
  for (const [letter, digit] of DIGITS) {
    if (word.includes(letter)) {
      forms.push(word.replaceAll(letter, digit), `${word.replace(letter, digit)}_x`);
    }
  }
  for (const [folded, raw] of UNFOLD) {
    if (word.includes(folded)) {
      forms.push(word.replaceAll(folded, raw));
    }
  }
  return forms;
};

/** The corpus names as a username would carry them: as written, joined by _, and joined. */
const asUsernames = (name: string): string[] => [
  name,
  name.replaceAll(" ", "_"),
  name.replaceAll(" ", ""),
  name.toLowerCase().replaceAll(/[^a-z0-9ء-ي]+/gu, "_"),
];

/** Random usernames from pieces of list words, real names and plain letters, digits and _. */
const randomNames = (words: readonly string[], count: number): string[] => {
  const next = seeded(20_261_108);
  const letters = "abcdefghijklmnopqrstuvwxyz0123456789_ابتثجحخدذرزسشصضطظعغفقكلمنهوي";
  const pieces = [...words, ...REAL_NAMES.flatMap((name) => name.toLowerCase().split(" "))];
  const names: string[] = [];
  for (let n = 0; n < count; n += 1) {
    let name = "";
    const parts = 1 + next(3);
    for (let part = 0; part < parts; part += 1) {
      if (next(2) === 0) {
        name += pieces[next(pieces.length)] ?? "";
      } else {
        const size = 1 + next(6);
        for (let k = 0; k < size; k += 1) {
          name += letters.charAt(next(letters.length));
        }
      }
    }
    names.push(name.slice(0, 30));
  }
  return names;
};

/** Every list word's look-alikes, every corpus and test name, and random names, each once. */
export const comparedNames = (words: readonly string[], randomCount: number): string[] => [
  ...new Set([
    ...TEST_NAMES,
    ...words.flatMap(lookAlikes),
    ...[...REAL_NAMES, ...ABUSIVE_NAMES, ...ACCEPTED_PASSES].flatMap(asUsernames),
    ...randomNames(words, randomCount),
  ]),
];
