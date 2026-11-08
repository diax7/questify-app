-- A full name matches the word lists by words (Dhia, 2026-11-08, Q-754; ADR-817), so that real names stop being refused
-- without letting abuse through. Under 0177 a `part` entry matched inside one word of a full name, and Arabic names that
-- hold one were refused («کسمایی», «بلوطي» but for the allow-list), as were Latin names the allow-list did not hold
-- (Siriporn, Shittu, Slutskaya, Skeete, Bastardi, Wankowicz). A first draft of this file matched whole words only, which a
-- review found let through the inflected and joined forms 0177 refused ("fucks", "fuckali", "sluts", «ياشرموطة»,
-- «الشرموطات», «القحبة»). Now, by the script of the entry:
--   * an Arabic entry matches an Arabic word with one prefix (و or ف, then ب ك or ل, then ال; or يا; or ابن / بنت with
--     or without ال) and one ending (ات ين ون, or a pronoun ك كم ها هم, with ة read as ت before a pronoun) taken off; a
--     `part` entry also with the nisba (ي يه ه; folded, ية reads يه and ة reads ه). Never inside a longer word: «کسمایی»
--     passes, «شرموطتك», «كسمك», «زبك», «الخول» are refused;
--   * a Latin `part` entry of 4 letters or more matches inside a word, as 0177 did, so every inflected or joined form is
--     refused (fucks, fuckers, fuckali, shitbag, dumbfuck, sluts, pornstar); a real name holding one passes as a whole
--     word of `full_name_allow` (Siriporn, Shittu); a shorter one matches the whole word or it plus s es er ers ed ing y;
--   * a Latin `word` entry matches a whole word split at digits, as before.
-- Letters spelled out one by one ("ش ر م و ط ة") are joined into one word, which then goes through every step above.
-- Usernames keep their stricter rule (`username_blocked`, unchanged).
-- Restated with the same signature, owner and grants (none), diffed against 0177: `full_name_blocked` only. The folding
-- (`full_name_fold`), the answer trigger, the sweep and the reads are unchanged. The allow-list gains the real names that
-- hold a Latin entry and that 0177 refused; «اسحاق» is dropped (the Arabic rule no longer matches inside it); its other
-- entries stay. The list of entries is not changed.
-- The rule changes for stored names with no list row touched, so this file marks the recheck pending (docs/rules.md);
-- the lifecycle tick sweeps the stored answers again (about 9 minutes at 100,000 answers). Until the sweep reaches it,
-- a stored name shows as 0177 flagged it.
-- Nothing here writes points or XP, changes a sign-in, a tenant rule or a redemption. 0177 and earlier untouched.

SET LOCAL lock_timeout = '10s';

-- ================================================================ the check
-- The word-list half of `username_blocked`, word by word of the folded name (a list word never matches across a space):
-- a run of single letters is joined into one word first; a word of `full_name_allow` is skipped whole (an Arabic entry
-- also covers the word's prefix, ending and nisba forms); then each word is matched as the header says, a Latin word also
-- with its digits removed or read as letters (0 o, 1 i, 3 e, 4 a, 5 s, 7 t) and in its pieces between digits.
-- PL/pgSQL with no SET clause (its callers are definers and the answer trigger, and it runs per row in the recheck;
-- docs/rules.md): two list reads, each one plan kept per connection. At the lists' size (about 60 allow words, 390
-- entries) each read is one sequential scan of its table, not an index look-up; the long Latin entries are a substring
-- test and could use no index anyway. The name is folded once, never once per list row.
CREATE OR REPLACE FUNCTION full_name_blocked(name text) RETURNS boolean
  LANGUAGE plpgsql STABLE AS $$
DECLARE
  folded    text[] := string_to_array(full_name_fold(name), ' ');
  -- Before an Arabic word: و or ف, then ب ك or ل, then ال (ل with ال is written لل); or يا; or ابن or بنت, with ال.
  prefixes  text[] := '{"",و,ف,ب,ك,ل,وب,وك,ول,فب,فك,فل,ال,وال,فال,بال,كال,لل,وبال,وكال,ولل,فبال,فكال,فلل,'
                      'يا,ابن,ابنال,بنت,بنتال,يابن,يابنال}';
  -- After it: a plural or a pronoun (ة read as ت before a pronoun) for every entry, then the nisba for a part entry.
  endings   text[] := '{"",ات,ين,ون,ك,كم,ها,هم,تك,تكم,تها,تهم,ي,يه,ه}';
  nisbas    text[] := '{ي,يه,ه}';
  latin_end text[] := '{s,es,er,ers,ed,ing,y}';
  words     text[] := '{}';
  allow_all text[];
  allow_ar  text[];
  tokens    text[] := '{}';
  parts     text[] := '{}';
  inside    text[] := '{}';
  forms_w   text[];
  forms_p   text[];
  pieces    text[];
  piece     text;
  bare      text;
  form      text;
  rest      text;
  stem      text;
  p         text;
  e         text;
  spelled   text := '';
  joined    text;
  hit       boolean;
