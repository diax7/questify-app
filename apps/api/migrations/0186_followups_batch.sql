-- A batch of review follow-ups (docs/FOLLOWUPS.md, batch 35). Two changes, no table, no grant beyond the restated ones:
--   1. The affixes the full-name check strips live in one internal function, `full_name_stems` (new, plpgsql, IMMUTABLE,
--      revoked from PUBLIC, no grant; ADR-670: it cannot be inlined, so it is plpgsql, and it is no definer and has no
--      SET clause), called by `full_name_blocked` (diffed against 0181) and by the console's add door
--      `admin_name_allow_add` (diffed against 0185), which had copied the lists. The door also filters its WA422 probes
--      to those holding the word before it checks them (0185 checked all 327 first). Both answer exactly as before
--      (compared old against new over the full corpus and every allow-list test word), so the recheck is not marked
--      pending.
--   2. `own_achievements` (diffed against 0171) shows as next the first tier above the one held that is not revoked: a
--      player with bronze revoked and no tier sees silver, one holding bronze with silver revoked sees gold. Restated in
--      plpgsql (ADR-670; it leaves `sql-settings-allowlist.json`), same signature, owner and grants.
-- Nothing here writes points or XP, changes a sign-in, a tenant rule or a redemption. 0185 and earlier untouched; 0156
-- stays reserved.
SET LOCAL lock_timeout = '10s';

-- ================================================================ the affixes of the full-name check (allow-list review)
-- The stems the forms of one word leave with one affix of the check removed (2 letters or more left), as 0181's
-- `full_name_blocked` and 0185's `admin_name_allow_add` each declared the affixes and looped over them, form by form in
-- order. `stems` is every stem, with ة read as ت before a pronoun or ات (an Arabic stem ending so is also given with ه)
-- and a Latin -ies stem also given with y; `named` is the Arabic stems an allow word covers: its prefix and nisba forms,
-- never after يا (a call). One call a word, reading only the lists of its script.
CREATE FUNCTION full_name_stems(forms text[], arabic boolean, OUT stems text[], OUT named text[])
  LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  prefixes  text[];
  endings   text[];
  latin_end text[];
  form      text;
  rest      text;
  stem      text;
  p         text;
  e         text;
BEGIN
  stems := '{}';
  named := '{}';
  IF arabic THEN
    -- Before an Arabic word: و or ف, then ب ك or ل, then ال (ل with ال is written لل); or يا, with ال; or ابن or بنت,
    -- with ال.
    prefixes := '{"",و,ف,ب,ك,ل,وب,وك,ول,فب,فك,فل,ال,وال,فال,بال,كال,لل,وبال,وكال,ولل,فبال,فكال,فلل,'
                'يا,ياال,ابن,ابنال,بنت,بنتال,يابن,يابنال}';
    -- After it: a plural, a pronoun (ة read as ت before one) or the nisba (folded: ة reads ه, ية reads يه).
    endings := '{"",ات,ين,ون,ك,كم,ها,هم,تك,تكم,تها,تهم,تي,ي,يه,ه}';
    FOREACH form IN ARRAY forms LOOP
      FOREACH p IN ARRAY prefixes LOOP
        CONTINUE WHEN NOT starts_with(form, p);
        rest := substr(form, char_length(p) + 1);
        FOREACH e IN ARRAY endings LOOP
          CONTINUE WHEN char_length(rest) - char_length(e) < 2 OR right(rest, char_length(e)) <> e;
          stem := left(rest, char_length(rest) - char_length(e));
          stems := stems || stem;
          -- A name of the allow-list covers its prefix and nisba forms only: «الخولات» is not «خولة», and يا before
          -- it is a call, not a name («ياخولي»).
          IF e IN ('', 'ي', 'يه', 'ه') AND NOT starts_with(p, 'يا') THEN
            named := named || stem;
          END IF;
          -- ة becomes ت before a pronoun or ات: «شرموطتك», «قحبات» are the stem with ه.
          IF e = 'ات' OR e LIKE 'ت%' THEN
            stems := stems || (stem || 'ه');
          END IF;
        END LOOP;
      END LOOP;
    END LOOP;
  ELSE
    latin_end := '{"",s,es,er,ers,ed,ing,ings,y,ies}';
    FOREACH form IN ARRAY forms LOOP
      FOREACH e IN ARRAY latin_end LOOP
        CONTINUE WHEN char_length(form) - char_length(e) < 2 OR right(form, char_length(e)) <> e;
        stem := left(form, char_length(form) - char_length(e));
        stems := stems || stem;
        IF e = 'ies' THEN
          stems := stems || (stem || 'y');
        END IF;
      END LOOP;
    END LOOP;
  END IF;
END $$;
REVOKE ALL ON FUNCTION full_name_stems(text[], boolean) FROM PUBLIC;

-- ================================================================ the full-name check
-- As 0181, with the affix lists and their loops moved to `full_name_stems` (the same lists, the same stems in the same
-- order). Its answer is unchanged.
CREATE OR REPLACE FUNCTION full_name_blocked(name text) RETURNS boolean
  LANGUAGE plpgsql STABLE AS $$
