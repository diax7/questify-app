-- A batch of review follow-ups (docs/FOLLOWUPS.md, batch 27): the full-name check reads symbols after NFKC, reads ∗ ⁎ ¡,
-- reads * as any one letter and a run of symbols also as one. One function restated with the same signature, so its
-- owner and grants (none) stay: `full_name_blocked` (diffed against 0180). No table, no grant, nothing that writes points
-- or XP, changes a sign-in, a tenant rule or a redemption. 0180 and earlier untouched.
SET LOCAL lock_timeout = '10s';

-- ================================================================ the full-name check (batch 25 review, MINOR and NIT)
-- As 0180, with the symbol reading changed (Dhia's letter-count rule, ADR-817, unchanged: a reading only adds forms to
-- look up, refuses a name only when a form holds a list entry within its budget, and never counts as an allow word).
--   * The symbols are read in the name after NFKC, so f＊ck, sh！t, b＠stard and a＄＄hole read as their ASCII forms
--     (0180 read them before NFKC, and the fold then made them spaces); ∗ (U+2217) and ⁎ (U+204E) read as *, ¡ as !.
--   * * is a wildcard, any one letter, looked up with LIKE (0180 read it as u and again as i, so fu*k, c**t, wh*re
--     passed). A slice keeps 2 letters or more that are not wildcards. ! @ $ read as i, a, s as before.
--   * A run of two or more symbols is read as written and again as one symbol: sh!!t is shiit and shit, b!!tch bitch,
--     F**k f__k (fuck) and f_k (fuk). Inside readings only; a name as written is unchanged.
-- Only a name with a symbol inside a Latin word pays for any of it.
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
  readings  text[] := '{}';
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
  -- Private-use marks for * ! @ $ (U+E000 to U+E003): no fold step changes or splits at them.
  marks     text := U&'\E000\E001\E002\E003';
  mark      text := U&'\E000-\E003';
  -- The name the symbols are read in: NFKC (a full-width ＊ ！ ＠ ＄ is the symbol it shows), ∗ ⁎ read as * and ¡ as !.
  wide      text := translate(normalize(name, NFKC), '∗⁎¡', '**!');
  -- The forms holding the wildcard of a * (`_`, which the fold never leaves in a word).
  wild      text[];
  written   boolean;
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
  -- Symbols inside a Latin word read as letters: the name in NFKC (so ＊ ！ ＠ ＄ are * ! @ $), with ∗ and ⁎ read as *
  -- and ¡ as !, folded again with each run of * ! @ $ between two letters or digits kept in its word as private-use marks
  -- (any other run, and any mark the name held, is a space), so the fold leaves it in place. Only a name holding one of
  -- them pays for the second fold. ! @ $ read as i, a and s; * is a wildcard, any one letter (`_`): f*ck, fu*k, c**t.
  -- A run of two or more is read as written and again as one symbol: sh!!t is shiit and shit, F**k is f__k and f_k.
  IF wide ~ '[*!@$]' THEN
    FOREACH piece IN ARRAY string_to_array(full_name_fold(regexp_replace(
        translate(regexp_replace(wide, '[' || mark || ']', ' ', 'g'), '*!@$', marks),
        '(?<![[:alnum:]' || mark || '])[' || mark || ']+|[' || mark || ']+(?![[:alnum:]' || mark || '])', ' ', 'g')), ' ')
    LOOP
      CONTINUE WHEN piece !~ ('[' || mark || ']') OR piece ~ '[ء-ي]';
      readings := readings || translate(piece, marks || '013457', '_iasoieast');
      IF piece ~ ('[' || mark || ']{2}') THEN
        readings := readings || translate(regexp_replace(piece, '([' || mark || '])[' || mark || ']+', '\1', 'g'),
                                          marks || '013457', '_iasoieast');
      END IF;
    END LOOP;
  END IF;
  -- Runs of 3 or more of one letter read as 1 and as 2, in the words and in the readings above.
  FOREACH piece IN ARRAY words || readings LOOP
    CONTINUE WHEN piece !~ '(.)\1\1';
    readings := readings || regexp_replace(piece, '(.)\1\1+', '\1', 'g') || regexp_replace(piece, '(.)\1\1+', '\1\1', 'g');
  END LOOP;
  SELECT coalesce(array_agg(a.word), '{}'), coalesce(array_agg(a.word) FILTER (WHERE a.language = 'ar'), '{}')
  INTO allow_all, allow_ar
  FROM full_name_allow a;
  FOR i IN 1 .. cardinality(words) + cardinality(readings) LOOP
    written := i <= cardinality(words);
    piece := CASE WHEN written THEN words[i] ELSE readings[i - cardinality(words)] END;
    bare := regexp_replace(piece, '[0-9]', '', 'g');
    -- An allow word is skipped only as written, with no digit in it: "dick5", "kike88", "d!ck" are not Dick and Kike.
    CONTINUE WHEN written AND piece = bare AND bare = ANY (allow_all);
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
      CONTINUE WHEN written AND piece = bare AND named && allow_ar;
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
  -- A form holding the wildcard of a * is looked up by its length against the slices with LIKE, by the same budget; a
  -- slice keeps at least 2 letters that are not the wildcard, so "x**" never stands for every entry of 3 letters.
  wild := ARRAY(SELECT DISTINCT d.f FROM unnest(forms) d(f) WHERE strpos(d.f, '_') > 0);
  IF NOT hit AND wild <> '{}' THEN
    SELECT EXISTS (
      SELECT 1
      FROM unnest(wild) d(f)
      CROSS JOIN (VALUES (0, 0), (1, 0), (1, 1), (2, 0), (2, 1), (2, 2)) s(cut, head)
      CROSS JOIN LATERAL (SELECT substr(d.f, s.head + 1, char_length(d.f) - s.cut) AS slice) c
      JOIN username_word u ON char_length(u.word) = char_length(c.slice) AND u.word LIKE c.slice
      WHERE s.cut < char_length(d.f)
        AND char_length(replace(c.slice, '_', '')) >= 2
        AND s.cut <= CASE WHEN char_length(u.word) >= 4 AND u.match = 'part' THEN 2 WHEN char_length(u.word) >= 3 THEN 1
                          ELSE 0 END)
    INTO hit;
  END IF;
  RETURN hit;
END $$;
REVOKE ALL ON FUNCTION full_name_blocked(text) FROM PUBLIC;

-- ================================================================ the recheck
-- The full-name check changes for stored names (docs/rules.md, ADR-817): the lifecycle tick re-flags them.
UPDATE full_name_recheck SET pending = true, after_enrollment = NULL, after_field = NULL, changed_at = now();
