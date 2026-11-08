-- The word lists on a full name (FOLLOWUPS batch 23, T-615 follow-up, ADR-817). A full name shown to other players is
-- free text the player typed; the username lists (FR-118, ADR-119) now check it:
--   (1) at the join, a Full name answer holding a listed word is refused (JA422, DETAIL `name:<field id>`), so the join
--       rolls back and the card points at the field;
--   (2) every stored Full name answer carries `join_answer.name_blocked`, set by the same check when it is written,
--       and again by a sweep whenever a list changes (`username_word` or `full_name_allow`, by the console or not).
--       Where a name is read for other players (`public_full_name`) a flagged one is not given, so the player shows by
--       username. The read runs no check: a ranking, the big screen and the results read one boolean a row.
-- No backfill: the column comes with a constant default (no table rewrite), and this file leaves the sweep pending, so
-- the lifecycle tick checks the answers stored before it, a page per transaction (about 9 minutes at 100,000 answers,
-- ADR-817). Until the sweep reaches it, a stored name that fails shows as it did under 0176.
-- The check works word by word (a `part` entry never matches across a space), skips the words of `full_name_allow`
-- (real names that hold a list entry: Ishaq, Butt, Yamashita; an Arabic one also with the article and nisba forms,
-- «الإسحاقي», «البلوطي»), and reads a name as a person would: compatibility forms
-- (full-width, Arabic presentation forms), accents, Persian and Urdu letters, and Cyrillic and Greek look-alikes are
-- folded first. Only the word lists: a name is never refused for being Arabic, short, a real person's name, or a username
-- an admin retired. The staff read (`staff_full_name`) is unchanged.
-- New, closed by default: tables `full_name_allow` and `full_name_recheck` (no grant); `join_answer.name_blocked` (the
-- API role keeps its table-wide SELECT and no write); internal functions `full_name_fold`, `full_name_blocked`,
-- `join_answer_name_flag` and `full_name_recheck_mark` (the triggers; no grant); one door, `name_flag_sweep`, for the
-- API's role (the lifecycle tick). Restated with the same signature, owner and grants, each diffed against its latest
-- definition: check_join_answers (as 0037, plus (1)), public_full_name and full_name_part (as 0109; the part now calls the
-- name once), admin_word_add and admin_word_remove (as 0120, plus the lists' advisory key). Nothing here writes points or XP, changes a
-- sign-in, a tenant rule or a redemption. 0176 and earlier untouched.
SET LOCAL lock_timeout = '10s';

-- ================================================================ the allow-list
-- Words of real names that hold a list entry, which the full-name check skips (a word is skipped whole: its `word` and its
-- `part` matches). An Arabic entry also covers the word with ال, بال, وال or لل before it and ي, يه or ه after it (folded:
-- ية reads يه, ة reads ه), so «اسحاق» covers «الإسحاقي» and «إسحاقية». Stored folded, letters only, as `username_word`.
-- Data, edited by a migration (no console page yet, ADR-817); usernames never read it.
CREATE TABLE full_name_allow (
  word       text PRIMARY KEY CHECK (word ~ '^[a-zء-غف-ي]{2,}$' AND word = username_fold(word)),
  language   text NOT NULL CHECK (language IN ('ar', 'en')),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE full_name_allow ENABLE ROW LEVEL SECURITY;
ALTER TABLE full_name_allow FORCE ROW LEVEL SECURITY;
REVOKE ALL ON full_name_allow FROM PUBLIC;

INSERT INTO full_name_allow (word, language) VALUES
  -- Arabic family names that hold a `part` entry: Ishaq (سحاق), Al-Balouti (لوطي), Al-Saksaki (سكس)
  ('اسحاق', 'ar'), ('بلوطي', 'ar'), ('سكسك', 'ar'),
  -- whole words that are also `word` entries
  ('butt', 'en'), ('dick', 'en'), ('poon', 'en'), ('kike', 'en'), ('quim', 'en'), ('cumming', 'en'),
  -- `part` entries inside a name
  ('hooker', 'en'), ('atwater', 'en'), ('wankhede', 'en'), ('wankel', 'en'), ('slutsky', 'en'),
  ('lipshitz', 'en'), ('shitaya', 'en'),
  ('yamashita', 'en'), ('kinoshita', 'en'), ('matsushita', 'en'), ('takeshita', 'en'), ('morishita', 'en'),
  ('oshita', 'en'), ('yoshitaka', 'en'), ('yoshito', 'en'), ('yoshitomo', 'en'), ('toshitaka', 'en'),
  ('harshit', 'en'), ('harshita', 'en'), ('ishita', 'en'), ('akshita', 'en'), ('rishita', 'en'), ('nishita', 'en'),
  ('ashita', 'en'), ('ashit', 'en'), ('shital', 'en'), ('dikshit', 'en'), ('kshitij', 'en'), ('kshiti', 'en'),
  ('pornchai', 'en'), ('pornthip', 'en'), ('pornsak', 'en'), ('pornpimol', 'en'), ('pornpan', 'en');

-- ================================================================ the check
-- A name as a person reads it, one space between words: the name other players see (`display_name_text`), compatibility
-- forms made plain (NFKC: full-width letters, Arabic presentation forms, ligatures), accents and Arabic marks and tatweel
-- dropped (NFD, then NFC again so a hamza stays on its letter), folded like a username (`username_fold`), then Persian and
-- Urdu letters, Arabic-Indic digits and the Cyrillic and Greek letters that look Latin made the letters the lists use.
-- Spaces, punctuation and symbols separate words; any other letter stays in its word and matches nothing. Internal; a
-- standard body with no SET clause, so it is inlined.
CREATE FUNCTION full_name_fold(name text) RETURNS text
  LANGUAGE sql IMMUTABLE
  RETURN btrim(regexp_replace(
    translate(
      username_fold(normalize(regexp_replace(normalize(normalize(coalesce(display_name_text(name), ''), NFKC), NFD),
        '[̀-ͯ҃-҉᪰-᫿᷀-᷿⃐-⃿︠-︯ؐ-ًؚ-ْ'
        'ٖ-ٰٟۖ-ۜ۟-۪ۤۧۨ-ۭـ]', '', 'g'), NFC)),
      'کڪیےېہەھۀٱۃ٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹авекмнорстухіјѕԁԛԝАВЕКМНОРСТУХІЈЅαβεηικνορτυχωΑΒΕΖΗΙΚΜΝΟΡΤΥΧıøłđħ',
      'ككيييههههاه01234567890123456789abekmhopctyxijsdqwabekmhopctyxijsabenikvoptuxwabezhikmnoptyxioldh'),
    '[\s\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E¡-¿×÷‐-‧‰-⁞←-⯿'
    '،؛؟٪-٭۔　-〿\U0001F000-\U0001FAFF]+', ' ', 'g'), ' ');
REVOKE ALL ON FUNCTION full_name_fold(text) FROM PUBLIC;

-- The word-list half of `username_blocked` (0016, 0118), word by word: a `word` entry matches a whole word (split at
-- digits, as a username is); a `part` entry matches inside one word, with its digits removed or read as letters (0 o,
-- 1 i, 3 e, 4 a, 5 s, 7 t), never across a space. A word of `full_name_allow` is skipped, and so is an Arabic one's
-- article or nisba form (one prefix of ال بال وال لل and one suffix of ي يه ه, each optional). Letters spelled out one by one
-- ("f u c k", "ك س") are read joined. PL/pgSQL with no SET clause (its callers are definers and the answer trigger, and
-- it runs per row in the recheck; docs/rules.md): the two list reads are each one plan kept per connection, and the
-- name is folded once, never once per list row.
CREATE FUNCTION full_name_blocked(name text) RETURNS boolean
  LANGUAGE plpgsql STABLE AS $$
DECLARE
  words   text[] := string_to_array(full_name_fold(name), ' ');
  allowed text[];
  tokens  text[] := '{}';
  parts   text[] := '{}';
  piece   text;
  bare    text;
  spelled text := '';
  joined  text;
  hit     boolean;
BEGIN
  IF words IS NULL OR words = '{""}' THEN
    RETURN false;
  END IF;
  -- The words the allow-list covers: as they are, or for an Arabic entry with one prefix and one suffix taken off.
  SELECT coalesce(array_agg(w), '{}') INTO allowed
  FROM unnest(ARRAY(SELECT DISTINCT regexp_replace(x, '[0-9]', '', 'g') FROM unnest(words) x)) w
  WHERE EXISTS (
    SELECT 1
    FROM unnest(ARRAY[w, regexp_replace(w, '^(بال|وال|لل|ال)', '')]) p,
         LATERAL (VALUES (p), (regexp_replace(p, 'ي$', '')), (regexp_replace(p, 'يه$', '')),
                         (regexp_replace(p, 'ه$', ''))) s(stem)
    JOIN full_name_allow a ON a.word = s.stem AND (s.stem = w OR a.language = 'ar'));
  FOREACH piece IN ARRAY words || ''::text LOOP
    bare := regexp_replace(piece, '[0-9]', '', 'g');
    IF char_length(piece) = 1 AND bare <> '' THEN
      spelled := spelled || bare;
      CONTINUE;
    END IF;
    IF char_length(spelled) >= 2 THEN
      tokens := tokens || spelled;
      parts := parts || spelled;
    END IF;
    spelled := '';
    IF bare = '' OR bare = ANY (allowed) THEN
      CONTINUE;
    END IF;
    tokens := tokens || regexp_split_to_array(piece, '[0-9]+');
    parts := parts || bare || regexp_replace(translate(piece, '013457', 'oieast'), '[0-9]', '', 'g');
  END LOOP;
  -- One string for the `part` entries: a list word holds no space, so a match never spans two forms.
  joined := array_to_string(parts, ' ');
  SELECT EXISTS (SELECT 1 FROM username_word u WHERE u.word = ANY (tokens) AND u.match = 'word')
      OR EXISTS (SELECT 1 FROM username_word u
                 WHERE u.match = 'part' AND position(u.word IN joined) > 0)
  INTO hit;
  RETURN hit;
END $$;
REVOKE ALL ON FUNCTION full_name_blocked(text) FROM PUBLIC;

-- ================================================================ the stored flag
-- false for every row the moment the column exists: a constant default is stored in the catalog, so the table is not
-- rewritten and the ACCESS EXCLUSIVE lock is held for a catalog change only. The stored answers are then checked by the
-- sweep (marked pending below), never in this transaction.
ALTER TABLE join_answer ADD COLUMN name_blocked boolean NOT NULL DEFAULT false;

-- Sets the flag of a Full name answer as it is written, by the same check. It takes the word lists' advisory key shared,
-- so an answer written while the console changes the lists waits for that change and is checked against the lists as
-- they are after it (a word added during a join is not missed by the recheck). Other answers keep false. VOLATILE
-- (a trigger), so the check reads the lists as committed after the wait. Internal.
CREATE FUNCTION join_answer_name_flag() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM event_join_field f WHERE f.id = NEW.field_id AND f.kind = 'full_name') THEN
    PERFORM pg_advisory_xact_lock_shared(hashtextextended('username_word', 0));
    NEW.name_blocked := full_name_blocked(NEW.value);
  ELSE
    NEW.name_blocked := false;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION join_answer_name_flag() FROM PUBLIC;
CREATE TRIGGER join_answer_name_flag BEFORE INSERT OR UPDATE OF value ON join_answer
  FOR EACH ROW EXECUTE FUNCTION join_answer_name_flag();

-- ================================================================ (1) at the join
-- As 0037, plus: an answer to the Full name field that `full_name_blocked` refuses raises JA422 with DETAIL
-- `name:<field id>` (the shape checks come first, so a malformed answer still says `field:`).
CREATE OR REPLACE FUNCTION check_join_answers(target uuid, answers jsonb) RETURNS void
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  item record;
  missing uuid;
BEGIN
  IF jsonb_typeof(answers) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'join answers must be an object' USING ERRCODE = 'JA422', DETAIL = 'shape';
  END IF;
  FOR item IN SELECT a.key, a.value FROM jsonb_each(answers) a LOOP
    IF NOT EXISTS (SELECT 1 FROM event_join_field f WHERE f.event_id = target AND f.id::text = item.key)
       OR jsonb_typeof(item.value) <> 'string'
       OR length(item.value #>> '{}') NOT BETWEEN 1 AND 200
       OR item.value #>> '{}' <> btrim(item.value #>> '{}')
       OR item.value #>> '{}' ~ '[[:cntrl:]]'
       OR EXISTS (SELECT 1 FROM event_join_field f
                  WHERE f.event_id = target AND f.id::text = item.key AND f.options IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(f.options) o
                                    WHERE o ->> 'id' = item.value #>> '{}')) THEN
      RAISE EXCEPTION 'a join answer is not valid' USING ERRCODE = 'JA422', DETAIL = 'field:' || item.key;
    END IF;
    IF EXISTS (SELECT 1 FROM event_join_field f
               WHERE f.event_id = target AND f.id::text = item.key AND f.kind = 'full_name')
       AND full_name_blocked(item.value #>> '{}') THEN
      RAISE EXCEPTION 'a full name holds a listed word' USING ERRCODE = 'JA422', DETAIL = 'name:' || item.key;
    END IF;
  END LOOP;
  SELECT f.id INTO missing FROM event_join_field f
  WHERE f.event_id = target AND f.required AND NOT answers ? f.id::text
  ORDER BY f.position, f.id LIMIT 1;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'a required join answer is missing' USING ERRCODE = 'JA422', DETAIL = 'field:' || missing;
  END IF;
END $$;

-- ================================================================ (2) where other players read a name
-- As 0109, plus: a flagged answer is not given, so the player shows by username. One boolean, no check.
CREATE OR REPLACE FUNCTION public_full_name(target_enrollment uuid) RETURNS text
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT display_name_text(a.value)
  FROM enrollment n
  JOIN event e ON e.id = n.event_id
  JOIN event_join_field f ON f.event_id = e.id AND f.kind = 'full_name'
  JOIN join_answer a ON a.enrollment_id = n.id AND a.field_id = f.id
  WHERE n.id = target_enrollment AND n.status = 'active'
    AND e.name_audience = 'everyone' AND e.name_display <> 'username'
    AND n.name_notice = 'everyone'
    AND NOT a.name_blocked
$$;

-- As 0109, with `public_full_name` called once: a null name is stripped, so the part is `{}` as before.
CREATE OR REPLACE FUNCTION full_name_part(target_enrollment uuid) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('fullName', public_full_name(target_enrollment)))
$$;

-- ================================================================ the recheck when the lists change
-- A list change marks the one sweep row pending from the start; the sweep then checks every stored Full name answer
-- again in pages of the answer's key and sets each flag to what the check says now (an added word hides names, a
-- removed one shows them again). The lifecycle tick runs it, a page per transaction (`src/join/name-recheck.ts`); a list
-- door runs no page itself. A change during a sweep starts it again from the first page. One row, no grant.
CREATE TABLE full_name_recheck (
  id               boolean PRIMARY KEY DEFAULT true CHECK (id),
  pending          boolean NOT NULL DEFAULT false,
  after_enrollment uuid,
  after_field      uuid,
  changed_at       timestamptz,
  CHECK ((after_enrollment IS NULL) = (after_field IS NULL))
);
ALTER TABLE full_name_recheck ENABLE ROW LEVEL SECURITY;
ALTER TABLE full_name_recheck FORCE ROW LEVEL SECURITY;
REVOKE ALL ON full_name_recheck FROM PUBLIC;
-- Pending from the start: the tick's first run begins checking the answers stored before this file.
INSERT INTO full_name_recheck (pending, changed_at) VALUES (true, now());

-- One page of the sweep: the next `batch` Full name answers by key (at most 2,000), each flag set to the check's answer.
-- Answers how many answers it checked: 0 when nothing is pending; fewer than `batch` ends the sweep. Locks the sweep row
-- `FOR UPDATE SKIP LOCKED` (a second tick skips; a list change waits for the page), then only the answers whose flag
-- changes. Reads across organizers on purpose (a sweep of one platform-wide list, rules.md). For the API's role: the
-- lifecycle tick.
CREATE FUNCTION name_flag_sweep(batch integer) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  state       full_name_recheck;
  size        integer := least(greatest(coalesce(batch, 2000), 1), 2000);
  enrollments uuid[];
  fields      uuid[];
  seen        integer;
BEGIN
  SELECT r.* INTO state FROM full_name_recheck r WHERE r.pending FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;
  SELECT array_agg(p.enrollment_id ORDER BY p.enrollment_id, p.field_id),
         array_agg(p.field_id ORDER BY p.enrollment_id, p.field_id)
  INTO enrollments, fields
  FROM (SELECT a.enrollment_id, a.field_id
        FROM join_answer a JOIN event_join_field f ON f.id = a.field_id AND f.kind = 'full_name'
        WHERE state.after_enrollment IS NULL
           OR (a.enrollment_id, a.field_id) > (state.after_enrollment, state.after_field)
        ORDER BY a.enrollment_id, a.field_id
        LIMIT size) p;
  seen := coalesce(cardinality(enrollments), 0);
  UPDATE join_answer a SET name_blocked = NOT a.name_blocked
  FROM unnest(enrollments, fields) k(enrollment_id, field_id)
  WHERE a.enrollment_id = k.enrollment_id AND a.field_id = k.field_id
    AND a.name_blocked IS DISTINCT FROM full_name_blocked(a.value);
  UPDATE full_name_recheck r
  SET pending = seen = size,
      after_enrollment = CASE WHEN seen = size THEN enrollments[seen] END,
      after_field = CASE WHEN seen = size THEN fields[seen] END;
  RETURN seen;
END $$;
REVOKE ALL ON FUNCTION name_flag_sweep(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION name_flag_sweep(integer) TO questify_app;

-- Any change to either list, by a console door, a migration or by hand, marks the sweep pending from the first page,
-- once a statement (a statement that changed no row marks it too: a needless sweep, never a missed one). It takes the
-- lists' advisory key exclusive, so an answer written meanwhile waits for the change (see the answer trigger) and one
-- written before it has committed first and is seen by the sweep. Internal (the trigger).
CREATE FUNCTION full_name_recheck_mark() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('username_word', 0));
  UPDATE full_name_recheck r SET pending = true, after_enrollment = NULL, after_field = NULL, changed_at = now();
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION full_name_recheck_mark() FROM PUBLIC;
CREATE TRIGGER username_word_recheck AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON username_word
  FOR EACH STATEMENT EXECUTE FUNCTION full_name_recheck_mark();
CREATE TRIGGER full_name_allow_recheck AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON full_name_allow
  FOR EACH STATEMENT EXECUTE FUNCTION full_name_recheck_mark();

-- Both list doors take the lists' advisory key exclusive first, so list changes run one after the other and an answer
-- written meanwhile waits for the change; the list trigger then marks the sweep. Lock order: the advisory key, the list
-- row, the sweep row (waiting for a tick page in flight: 2,000 answers, under 0.9 s), never an answer. A join holds the
-- key shared from its answer insert to its commit and never waits on a list door's other locks, so the two never cycle.
-- A join so waits at most for one tick page plus the longest join in flight (ADR-817).

-- As 0120, plus the advisory key.
CREATE OR REPLACE FUNCTION admin_word_add(new_word text, word_match text, word_language text, request uuid) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me     uuid := console_admin();
  folded text := username_fold(btrim(coalesce(new_word, '')));
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('username_word', 0));
  BEGIN
    INSERT INTO username_word (word, match, language) VALUES (folded, word_match, word_language);
  EXCEPTION
    WHEN unique_violation THEN
      RETURN 'exists';
    WHEN check_violation OR not_null_violation THEN
      RAISE EXCEPTION 'not a word for the lists' USING ERRCODE = 'WL400';
  END;
  INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, after, request_id)
  VALUES ('admin', me, 'username_word.add', 'username_word', folded,
          jsonb_build_object('match', word_match, 'language', word_language), request);
  RETURN 'added';
END $$;

-- As 0120, plus the advisory key.
CREATE OR REPLACE FUNCTION admin_word_remove(old_word text, request uuid) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me   uuid := console_admin();
  gone username_word;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('username_word', 0));
  DELETE FROM username_word w WHERE w.word = username_fold(btrim(coalesce(old_word, ''))) RETURNING w.* INTO gone;
  IF gone.id IS NULL THEN
    RETURN 'not_found';
  END IF;
  INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, before, request_id)
  VALUES ('admin', me, 'username_word.remove', 'username_word', gone.word,
          jsonb_build_object('match', gone.match, 'language', gone.language), request);
  RETURN 'removed';
END $$;

-- The definers read these tables as the migration owner, which must bypass their forced row-level security (as 0016).
DO $$
BEGIN
  IF (SELECT count(*) FROM full_name_allow) = 0 OR (SELECT count(*) FROM full_name_recheck) = 0 THEN
    RAISE EXCEPTION 'the migration owner cannot read full_name_allow (row-level security is forced): grant it BYPASSRLS';
  END IF;
END $$;
