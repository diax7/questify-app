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
-- Letters spelled out one by one ("ش ر م و ط ة") are joined into one word first, and يا standing alone is read with
-- the word after it. Usernames keep their rule (`username_blocked`, unchanged).
-- Restated with the same signature, owner and grants (none), diffed against 0177: `full_name_blocked` only. The folding
-- (`full_name_fold`), the answer trigger, the sweep and the reads are unchanged. Common compounds join `username_word`:
-- five as `part` entries (fuckface, ...; each holds fuck or shit, so no username changes) and 18 as `word` entries
-- (jackass, dickhead, «كسامك», ...; a username changes only when a token is the compound itself).
-- The allow-list keeps the real names the rule still refuses (Nasser, Tito, «خولة», «لحسن», ...) and drops 0177's names
-- that now pass without it (Yamashita, Harshit, Pornchai, ...). «Kike» stays. An allow word is skipped only with no digit
-- in it ("dick5" is refused), and an Arabic one never covers يا before it («ياخولي» is refused).
-- The rule changes for stored names, so this file marks the recheck pending (docs/rules.md); the lifecycle tick sweeps
-- the stored answers again, in pages of 250 now (`RECHECK_PAGE`): 105 ms a page median, 138 ms the slowest, and 421 ms the
-- slowest with a 200-character name in every answer, so about 11 minutes at 100,000 answers (ADR-817). A list change
-- waits for the page in flight, so 0177's bound ("waiting for a tick page in flight: 2,000 answers, under 0.9 s") is now
-- one page of 250, under 0.5 s at the slowest name. Until the sweep reaches it, a stored name shows as 0177 flagged it.
-- Nothing here writes points or XP, changes a sign-in, a tenant rule or a redemption. 0177 and earlier untouched.

SET LOCAL lock_timeout = '10s';

-- ================================================================ the check
-- The word-list half of `username_blocked`, word by word of the folded name (a list word never matches across a space):
-- a run of single letters is joined into one word first, and a lone يا into the word after it; a word of
-- `full_name_allow` with no digit in it is skipped whole (an Arabic entry also covers the word with a prefix other than
-- يا, or with the nisba). Each word gives its forms: the word, one known prefix and one known
-- ending taken off (each optional; an Arabic ending read as ة when it starts with ت or is ات; a Latin ies read as y),
-- a Latin word also with its digits removed or read as letters (0 o, 1 i, 3 e, 4 a, 5 s, 7 t) and in its pieces between
-- digits. A form is refused when it holds an entry of either kind with few letters left over: at most 2 for a `part`
-- entry of 4 letters or more, 1 for any other entry of 3 or more, none for one of 1 or 2 (the form is the entry).
-- PL/pgSQL with no SET clause (its callers are definers and the answer trigger, and it runs per row in the recheck;
-- docs/rules.md): two list reads, each one plan kept per connection. The allow-list (about 80 words) is read once, one
-- sequential scan; the entries (about 420) are looked up by their unique key, 6 slices of each form (below), so a
-- 200-character name costs about 1.5 ms at the slowest, not one test of every form against every entry. The name is
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
  -- The words, letters spelled out one by one ("f u c k", "ك س") joined into one. يا standing alone is a call, never
  -- a name: it is read with the word after it («يا خولي» is «ياخولي»).
  FOREACH piece IN ARRAY folded || ''::text LOOP
    bare := regexp_replace(piece, '[0-9]', '', 'g');
    IF char_length(piece) = 1 AND bare <> '' THEN
      spelled := spelled || bare;
      CONTINUE;
    END IF;
    IF char_length(spelled) >= 2 THEN
      IF words[cardinality(words)] = 'يا' THEN
        words[cardinality(words)] := 'يا' || spelled;
      ELSE
        words := words || spelled;
      END IF;
    END IF;
    spelled := '';
    IF bare <> '' THEN
      IF words[cardinality(words)] = 'يا' THEN
        words[cardinality(words)] := 'يا' || piece;
      ELSE
        words := words || piece;
      END IF;
    END IF;
  END LOOP;
  SELECT coalesce(array_agg(a.word), '{}'), coalesce(array_agg(a.word) FILTER (WHERE a.language = 'ar'), '{}')
  INTO allow_all, allow_ar
  FROM full_name_allow a;
  FOREACH piece IN ARRAY words LOOP
    bare := regexp_replace(piece, '[0-9]', '', 'g');
    -- An allow word is skipped only with no digit in it: "dick5", "kike88" are not the names Dick and Kike.
    CONTINUE WHEN piece = bare AND bare = ANY (allow_all);
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
            -- A name of the allow-list covers its prefix and nisba forms only: «الخولات» is not «خولة», and يا before
            -- it is a call, not a name («ياخولي»).
            IF e IN ('', 'ي', 'يه', 'ه') AND NOT starts_with(p, 'يا') THEN
              named := named || stem;
            END IF;
            -- ة becomes ت before a pronoun or ات: «شرموطتك», «قحبات» are the stem with ه.
            IF e = 'ات' OR e LIKE 'ت%' THEN
              found := found || (stem || 'ه');
            END IF;
          END LOOP;
        END LOOP;
      END LOOP;
      CONTINUE WHEN piece = bare AND named && allow_ar;
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
  -- The letters a form holds beyond the entry, against the entry's budget. No budget is over 2 letters, so an entry a
  -- form holds is one of its 6 slices with 0, 1 or 2 letters (`cut`) taken from its ends (`head` of them from the start),
  -- each looked up by the entry's unique key: 6 probes a form, never every form against every entry.
  SELECT EXISTS (
    SELECT 1
    FROM unnest(forms) d(f)
    CROSS JOIN (VALUES (0, 0), (1, 0), (1, 1), (2, 0), (2, 1), (2, 2)) s(cut, head)
    JOIN username_word u ON u.word = substr(d.f, s.head + 1, char_length(d.f) - s.cut)
    WHERE s.cut < char_length(d.f)
      AND s.cut <= CASE WHEN char_length(u.word) >= 4 AND u.match = 'part' THEN 2 WHEN char_length(u.word) >= 3 THEN 1
                        ELSE 0 END)
  INTO hit;
  RETURN hit;