BEGIN
  IF folded IS NULL OR folded = '{""}' THEN
    RETURN false;
  END IF;
  -- The words, letters spelled out one by one ("f u c k", "ك س") joined into one.
  FOREACH piece IN ARRAY folded || ''::text LOOP
    bare := regexp_replace(piece, '[0-9]', '', 'g');
    IF char_length(piece) = 1 AND bare <> '' THEN
      spelled := spelled || bare;
      CONTINUE;
    END IF;
    IF char_length(spelled) >= 2 THEN
      words := words || spelled;
    END IF;
    spelled := '';
    IF bare <> '' THEN
      words := words || piece;
    END IF;
  END LOOP;
  SELECT coalesce(array_agg(a.word), '{}'), coalesce(array_agg(a.word) FILTER (WHERE a.language = 'ar'), '{}')
  INTO allow_all, allow_ar
  FROM full_name_allow a;
  FOREACH piece IN ARRAY words LOOP
    bare := regexp_replace(piece, '[0-9]', '', 'g');
    CONTINUE WHEN bare = ANY (allow_all);
    pieces := regexp_split_to_array(piece, '[0-9]+');
    IF bare ~ '[ء-ي]' THEN
      -- An Arabic word: every stem left by one prefix and one ending (each optional), of two letters or more.
      forms_w := '{}';
      forms_p := '{}';
      FOREACH form IN ARRAY bare || pieces LOOP
        FOREACH p IN ARRAY prefixes LOOP
          CONTINUE WHEN NOT starts_with(form, p);
          rest := substr(form, char_length(p) + 1);
          FOREACH e IN ARRAY endings LOOP
            CONTINUE WHEN char_length(rest) - char_length(e) < 2 OR right(rest, char_length(e)) <> e;
            stem := left(rest, char_length(rest) - char_length(e));
            forms_p := forms_p || stem;
            -- ة becomes ت before a pronoun or ات: «شرموطتك», «قحبات» are the stem with ه.
            IF e = 'ات' OR e LIKE 'ت%' THEN
              forms_p := forms_p || (stem || 'ه');
            END IF;
            IF NOT e = ANY (nisbas) THEN
              forms_w := forms_w || stem;
              IF e = 'ات' OR e LIKE 'ت%' THEN
                forms_w := forms_w || (stem || 'ه');
              END IF;
            END IF;
          END LOOP;
        END LOOP;
      END LOOP;
      CONTINUE WHEN forms_p && allow_ar;
      tokens := tokens || forms_w;
      parts := parts || forms_p;
    ELSE
      -- A Latin word: its pieces between digits for a `word` entry; for a `part` entry the word with its digits removed
      -- or read as letters, inside (4 letters or more) or whole with one ending (shorter).
      tokens := tokens || pieces;
      FOREACH form IN ARRAY ARRAY[bare, regexp_replace(translate(piece, '013457', 'oieast'), '[0-9]', '', 'g')] LOOP
        inside := inside || form;
        parts := parts || form;
        FOREACH e IN ARRAY latin_end LOOP
          IF char_length(form) - char_length(e) >= 2 AND right(form, char_length(e)) = e THEN
            parts := parts || left(form, char_length(form) - char_length(e));
          END IF;
        END LOOP;
      END LOOP;
    END IF;
  END LOOP;
  -- One string for the long Latin entries: a list word holds no space, so a match never spans two forms.
  joined := array_to_string(inside, ' ');
  SELECT EXISTS (
    SELECT 1 FROM username_word u
    WHERE CASE WHEN u.match = 'word' THEN u.word = ANY (tokens)
               WHEN u.word ~ '^[a-z]{4,}$' THEN position(u.word IN joined) > 0
               ELSE u.word = ANY (parts) END)
  INTO hit;
  RETURN hit;
END $$;
REVOKE ALL ON FUNCTION full_name_blocked(text) FROM PUBLIC;

-- ================================================================ the allow-list
-- Real names that hold a Latin entry inside a word and that 0177 refused (Q-754's list, the corpus,
-- `test/db/full-name-corpus.ts`), and the Arabic forms the wider prefix and ending reach («بلوطي» was kept from 0177;
-- «البزاز» is the article form of the `word` entry «بزاز», a family name). «اسحاق» no longer holds a match (the Arabic
-- rule never matches inside a word) and is removed. The list's statement trigger marks the sweep as well; the explicit
-- mark below is the rule's own (docs/rules.md).
DELETE FROM full_name_allow WHERE word = 'اسحاق';
INSERT INTO full_name_allow (word, language) VALUES
  ('البزاز', 'ar'),
  ('siriporn', 'en'), ('chaiyaporn', 'en'), ('supaporn', 'en'), ('somporn', 'en'), ('kanokporn', 'en'),
  ('pornthep', 'en'), ('pornpimon', 'en'), ('jariyaporn', 'en'), ('sasiporn', 'en'),
  ('shittu', 'en'), ('shitole', 'en'), ('shitara', 'en'), ('slutskaya', 'en'), ('skeete', 'en'), ('skeeter', 'en'),
  ('bastardi', 'en'), ('wankowicz', 'en'), ('swank', 'en'), ('vecchio', 'en'), ('vecchi', 'en'), ('vecchione', 'en')
ON CONFLICT (word) DO NOTHING;

-- ================================================================ the recheck
UPDATE full_name_recheck SET pending = true, after_enrollment = NULL, after_field = NULL, changed_at = now();