DECLARE
  folded    text[] := string_to_array(full_name_fold(name), ' ');
  words     text[] := '{}';
  readings  text[] := '{}';
  forms     text[] := '{}';
  found     text[];
  named     text[];
  allow_all text[];
  allow_ar  text[];
  piece     text;
  bare      text;
  affixed   record;
  spelled   text := '';
  -- Private-use marks for * ! @ $ (U+E000 to U+E003): no fold step changes or splits at them.
  marks     text := U&'\E000\E001\E002\E003';
  mark      text := U&'\E000-\E003';
  -- The name the symbols are read in: NFKC (a full-width ＊ ！ ＠ ＄ ＿ is the symbol it shows), ∗ ⁎ _ # ٭ ✱ ✲ ✳ ⚹ ❋ ⁕ ★ • |
  -- read as * (the fold would make _ a space) and ¡ as !.
  wide      text := translate(normalize(name, NFKC), '∗⁎¡_#٭✱✲✳⚹❋⁕★•|', '**!*************');
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
    IF bare ~ '[ء-ي]' THEN
      -- An Arabic word: every stem left by one prefix and one ending, of two letters or more.
      affixed := full_name_stems(bare || regexp_split_to_array(piece, '[0-9]+'), true);
      found := affixed.stems;
      named := affixed.named;
      CONTINUE WHEN written AND piece = bare AND named && allow_ar;
    ELSE
      -- A Latin word: with its digits removed or read as letters, and its pieces between digits, each with one ending.
      found := (full_name_stems(ARRAY[bare, regexp_replace(translate(piece, '013457', 'oieast'), '[0-9]', '', 'g')]
                                || regexp_split_to_array(piece, '[0-9]+'), false)).stems;
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
  -- A form holding the wildcard of a * is looked up by its length against the entries with LIKE, whole: a wildcard form
  -- is never cut at its ends (a real name with a starred letter, "Y*nus", "Sm*th", would read as an entry with a letter
  -- dropped), so it must match an entry exactly. It keeps at least 2 letters that are not the wildcard, so "x**" never
  -- stands for every entry of 3 letters.
  wild := ARRAY(SELECT DISTINCT d.f FROM unnest(forms) d(f) WHERE strpos(d.f, '_') > 0);
  IF NOT hit AND wild <> '{}' THEN
    SELECT EXISTS (
      SELECT 1
      FROM unnest(wild) d(f)
      JOIN username_word u ON char_length(u.word) = char_length(d.f) AND u.word LIKE d.f
      WHERE char_length(replace(d.f, '_', '')) >= 2)
    INTO hit;
  END IF;
  RETURN hit;
END $$;
REVOKE ALL ON FUNCTION full_name_blocked(text) FROM PUBLIC;

-- ================================================================ the console add door
-- As 0185, with two changes and the same answers: its copy of the affix lists and its loop are replaced by
-- `full_name_stems`, and the WA422 probes are filtered to those holding the word before the check runs on them.
-- Adds an allow word. Answers {outcome: added | exists, word: the stored word}. The word is stored as the check reads a
-- name: `full_name_fold` (NFKC,
-- accents and marks dropped, the username fold, Persian and look-alike letters made the list's), so «Nāsser», «ناصر» with
-- a Persian letter or a full-width word is stored as the check will meet it; its language is its letters' (an Arabic
-- word also covers its prefix and nisba forms, ADR-817). Refusals:
--   WA400  not one word of 2 or more letters, all Arabic or all English, typed in 60 characters or fewer (a space, a
--          digit or a symbol is left after the fold, or the table's CHECK refuses it);
--   WA409  the word is itself a `username_word` entry, or is one in a shape the check reads as the entry: with one of the
--          check's own affixes removed (`full_name_stems`, which `full_name_blocked` also calls: a Latin ending, an
--          Arabic prefix and ending, ة read as ت before a pronoun or ات), or with a run of 3 or more of one letter read as 1 or 2, it equals a
--          `word` entry or holds a `part` entry (cunty, pussys, asses, kikes, «كسي», «الكسي», «منيوكي», fuuuck). Allowing
--          it would let the entry through in that shape. The word as typed may hold a `part` entry: that is what an
--          allow word is for. A real name of that shape (Butt, Butts, Skeeter, seeded) stays a migration's decision,
--          reviewed;
--   WA422  with the word allowed, an abusive name of `full_name_probe` that the check refuses now would pass.
-- Neither rule sees an abusive form outside the corpus and outside the affix rule; the audit entry is the backstop.
-- Lock order, as the word doors: the lists' advisory key exclusive, then reads of the lists and the probes (no lock),
-- the new row, the sweep row (the list trigger), never an answer. The probes checked are only those holding the word
-- (the word skips only a word of a name, so a probe whose folded letters do not hold it cannot change); each is checked
-- before the insert and again after it, a few probes at most, under 50 ms.
CREATE OR REPLACE FUNCTION admin_name_allow_add(new_word text, request uuid) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me        uuid := console_admin();
  folded    text := full_name_fold(left(coalesce(new_word, ''), 61));
  lang      text;
  holding   text[];
  refused   text[];
  forms     text[];
  stems     text[];
