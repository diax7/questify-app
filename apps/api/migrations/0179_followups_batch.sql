-- A batch of review follow-ups (docs/FOLLOWUPS.md, batch 24): the full-name check reads ال after يا, five words join the
-- username lists, and `username_blocked` folds a name once. Two functions restated with the same signature, so their
-- owner and grants (none) stay: `full_name_blocked` (diffed against 0178: one prefix, ياال, and its comment) and
-- `username_blocked` (diffed against 0118: the same answers, now PL/pgSQL). No new table, column or function. Nothing
-- here writes points or XP, changes a sign-in, a tenant rule or a redemption. 0178 and earlier untouched.
SET LOCAL lock_timeout = '10s';

-- ================================================================ the full-name check (0178 fix)
-- As 0178, with ياال among the prefixes. A lone يا is read with the word after it, so «يا البزاز» is «ياالبزاز»; with only
-- يا taken off, «البزاز» held «بزاز» with 2 letters left over, past a `word` entry's 1, and it passed (as «يا القحبة»
-- did). يا is a call, never a name, so the allow-list never covers a form with it: «يا البزاز» is refused, «البزاز» kept.
CREATE OR REPLACE FUNCTION full_name_blocked(name text) RETURNS boolean
  LANGUAGE plpgsql STABLE AS $$
DECLARE
  folded    text[] := string_to_array(full_name_fold(name), ' ');
  -- Before an Arabic word: و or ف, then ب ك or ل, then ال (ل with ال is written لل); or يا, with ال; or ابن or بنت,
  -- with ال.
  prefixes  text[] := '{"",و,ف,ب,ك,ل,وب,وك,ول,فب,فك,فل,ال,وال,فال,بال,كال,لل,وبال,وكال,ولل,فبال,فكال,فلل,'
                      'يا,ياال,ابن,ابنال,بنت,بنتال,يابن,يابنال}';
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

-- ================================================================ five words (Q-754 second review, NIT 8)
-- Each kind chosen on the corpus (`test/db/full-name-corpus.ts`) and the username tests: a `part` entry matches anywhere
-- in a username, a `word` entry a whole token (split at _ and digits); in a full name either is refused with few letters
-- around it (ADR-817: at most 2 for a `part` entry of 4 letters or more, 1 otherwise).
--   * hitler, fvck: `part`. No real name or word holds them; "h1tler_88", "fvckboy" are refused.
--   * nazi: `word`. As a part it would refuse the usernames nazir_1, nazira, nazim_k (Ghazi never holds it). A full name
--     refuses Nazi, Nazis and nazi with 1 letter more, so the names Nazir, Nazim, Nazia, Nazih, Nazik and Nazif are allow
--     words (below); Nazira, Nazima and Naziha pass with 2 letters left over.
--   * retard: `word`. As a part it would refuse "flame_retardant" and French words (retarder, retardataire). A full name
--     refuses retard, retards, retarded and retard with 1 letter more; the corpus has no real name that holds it.
--   * fuk: `word`. As a part it would refuse Fukuda, Fukui, Fukushima. Fuk is also a Cantonese given name (福: Wong Fuk
--     Wing), so it is an allow word itself: a full name refuses fuk only with 1 letter more (fukk, fuker), and the names
--     Fuka, Fuku and Fuks (Japanese given names, a Polish surname) are allow words too; Fukuda and Fukui pass. A username
--     still refuses the token fuk ("fuk_u", and so "fuk_wing"): a username is chosen, a full name is not.
INSERT INTO username_word (word, match, language) VALUES
  ('hitler', 'part', 'en'), ('fvck', 'part', 'en'), ('nazi', 'word', 'en'), ('retard', 'word', 'en'), ('fuk', 'word', 'en')
ON CONFLICT (word) DO NOTHING;
INSERT INTO full_name_allow (word, language) VALUES
  ('nazir', 'en'), ('nazim', 'en'), ('nazia', 'en'), ('nazih', 'en'), ('nazik', 'en'), ('nazif', 'en'), ('fuk', 'en'),
  ('fuka', 'en'), ('fuku', 'en'), ('fuks', 'en')
ON CONFLICT (word) DO NOTHING;

-- ================================================================ the username check (batch 23 review)
-- As 0118, with the same answers: a `word` entry is a whole token of the folded name (split at _ and digits), a `part`
-- entry is anywhere in it with _ and digits removed or read as letters, and a retired name is blocked. 0118's single-use
-- CTEs were inlined into the `username_word` scan, so the fold and three regexes ran once per list row (about 450). Now
-- PL/pgSQL with no SET clause (its callers are definers that call it in a plain IF; docs/rules.md): the name is folded and
-- its forms built once, a `word` entry is looked up by its unique key, a `part` entry costs one or two `position` calls a
-- row, and a retired name is looked up by its key. `test/db/username-blocked-same.int.test.ts` compares it with 0118's on
-- every corpus name, list entry and username of the tests, and their look-alikes.
CREATE OR REPLACE FUNCTION username_blocked(name text) RETURNS boolean
  LANGUAGE plpgsql STABLE AS $$
DECLARE
  folded text   := username_fold(name);
  tokens text[] := regexp_split_to_array(folded, '[_0-9]+');
  bare   text   := regexp_replace(folded, '[_0-9]', '', 'g');
  mapped text   := regexp_replace(translate(folded, '013457', 'oieast'), '[_0-9]', '', 'g');
  hit    boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM username_word w WHERE w.word = ANY (tokens) AND w.match = 'word')
      OR EXISTS (SELECT 1 FROM username_word w
                 WHERE w.match = 'part' AND (position(w.word IN bare) > 0 OR position(w.word IN mapped) > 0))
      OR EXISTS (SELECT 1 FROM username_retired r WHERE r.fold = folded)
  INTO hit;
  RETURN hit;
END $$;
REVOKE ALL ON FUNCTION username_blocked(text) FROM PUBLIC;

-- ================================================================ the recheck
-- The full-name check changes for stored names (docs/rules.md); the list statements above mark it as well.
UPDATE full_name_recheck SET pending = true, after_enrollment = NULL, after_field = NULL, changed_at = now();
