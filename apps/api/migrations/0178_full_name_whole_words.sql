-- A full name is checked by Dhia's rule (2026-11-08, Q-754; ADR-817): a bad word with one or two letters added is
-- still the same bad word, but with many more letters around it, it may be a good word that just holds those letters.
-- Under 0177 a `part` entry matched anywhere inside a word, so real names were refused (Siriporn, Shittu, «کسمایی»)
-- unless the allow-list held them, and a `word` entry matched only the bare word, so «القحبة», «زبك», "dickk" passed.
-- Now a word of the folded name is refused when, with one known prefix and one known ending taken off (they do not
-- count), it holds an entry with few letters left over:
--   * a `part` entry of 4 letters or more: at most 2 (fuckme, xfuckx; not fuckali, pornstar, dumbfuck);
--   * an entry of 3 letters or more otherwise (a 3-letter `part`, any `word` entry): at most 1 (معرص, sexx, dickk);
--   * an entry of 1 or 2 letters: none, the form is the entry («كسك», «زبه»; not «كساب»).
-- Known prefixes, before an Arabic word: و or ف, then ب ك or ل, then ال; يا; ابن or بنت, with ال. Known endings: Arabic
-- ات ين ون, a pronoun ك كم ها هم ي (ة read as ت before one), the nisba ي يه ه (folded: ة reads ه, ية reads يه); Latin
-- s es er ers ed ing ings y ies (ies read as y). The thresholds were chosen on the corpus (`test/db/full-name-corpus.ts`):
-- the only setting tried with no abusive name passing and the fewest real names refused (ADR-817 has the table).
-- Letters spelled out one by one ("ش ر م و ط ة") are joined into one word first. Usernames keep their rule
-- (`username_blocked`, unchanged).
-- Restated with the same signature, owner and grants (none), diffed against 0177: `full_name_blocked` only. The folding
-- (`full_name_fold`), the answer trigger, the sweep and the reads are unchanged. Five compounds (fuckface, fuckhead,
-- fuckwit, shithead, shitface) join `username_word` as `part` entries; each holds fuck or shit, so no username changes.
-- The allow-list keeps the real names the rule still refuses (Nasser, Tito, «خولة», «لحسن», ...) and drops 0177's names
-- that now pass without it (Yamashita, Harshit, Pornchai, ...). «Kike» stays.
-- The rule changes for stored names, so this file marks the recheck pending (docs/rules.md); the lifecycle tick sweeps
-- the stored answers again (about 26 minutes at 100,000 answers when a page takes over the tick's 2 s, as measured at
-- load 5: one page a run; ADR-817). Until the sweep reaches it, a stored name shows as 0177 flagged it.
-- Nothing here writes points or XP, changes a sign-in, a tenant rule or a redemption. 0177 and earlier untouched.

SET LOCAL lock_timeout = '10s';

-- ================================================================ the check
-- The word-list half of `username_blocked`, word by word of the folded name (a list word never matches across a space):
-- a run of single letters is joined into one word first; a word of `full_name_allow` is skipped whole (an Arabic entry
-- also covers the word with a prefix or the nisba). Each word gives its forms: the word, one known prefix and one known
-- ending taken off (each optional; an Arabic ending read as ة when it starts with ت or is ات; a Latin ies read as y),
-- a Latin word also with its digits removed or read as letters (0 o, 1 i, 3 e, 4 a, 5 s, 7 t) and in its pieces between
-- digits. A form is refused when it holds an entry of either kind with few letters left over: at most 2 for a `part`
-- entry of 4 letters or more, 1 for any other entry of 3 or more, none for one of 1 or 2 (the form is the entry).
-- PL/pgSQL with no SET clause (its callers are definers and the answer trigger, and it runs per row in the recheck;
-- docs/rules.md): two list reads, each one plan kept per connection. At the lists' size (about 60 allow words, 400
-- entries) each read is one sequential scan of its table; a substring test could use no index anyway. The name is
-- folded once, never once per list row.
CREATE OR REPLACE FUNCTION full_name_blocked(name text) RETURNS boolean
  LANGUAGE plpgsql STABLE AS $$