BEGIN
  lang := CASE WHEN folded ~ '^[ء-غف-ي]{2,}$' THEN 'ar' WHEN folded ~ '^[a-z]{2,}$' THEN 'en' END;
  IF lang IS NULL OR char_length(new_word) > 60 THEN
    RAISE EXCEPTION 'not a word for the allow-list' USING ERRCODE = 'WA400';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('username_word', 0));
  IF EXISTS (SELECT 1 FROM full_name_allow a WHERE a.word = folded) THEN
    RETURN jsonb_build_object('outcome', 'exists', 'word', folded);
  END IF;
  IF EXISTS (SELECT 1 FROM username_word u WHERE u.word = folded) THEN
    RAISE EXCEPTION 'the word is on the word lists' USING ERRCODE = 'WA409';
  END IF;
  -- The shapes the check reads as an entry: a run of 3 or more of one letter read as 1 and as 2, then one affix of the
  -- check's own loop removed (2 letters or more left, `full_name_stems`), as `full_name_blocked` reads a word.
  forms := ARRAY[folded];
  IF folded ~ '(.)\1\1' THEN
    forms := forms || regexp_replace(folded, '(.)\1\1+', '\1', 'g') || regexp_replace(folded, '(.)\1\1+', '\1\1', 'g');
  END IF;
  stems := (full_name_stems(forms, lang = 'ar')).stems;
  -- The word as typed is not a shape: it may hold a `part` entry (the allow-list's reason), never equal one (above).
  IF EXISTS (SELECT 1 FROM unnest(array_remove(stems, folded)) s(stem)
             JOIN username_word u ON (u.match = 'word' AND u.word = s.stem)
                                  OR (u.match = 'part' AND strpos(s.stem, u.word) > 0)) THEN
    RAISE EXCEPTION 'the word is a list entry with an ending, a prefix or a repeated letter' USING ERRCODE = 'WA409';
  END IF;
  -- The probes that hold the word first, then the check on those alone: in one WHERE the planner may run the check on
  -- every probe before the cheap filter (0185 did, about 85 ms a call).
  holding := ARRAY(SELECT p.name FROM full_name_probe p
                   WHERE strpos(replace(full_name_fold(p.name), ' ', ''), folded) > 0);
  refused := ARRAY(SELECT h.n FROM unnest(holding) h(n) WHERE full_name_blocked(h.n));
  BEGIN
    INSERT INTO full_name_allow (word, language) VALUES (folded, lang);
  EXCEPTION
    WHEN check_violation THEN
      RAISE EXCEPTION 'not a word for the allow-list' USING ERRCODE = 'WA400';
  END;
  IF EXISTS (SELECT 1 FROM unnest(refused) n WHERE NOT full_name_blocked(n)) THEN
    RAISE EXCEPTION 'the word would let an abusive name through' USING ERRCODE = 'WA422';
  END IF;
  INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, after, request_id)
  VALUES ('admin', me, 'full_name_allow.add', 'full_name_allow', folded, jsonb_build_object('language', lang), request);
  RETURN jsonb_build_object('outcome', 'added', 'word', folded);
END $$;
REVOKE ALL ON FUNCTION admin_name_allow_add(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_name_allow_add(text, uuid) TO questify_app;

-- ================================================================ the next tier of an achievement (batch 18 review NIT)
-- As 0171, with one change: the next tier is the first tier above the one held (bronze when none is) that is not
-- revoked. A revoked tier is never earned again, so it is skipped, never a stop: bronze revoked and no tier shows silver,
-- bronze held with silver revoked shows gold, and only when every tier above is revoked (or gold is held) is it null. A
-- tier never earned is not revoked (`tier_revoked` reads no row), so it stays a goal. In plpgsql (ADR-670), the old
-- query read into one value.
CREATE OR REPLACE FUNCTION own_achievements() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  answer jsonb;
BEGIN
  SELECT answer_row.v INTO answer
  FROM (
    SELECT jsonb_agg(jsonb_build_object('id', a.id, 'name', jsonb_build_object('ar', a.name_ar, 'en', a.name_en),
      'visualKey', a.visual_key, 'tier', t.tier, 'progress', m.value,
      'next', (SELECT jsonb_build_object('tier', n.tier, 'target', n.target)
               FROM (VALUES (1, 'bronze', a.bronze), (2, 'silver', a.silver), (3, 'gold', a.gold)) n (rank, tier, target)
               WHERE n.rank > coalesce(array_position(ARRAY['bronze', 'silver', 'gold'], t.tier), 0)
                 AND NOT tier_revoked(me.id, a.id, n.tier)
               ORDER BY n.rank LIMIT 1))
      ORDER BY a.position)
    FROM (SELECT profile_player() AS id) me
    CROSS JOIN LATERAL player_metrics(me.id) m JOIN achievement a ON a.metric = m.metric
    CROSS JOIN LATERAL (SELECT earned_tier(me.id, a.id) AS tier) t
    WHERE me.id IS NOT NULL) AS answer_row(v);
  RETURN answer;
END $$;
REVOKE ALL ON FUNCTION own_achievements() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION own_achievements() TO questify_app;

