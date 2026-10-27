// Builds the daily word guess lists (T-406d) from the downloaded sources recorded in docs/THIRD_PARTY.md.
// Each output is one normalized five-letter word per line, sorted, ready for the console's guess-list import.
//   node scripts/build-word-lists.mjs en <scowl-wordlist.txt> <scowl-pre.txt> <ldnoobw-en.txt> <out.txt>
//   node scripts/build-word-lists.mjs ar <latest-lexemes.json.gz> <ldnoobw-ar.txt> <out.txt>
// Sources are read as text only; nothing from them is run. Node 22.18 or later strips the types of letters.ts.
import { createReadStream, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { createGunzip } from "node:zlib";

const LETTERS = resolve(import.meta.dirname, "../packages/shared/src/daily/letters.ts");
const { foldWord, normalizeWord } = await import(pathToFileURL(LETTERS).href);

// Words the sources do not flag but a family-friendly game keeps out of its guesses (slurs, explicit terms).
const SUPPLEMENTAL_BLOCK = {
  en: [
    "arses",
    "bints",
    "chink",
    "dagos",
    "darky",
    "dykes",
    "faggy",
    "fagot",
    "gippo",
    "gooks",
    "gyppo",
    "homos",
    "honky",
    "jewed",
    "kafir",
    "kikes",
    "lesbo",
    "mongs",
    "nancy",
    "nazis",
    "nudes",
    "nudie",
    "pimps",
    "poofs",
    "poofy",
    "prick",
    "raped",
    "rapes",
    "shags",
    "sissy",
    "slags",
    "sluts",
    "spazz",
    "spics",
    "twats",
    "wacko",
    "wanks",
    "whore",
  ],
  ar: [
    "عاهرة",
    "زانية",
    "داعرة",
    "فاجرة",
    "قوادة",
    "عرصان",
    "شرموط",
    "منيوك",
    "منيكة",
    "متناك",
    "لواطي",
    "سحاقي",
    "نيكتا",
    "نيكوا",
    "ينيكا",
    "تنيكا",
    "تنيكي",
    "البظر",
    "بظران",
  ],
};

const OFFENSIVE_NOTE = /\((?:offensive|vulgar)-\d\)/;
// Strings no Arabic word has: a letter three times running, two hamza letters together, two alefs together.
// They come from the generated verb forms of a few odd lexemes.
const IMPLAUSIBLE_ARABIC = /(.)\1\1|[ؤئء]{2}|اا/u;
const ARABIC_LEXEME = '"language":"Q13955"';
const ARABIC_LANGUAGE_ITEM = "Q13955";
const PROPER_NOUN_ITEM = "Q147276";
// Wikidata items: noun and adjective, the lexical categories that take the definite article.
const ARTICLE_CATEGORIES = new Set(["Q1084", "Q34698"]);
const DEFINITE_ARTICLE = "ال";

const readLines = (path) => readFileSync(path, "utf8").split(/\r?\n/);

/** Every word on a line of the English Speller Database that is marked offensive or vulgar. */
function flaggedWords(scowlPrePath) {
  const flagged = new Set();
  for (const line of readLines(scowlPrePath).filter((text) => OFFENSIVE_NOTE.test(text))) {
    const entries = line.split("#")[0].split(": ").slice(1).join(": ");
    for (const token of entries.match(/[A-Za-z]+/g) ?? []) {
      flagged.add(token.toLowerCase());
    }
  }
  return flagged;
}

/** The five-letter words a list of lines holds once normalized, without the lines that fold to nothing. */
const normalizedWords = (language, lines) =>
  lines.map((line) => normalizeWord(language, line)).filter((word) => word !== null);

function buildEnglish([wordlistPath, scowlPrePath, ldnoobwPath]) {
  const blocked = new Set([
    ...flaggedWords(scowlPrePath),
    ...normalizedWords("en", readLines(ldnoobwPath)),
    ...SUPPLEMENTAL_BLOCK.en,
  ]);
  const words = new Set();
  for (const line of readLines(wordlistPath)) {
    const word = normalizeWord("en", line);
    // Only the lower-case spelling counts: a name or an abbreviation is listed with a capital.
    if (word === line && !blocked.has(word)) {
      words.add(word);
    }
  }
  return words;
}

/** The Arabic spellings (lemmas and forms) of one lexeme of the Wikidata dump. */
function arabicSpellings(lexeme) {
  const forms = (lexeme.forms ?? []).flatMap((form) => Object.values(form.representations ?? {}));
  return [...Object.values(lexeme.lemmas ?? {}), ...forms]
    .filter((spelling) => spelling.language === "ar")
    .map((spelling) => spelling.value);
}

/** The spellings of a noun or adjective with the definite article, for the ones that are three letters long. */
function articleForms(lexeme) {
  if (!ARTICLE_CATEGORIES.has(lexeme.lexicalCategory)) {
    return [];
  }
  return arabicSpellings(lexeme)
    .filter((spelling) => [...foldWord("ar", spelling)].length === 3)
    .map((spelling) => `${DEFINITE_ARTICLE}${spelling}`);
}

async function buildArabic([dumpPath, ldnoobwPath]) {
  const blocked = new Set([
    ...normalizedWords("ar", readLines(ldnoobwPath)),
    ...normalizedWords("ar", SUPPLEMENTAL_BLOCK.ar),
  ]);
  const words = new Set();
  const names = new Set();
  const lines = createInterface({ input: createReadStream(dumpPath).pipe(createGunzip()) });
  for await (const line of lines) {
    if (!line.includes(ARABIC_LEXEME)) {
      continue;
    }
    const lexeme = JSON.parse(line.replace(/,$/, ""));
    if (lexeme.language !== ARABIC_LANGUAGE_ITEM) {
      continue;
    }
    if (lexeme.lexicalCategory === PROPER_NOUN_ITEM) {
      normalizedWords("ar", arabicSpellings(lexeme)).forEach((name) => names.add(name));
      continue;
    }
    const spellings = [...arabicSpellings(lexeme), ...articleForms(lexeme)];
    for (const word of normalizedWords("ar", spellings)) {
      if (!blocked.has(word) && !IMPLAUSIBLE_ARABIC.test(word)) {
        words.add(word);
      }
    }
  }
  // A spelling filed as a proper noun on any lexeme is a name, even when another lexeme spells a common word the same.
  return new Set([...words].filter((word) => !names.has(word)));
}

const [language, ...paths] = process.argv.slice(2);
const output = paths.pop();
const built = language === "en" ? buildEnglish(paths) : await buildArabic(paths);
writeFileSync(output, `${[...built].toSorted().join("\n")}\n`, "utf8");
process.stdout.write(`${language}: ${built.size} words\n`);
