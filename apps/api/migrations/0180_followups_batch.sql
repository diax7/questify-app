-- A batch of review follow-ups (docs/FOLLOWUPS.md, batch 25): the event time zone guard reads a copy of the zone list,
-- and the full-name check reads symbols inside a word, runs of one letter and more look-alike letters. One new table
-- (`timezone_name`, no right for anyone but its owner) and three functions restated with the same signature, so their
-- owner and grants (none) stay: `event_timezone_guard` (diffed against 0009), `full_name_fold` (against 0177) and
-- `full_name_blocked` (against 0179). Nothing here writes points or XP, changes a sign-in, a tenant rule or a redemption.
-- 0179 and earlier untouched.
SET LOCAL lock_timeout = '10s';

-- ================================================================ the time zone guard (FOLLOWUPS 2026-11-05)
-- 0009 looked each zone up in `pg_timezone_names`, which reads and parses every file of the server's time zone folder on
-- every call: about 43 ms an event insert or zone change (599 zones, PostgreSQL 17.11). `timezone_name` is a copy of that
-- list, taken here and again after every server restart (`loaded_for` holds `pg_postmaster_start_time()`; a new
-- PostgreSQL or tzdata comes with an image or package upgrade, which restarts it). A zone in a copy of this server run is
-- valid; any other zone is looked up in `pg_timezone_names` as before, so the answers are the same, and only a miss (a
-- zone the API refuses first, or one a tzdata update added since the copy) pays the 43 ms. A stale copy is taken again
-- by the first miss that gets the advisory key, and kept if that write commits; a miss that does not get it answers from
-- `pg_timezone_names`. The one gap: a tzdata update applied under a running server that removes a zone (Debian's split of
-- old names into tzdata-legacy) leaves that zone accepted until the next restart. The text equality is 0009's, so case,
-- abbreviations, offsets and POSIX strings are answered as `pg_timezone_names` answers them
-- (`test/db/event-timezone.int.test.ts` compares every name it holds, 31 invalid ones and NULL).
CREATE TABLE timezone_name (
  name       text PRIMARY KEY,
  loaded_for timestamptz NOT NULL
);
ALTER TABLE timezone_name ENABLE ROW LEVEL SECURITY;
ALTER TABLE timezone_name FORCE ROW LEVEL SECURITY;
REVOKE ALL ON timezone_name FROM PUBLIC;
INSERT INTO timezone_name (name, loaded_for) SELECT DISTINCT name, pg_postmaster_start_time() FROM pg_timezone_names;
-- The guard reads the copy as the migration owner, which must bypass its forced row-level security (as 0016, 0177).
DO $$
BEGIN
  IF (SELECT count(*) FROM timezone_name) = 0 THEN
    RAISE EXCEPTION 'the migration owner cannot read timezone_name (row-level security is forced): grant it BYPASSRLS';
  END IF;
END $$;

-- Restated with the same name and trigger, diffed against 0009: the lookup reads the copy first. Now a definer (owned by
-- the migration owner, like the copy), so the API's role needs no right on `timezone_name`; a trigger function is never
-- called directly, and its EXECUTE right stays revoked from PUBLIC.
CREATE OR REPLACE FUNCTION event_timezone_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  started timestamptz := pg_postmaster_start_time();
BEGIN
  IF EXISTS (SELECT 1 FROM timezone_name t WHERE t.name = NEW.timezone AND t.loaded_for = started) THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM timezone_name t WHERE t.loaded_for = started)
     AND pg_try_advisory_xact_lock(hashtextextended('timezone_name', 0)) THEN
    DELETE FROM timezone_name;
    INSERT INTO timezone_name (name, loaded_for) SELECT DISTINCT name, started FROM pg_timezone_names;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'unknown time zone' USING ERRCODE = 'QE422';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION event_timezone_guard() FROM PUBLIC;