END $$;
REVOKE ALL ON FUNCTION full_name_blocked(text) FROM PUBLIC;

-- ================================================================ common compounds
-- A compound insult holds its entry with more letters around it than the entry's budget ("fuckface Ali", "Mr Shithead",
-- "jackass", «كسامك» would pass). The commonest are entries of their own, so they are refused with their endings.
-- Five are `part` entries holding a `part` entry already (fuck, shit), so no username's answer changes for them.
INSERT INTO username_word (word, match, language) VALUES
  ('fuckface', 'part', 'en'), ('fuckhead', 'part', 'en'), ('fuckwit', 'part', 'en'), ('shithead', 'part', 'en'),
  ('shitface', 'part', 'en')
ON CONFLICT (word) DO NOTHING;
-- The others are `word` entries: in a full name they are refused with one letter or a known ending around them; in a
-- username they match a whole token only (`username_blocked`), so the only usernames they newly refuse hold a token that
-- is the compound itself ("jackass", "dumbass_7"; never "jackassery"). «كسأمك» folds to «كسامك»; «كس_امك» is two words,
-- the first «كس». The ones holding a `part` entry (cumslut, cuntface, twatface, fucktard, slutbag, whoreson) were
-- refused as usernames already.
INSERT INTO username_word (word, match, language) VALUES
  ('dickhead', 'word', 'en'), ('cocksucker', 'word', 'en'), ('jackass', 'word', 'en'), ('dumbass', 'word', 'en'),
  ('asshat', 'word', 'en'), ('asswipe', 'word', 'en'), ('cumslut', 'word', 'en'), ('cumdump', 'word', 'en'),
  ('dickface', 'word', 'en'), ('cuntface', 'word', 'en'), ('twatface', 'word', 'en'), ('fatass', 'word', 'en'),
  ('fucktard', 'word', 'en'), ('slutbag', 'word', 'en'), ('whoreson', 'word', 'en'),
  ('كسامك', 'word', 'ar'), ('كسختك', 'word', 'ar'), ('كساختك', 'word', 'ar')
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
  ('شاذلي', 'ar'), ('شرجبي', 'ar'), ('لحسن', 'ar'), ('لحسين', 'ar'), ('جماعي', 'ar'), ('شرجي', 'ar'), ('زبيدات', 'ar'),
  ('nishit', 'en'), ('shittu', 'en'), ('skeete', 'en'), ('skeeter', 'en'), ('bastardi', 'en'),
  ('swank', 'en'), ('vecchi', 'en'), ('vecchio', 'en'), ('nasser', 'en'), ('yasser', 'en'), ('gasser', 'en'),
  ('jasser', 'en'), ('butti', 'en'), ('butts', 'en'), ('mongi', 'en'), ('monge', 'en'), ('tito', 'en'), ('titus', 'en'),
  ('dicko', 'en'), ('dickey', 'en'), ('cass', 'en'), ('bass', 'en'), ('janus', 'en'), ('cocker', 'en'),
  ('cummings', 'en'), ('cooney', 'en'), ('negron', 'en'), ('spicer', 'en'), ('smutny', 'en'), ('bonera', 'en'),
  ('asser', 'en'), ('assis', 'en'), ('assi', 'en'), ('kasser', 'en'), ('wasser', 'en'), ('lasser', 'en'), ('hasser', 'en'),
  ('sasser', 'en'), ('cuma', 'en'), ('titi', 'en'), ('tita', 'en'), ('manus', 'en'), ('anush', 'en'), ('butters', 'en')
ON CONFLICT (word) DO NOTHING;

-- ================================================================ the recheck
UPDATE full_name_recheck SET pending = true, after_enrollment = NULL, after_field = NULL, changed_at = now();