DECLARE
  folded    text[] := string_to_array(full_name_fold(name), ' ');
  -- Before an Arabic word: و or ف, then ب ك or ل, then ال (ل with ال is written لل); or يا; or ابن or بنت, with ال.
  prefixes  text[] := '{"",و,ف,ب,ك,ل,وب,وك,ول,فب,فك,فل,ال,وال,فال,بال,كال,لل,وبال,وكال,ولل,فبال,فكال,فلل,'
                      'يا,ابن,ابنال,بنت,بنتال,يابن,يابنال}';
  -- After it: a plural, a pronoun (ة read as ت before one) or the nisba (folded: ة reads ه, ية reads يه).
  endings   text[] := '{"",ات,ين,ون,ك,كم,ها,هم,تك,تكم,تها,تهم,تي,ي,يه,ه}';
  latin_end text[] := '{"",s,es,er,ers,ed,ing,ings,y,ies}';
  words     text[] := '{}';
  forms     text[] := '{}';
  found     text[];
  named     text[];
  allow_all text[];
  allow_ar  text[];
  piece     text;
  bare      text;
  form      text;
  rest      text;
  stem      text;
  p         text;
  e         text;
  spelled   text := '';
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
    found := '{}';
    named := '{}';
    IF bare ~ '[ء-ي]' THEN
      -- An Arabic word: every stem left by one prefix and one ending, of two letters or more.
      FOREACH form IN ARRAY bare || regexp_split_to_array(piece, '[0-9]+') LOOP
        FOREACH p IN ARRAY prefixes LOOP
          CONTINUE WHEN NOT starts_with(form, p);
          rest := substr(form, char_length(p) + 1);
          FOREACH e IN ARRAY endings LOOP
            CONTINUE WHEN char_length(rest) - char_length(e) < 2 OR right(rest, char_length(e)) <> e;
            stem := left(rest, char_length(rest) - char_length(e));
            found := found || stem;
            -- A name of the allow-list covers its prefix and nisba forms only: «الخولات» is not «خولة».
            IF e IN ('', 'ي', 'يه', 'ه') THEN
              named := named || stem;
            END IF;
            -- ة becomes ت before a pronoun or ات: «شرموطتك», «قحبات» are the stem with ه.
            IF e = 'ات' OR e LIKE 'ت%' THEN
              found := found || (stem || 'ه');
            END IF;
          END LOOP;
        END LOOP;
      END LOOP;
      CONTINUE WHEN named && allow_ar;
    ELSE
      -- A Latin word: with its digits removed or read as letters, and its pieces between digits, each with one ending.
      FOREACH form IN ARRAY ARRAY[bare, regexp_replace(translate(piece, '013457', 'oieast'), '[0-9]', '', 'g')]
                            || regexp_split_to_array(piece, '[0-9]+') LOOP
        FOREACH e IN ARRAY latin_end LOOP
          CONTINUE WHEN char_length(form) - char_length(e) < 2 OR right(form, char_length(e)) <> e;
          stem := left(form, char_length(form) - char_length(e));
          found := found || stem;
          IF e = 'ies' THEN
            found := found || (stem || 'y');
          END IF;
        END LOOP;
      END LOOP;
    END IF;
    forms := forms || found;
  END LOOP;
  -- The letters a form holds beyond the entry, against the entry's budget.
  SELECT EXISTS (
    SELECT 1 FROM username_word u, unnest(forms) f
    WHERE position(u.word IN f) > 0
      AND char_length(f) - char_length(u.word)
          <= CASE WHEN char_length(u.word) >= 4 AND u.match = 'part' THEN 2 WHEN char_length(u.word) >= 3 THEN 1 ELSE 0 END)
  INTO hit;
  RETURN hit;
END $$;
REVOKE ALL ON FUNCTION full_name_blocked(text) FROM PUBLIC;

-- ================================================================ common compounds
-- A compound insult holds its entry with more letters around it than the entry's budget ("fuckface Ali", "Mr Shithead"
-- would pass). The commonest are `part` entries of their own, so they are refused with their endings. Each holds a
-- `part` entry already (fuck, shit), so no username's answer changes.
INSERT INTO username_word (word, match, language) VALUES
  ('fuckface', 'part', 'en'), ('fuckhead', 'part', 'en'), ('fuckwit', 'part', 'en'), ('shithead', 'part', 'en'),
  ('shitface', 'part', 'en')
ON CONFLICT (word) DO NOTHING;

-- ================================================================ the allow-list
-- The real names of the corpus (`test/db/full-name-corpus.ts`) that the rule above still refuses: each holds an entry
-- with few letters around it (Nasser, Tito, Shittu, «لحسن», «خولة», «الزبير»). An Arabic word covers its prefix and
-- nisba forms («اسحاق» covers «الإسحاقي» and «باسحاق», «خوله» never «الخولات»). The 0177 entries whose names hold their entry with more
-- letters around it than its budget (Yamashita, Harshit, Pornchai, Lipshitz, ...) pass without one and are removed;
-- the corpus proves each (`full-name-filter.int.test.ts`). «Kike» stays (Q-754 (2)). The list's statement trigger marks
-- the sweep as well; the explicit mark below is the rule's own (docs/rules.md).
DELETE FROM full_name_allow
WHERE word IN ('akshita', 'dikshit', 'harshit', 'harshita', 'kinoshita', 'kshitij', 'lipshitz', 'matsushita',
               'morishita', 'nishita', 'pornchai', 'pornpan', 'pornpimol', 'pornsak', 'pornthip', 'rishita', 'shitaya',
               'takeshita', 'toshitaka', 'wankhede', 'yamashita', 'yoshitaka', 'yoshito', 'yoshitomo');
INSERT INTO full_name_allow (word, language) VALUES
  ('البزاز', 'ar'), ('البزي', 'ar'), ('خوله', 'ar'), ('خولي', 'ar'), ('زبيد', 'ar'), ('زبيب', 'ar'), ('زبير', 'ar'),
  ('شاذلي', 'ar'), ('شرجبي', 'ar'), ('لحسن', 'ar'),
  ('nishit', 'en'), ('shittu', 'en'), ('skeete', 'en'), ('skeeter', 'en'), ('bastardi', 'en'),
  ('swank', 'en'), ('vecchi', 'en'), ('vecchio', 'en'), ('nasser', 'en'), ('yasser', 'en'), ('gasser', 'en'),
  ('jasser', 'en'), ('butti', 'en'), ('butts', 'en'), ('mongi', 'en'), ('monge', 'en'), ('tito', 'en'), ('titus', 'en'),
  ('dicko', 'en'), ('dickey', 'en'), ('cass', 'en'), ('bass', 'en'), ('janus', 'en'), ('cocker', 'en'),
  ('cummings', 'en'), ('cooney', 'en'), ('negron', 'en'), ('spicer', 'en'), ('smutny', 'en'), ('bonera', 'en')
ON CONFLICT (word) DO NOTHING;

-- ================================================================ the recheck
UPDATE full_name_recheck SET pending = true, after_enrollment = NULL, after_field = NULL, changed_at = now();