-- ================================================================ the full-name fold (batch 23 re-review, NIT 7)
-- As 0177, with more look-alike letters read as the Latin letters they show: the small capitals (ᴀ ʙ ᴄ ᴅ ᴇ ꜰ ɢ ʜ ɪ ᴊ ᴋ ʟ ᴍ ɴ
-- ᴏ ᴘ ꞯ ʀ ꜱ ᴛ ᴜ ᴠ ᴡ ʏ ᴢ, which NFKC leaves alone), the IPA ɑ ɡ ɩ, the dotless ȷ, Cyrillic һ ӏ ү and Greek ς (NFKC's form of
-- the lunate ϲ) and ϳ, and Armenian ս օ հ. Nothing else changes.
CREATE OR REPLACE FUNCTION full_name_fold(name text) RETURNS text
  LANGUAGE sql IMMUTABLE
  RETURN btrim(regexp_replace(
    translate(
      username_fold(normalize(regexp_replace(normalize(normalize(coalesce(display_name_text(name), ''), NFKC), NFD),
        '[̀-ͯ҃-҉᪰-᫿᷀-᷿⃐-⃿︠-︯ؐ-ًؚ-ْ'
        'ٖ-ٰٟۖ-ۜ۟-۪ۤۧۨ-ۭـ]', '', 'g'), NFC)),
      'کڪیےېہەھۀٱۃ٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹авекмнорстухіјѕԁԛԝАВЕКМНОРСТУХІЈЅαβεηικνορτυχωΑΒΕΖΗΙΚΜΝΟΡΤΥΧıøłđħ'
      'ᴀʙᴄᴅᴇꜰɢʜɪᴊᴋʟᴍɴᴏᴘꞯʀꜱᴛᴜᴠᴡʏᴢɑɡɩȷһӏүςϳսօհ',
      'ككيييههههاه01234567890123456789abekmhopctyxijsdqwabekmhopctyxijsabenikvoptuxwabezhikmnoptyxioldh'
      'abcdefghijklmnopqrstuvwyzagijhlycjuoh'),
    '[\s\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E¡-¿×÷‐-‧‰-⁞←-⯿'
    '،؛؟٪-٭۔　-〿\U0001F000-\U0001FAFF]+', ' ', 'g'), ' ');
REVOKE ALL ON FUNCTION full_name_fold(text) FROM PUBLIC;

-- ================================================================ the full-name check (batch 23 re-review, NIT 7)
-- As 0179, with two more readings of a word (Dhia's letter-count rule, ADR-817). Each only adds forms to look up, so it
-- refuses a name only when a reading holds a list entry within its budget; a name no reading hits passes as before.
--   * Symbols inside a word: a run of * ! @ $ with a letter or digit on both sides is read as letters, * as u and again
--     as i, ! as i, @ as a, $ as s, with the word's digits read as 0179 reads them (0 o, 1 i, 3 e, 4 a, 5 s, 7 t): f*ck,
--     sh!t, a$$hole, b!tch. A symbol at a word's start or end still separates ("Dick!", "@li"), and a Latin word only.
--   * Repeated letters: a run of 3 or more of one letter is read as 1 and again as 2 (Fuuuck is fuck, asssshole is
--     asshole). A run of 2 is never touched: Aaron, Abbas, Hassan, Moo.
-- These readings never skip as allow words: an allow word is a real name as written, and "d!ck" or "Diiick" is not one.
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
  -- Symbols inside a Latin word read as letters: the name folded again with each run of * ! @ $ between two letters or
  -- digits kept in its word as a private-use mark (any other run, and any mark the name held, is a space), so the fold
  -- leaves it in place. Only a name holding one of them pays for the second fold.
  IF name ~ '[*!@$]' THEN
    FOREACH piece IN ARRAY string_to_array(full_name_fold(regexp_replace(
        translate(regexp_replace(name, '[-]', ' ', 'g'), '*!@$', marks),
        '(?<![[:alnum:]-])[-]+|[-]+(?![[:alnum:]-])', ' ', 'g')), ' ')
    LOOP
      CONTINUE WHEN piece !~ '[-]' OR piece ~ '[ء-ي]';
      readings := readings || translate(piece, marks || '013457', 'uiasoieast')
                           || translate(piece, marks || '013457', 'iiasoieast');
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
  RETURN hit;
END $$;
REVOKE ALL ON FUNCTION full_name_blocked(text) FROM PUBLIC;

-- ================================================================ the recheck
-- The full-name fold and check change for stored names (docs/rules.md, ADR-817): the lifecycle tick re-flags them.
UPDATE full_name_recheck SET pending = true, after_enrollment = NULL, after_field = NULL, changed_at = now();
