-- T-406: the daily challenge (three questions) and the daily word, their banks, the schedule by period, the cadence
-- and a sponsor's name (ADR-306 to ADR-312; plan docs/plans/2026-10-27-t-406-daily.md). Both games pay XP only
-- (xp_entry source `daily`) in the door that finishes a play, and a finished play keeps the Questify daily streak
-- (questify_streak_day, a second writer beside 0068's trigger). No points, no gems, no event ledger. Deny by default:
-- every new table keeps row-level security forced and no grant; every function is closed to PUBLIC in the statement
-- group that creates it and only the doors are granted to the API role. Deployed migrations and 0057 to 0068 untouched.
SET LOCAL lock_timeout = '10s';
-- Every existing table this migration alters or references, up front, in live-path order and at the strongest mode a
-- later statement needs (the T-404 MAJOR-1 lesson). xp_entry first: every live path that reaches player_xp touched
-- xp_entry before it (the sync's unlocked pre-check, a completion's xp_credit). player before player_xp: sign-up
-- inserts the player before its player_xp row, and no writer of player touches xp_entry. Never ledger_entry,
-- enrollment, event, platform_setting, questify_streak_day, staff_user or audit_log: so `set_by` and `created_by` are
-- plain ids (the audit log names the admin too).
LOCK TABLE xp_entry IN ACCESS EXCLUSIVE MODE;
LOCK TABLE player IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE player_xp IN SHARE ROW EXCLUSIVE MODE;

-- ================================================================ text and letters (internal, ADR-308, ADR-310)
-- A trimmed text of 1 to `top` characters with no control or bidi character (0066's rule).
CREATE FUNCTION daily_text_ok(t text, top integer) RETURNS boolean
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp
  RETURN t IS NOT NULL AND t = btrim(t) AND char_length(t) BETWEEN 1 AND top
         AND t !~ '[\x01-\x1F\x7F-\x9F\u2028\u2029\u202A-\u202E\u2066-\u2069]';
REVOKE ALL ON FUNCTION daily_text_ok(text, integer) FROM PUBLIC;

-- 2 to 4 options, each a trimmed text of 1 to 120 characters.
CREATE FUNCTION daily_options_ok(o text[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT o IS NOT NULL AND array_ndims(o) = 1 AND cardinality(o) BETWEEN 2 AND 4
         AND NOT EXISTS (SELECT 1 FROM unnest(o) x WHERE NOT coalesce(daily_text_ok(x, 120), false))
$$;
REVOKE ALL ON FUNCTION daily_options_ok(text[]) FROM PUBLIC;

-- The letters of each language, one key each (MINOR-6): English a to z; Arabic the 28 letters plus ة ى ء ؤ ئ, never
-- أ إ آ ٱ (folded to ا) or the tatweel. packages/shared/src/daily/letters.ts holds the same lists (a DB test compares).
CREATE FUNCTION daily_letters(lang text) RETURNS text
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp
  RETURN CASE lang WHEN 'en' THEN 'abcdefghijklmnopqrstuvwxyz'
                   WHEN 'ar' THEN 'ابتثجحخدذرزسشصضطظعغفقكلمنهويةىءؤئ' END;
REVOKE ALL ON FUNCTION daily_letters(text) FROM PUBLIC;

-- A word as the team wrote it, for the reveal: trimmed; English lower-cased; Arabic without diacritics (U+064B to
-- U+065F, U+0670) and the tatweel, its hamza kept.
CREATE FUNCTION daily_display(lang text, t text) RETURNS text
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp
  RETURN CASE lang WHEN 'en' THEN lower(btrim(t))
                   WHEN 'ar' THEN regexp_replace(btrim(t), '[\u064B-\u065F\u0670\u0640]', '', 'g') END;
REVOKE ALL ON FUNCTION daily_display(text, text) FROM PUBLIC;

-- The folded form a guess is compared in: the display form with أ إ آ ٱ folded to ا (ADR-310). Not checked.
CREATE FUNCTION daily_fold(lang text, t text) RETURNS text
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp
  RETURN CASE lang WHEN 'ar' THEN translate(daily_display(lang, t), 'أإآٱ', 'اااا') ELSE daily_display(lang, t) END;
REVOKE ALL ON FUNCTION daily_fold(text, text) FROM PUBLIC;

-- The normalized word: the folded form when it is exactly five letters of the language, else NULL.
CREATE FUNCTION word_norm(lang text, t text) RETURNS text
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp
  RETURN CASE WHEN daily_fold(lang, t) ~ ('^[' || daily_letters(lang) || ']{5}$') THEN daily_fold(lang, t) END;
REVOKE ALL ON FUNCTION word_norm(text, text) FROM PUBLIC;

-- A guess's marks against the word, both normalized: 2 right place, 1 elsewhere, 0 absent. Two passes: the exact
-- letters first, then "elsewhere" only while the word keeps an unmatched copy of that letter.
CREATE FUNCTION daily_marks(word text, guess text) RETURNS text
  LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE
  w     text[] := string_to_array(word, NULL);
  g     text[] := string_to_array(guess, NULL);
  marks text[] := array_fill('0'::text, ARRAY[5]);
  spare text[] := '{}';
  hit   integer;
BEGIN
  FOR i IN 1..5 LOOP
    IF g[i] = w[i] THEN
      marks[i] := '2';
    ELSE
      spare := spare || w[i];
    END IF;
  END LOOP;
  FOR i IN 1..5 LOOP
    IF marks[i] = '0' THEN
      hit := array_position(spare, g[i]);
      IF hit IS NOT NULL THEN
        marks[i] := '1';
        spare := spare[1:hit - 1] || spare[hit + 1:];
      END IF;
    END IF;
  END LOOP;
  RETURN array_to_string(marks, '');
END $$;
REVOKE ALL ON FUNCTION daily_marks(text, text) FROM PUBLIC;

-- ================================================================ the cadence (ADR-307)
-- The cadence of a kind on a day is the row with the greatest from_day on or before it. A change is written for
-- tomorrow only; a row whose day has come is fixed for every role (the trigger below, created after the seed).
CREATE TABLE daily_cadence (
  kind       text NOT NULL CHECK (kind IN ('challenge', 'word')),
  from_day   date NOT NULL,
  cadence    text NOT NULL CHECK (cadence IN ('daily', 'weekly')),
  set_by     uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, from_day)
);
ALTER TABLE daily_cadence ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_cadence FORCE ROW LEVEL SECURITY;
REVOKE ALL ON daily_cadence FROM PUBLIC, questify_app;
-- Weekly at launch (ADR-099) from a Sunday.
INSERT INTO daily_cadence (kind, from_day, cadence) VALUES ('challenge', '2026-01-04', 'weekly'),
                                                           ('word', '2026-01-04', 'weekly');

-- Refuses any write of a row whose day has come (today's Questify day by the clock, not the transaction's start), the
-- owner included, so a change committing after 04:00 never lands on a day that has come.
CREATE FUNCTION daily_cadence_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  today date := questify_day(clock_timestamp());
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'the cadence history can never be removed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP <> 'INSERT' THEN
    IF OLD.from_day <= today THEN
      RAISE EXCEPTION 'a cadence whose day has come is fixed' USING ERRCODE = 'DK409', DETAIL = 'started';
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    IF NEW.from_day <= today THEN
      RAISE EXCEPTION 'a cadence whose day has come is fixed' USING ERRCODE = 'DK409', DETAIL = 'started';
    END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION daily_cadence_guard() FROM PUBLIC;
CREATE TRIGGER daily_cadence_guard BEFORE INSERT OR UPDATE OR DELETE ON daily_cadence
  FOR EACH ROW EXECUTE FUNCTION daily_cadence_guard();
CREATE TRIGGER daily_cadence_no_truncate BEFORE TRUNCATE ON daily_cadence
  FOR EACH STATEMENT EXECUTE FUNCTION daily_cadence_guard();
ALTER TABLE daily_cadence ENABLE ALWAYS TRIGGER daily_cadence_guard;
ALTER TABLE daily_cadence ENABLE ALWAYS TRIGGER daily_cadence_no_truncate;

-- The period a day falls in: daily → that day; weekly → Sunday to Saturday, cut by the governing row's first day and
-- by the next row's (a switch mid-week ends the running week the day before, or gives a short first week). NULL
-- before the first row. Internal.
CREATE FUNCTION daily_period(k text, day date, OUT starts_on date, OUT ends_on date)
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN g.cadence = 'daily' THEN day
              ELSE greatest(day - extract(dow FROM day)::integer, g.from_day) END,
         CASE WHEN g.cadence = 'daily' THEN day
              ELSE least(day - extract(dow FROM day)::integer + 6,
                         (SELECT min(n.from_day) - 1 FROM daily_cadence n WHERE n.kind = k AND n.from_day > day)) END
  FROM (SELECT c.cadence, c.from_day FROM daily_cadence c WHERE c.kind = k AND c.from_day <= day
        ORDER BY c.from_day DESC LIMIT 1) g
$$;
REVOKE ALL ON FUNCTION daily_period(text, date) FROM PUBLIC;

-- Whether `day` is the first day of its period under the cadence as it stands. Read without a lock (content doors
-- never lock daily_cadence, so a content save never waits on the cadence door). Internal.
CREATE FUNCTION daily_period_start(k text, day date) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT p.starts_on = day FROM daily_period(k, day) p), false)
$$;
REVOKE ALL ON FUNCTION daily_period_start(text, date) FROM PUBLIC;

-- ================================================================ the banks and the schedule (ADR-308)
-- The question bank, both languages required. Frozen by trigger once a challenge holding it has started.
CREATE TABLE daily_question (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_ar  text NOT NULL CHECK (daily_text_ok(prompt_ar, 300)),
  prompt_en  text NOT NULL CHECK (daily_text_ok(prompt_en, 300)),
  options_ar text[] NOT NULL CHECK (daily_options_ok(options_ar)),
  options_en text[] NOT NULL CHECK (daily_options_ok(options_en)),
  answer     smallint NOT NULL,
  status     text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'retired')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (cardinality(options_ar) = cardinality(options_en)),
  CHECK (answer BETWEEN 1 AND cardinality(options_en))
);
ALTER TABLE daily_question ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_question FORCE ROW LEVEL SECURITY;
REVOKE ALL ON daily_question FROM PUBLIC, questify_app;

-- One period's challenge, keyed by the period's first day, with an optional sponsor name in both languages (ADR-311).
CREATE TABLE daily_challenge (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  starts_on  date NOT NULL UNIQUE,
  sponsor_ar text CHECK (sponsor_ar IS NULL OR daily_text_ok(sponsor_ar, 60)),
  sponsor_en text CHECK (sponsor_en IS NULL OR daily_text_ok(sponsor_en, 60)),
  set_by     uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((sponsor_ar IS NULL) = (sponsor_en IS NULL))
);
ALTER TABLE daily_challenge ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_challenge FORCE ROW LEVEL SECURITY;
REVOKE ALL ON daily_challenge FROM PUBLIC, questify_app;

-- Its three questions, written together by daily_challenge_set; a question is used once ever.
CREATE TABLE daily_challenge_question (
  challenge_id bigint NOT NULL REFERENCES daily_challenge (id) ON DELETE CASCADE,
  position     smallint NOT NULL CHECK (position BETWEEN 1 AND 3),
  question_id  uuid NOT NULL UNIQUE REFERENCES daily_question (id) ON DELETE RESTRICT,
  PRIMARY KEY (challenge_id, position)
);
ALTER TABLE daily_challenge_question ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_challenge_question FORCE ROW LEVEL SECURITY;
REVOKE ALL ON daily_challenge_question FROM PUBLIC, questify_app;

-- One period's word per language, used once ever per language. Never updated in place: a replacement deletes the row
-- and inserts a new one, so a new id tells a player door the word changed (MAJOR-1).
CREATE TABLE daily_word (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  language   text NOT NULL CHECK (language IN ('ar', 'en')),
  starts_on  date NOT NULL,
  word       text NOT NULL,
  display    text NOT NULL CHECK (daily_text_ok(display, 40)),
  set_by     uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (language, starts_on),
  UNIQUE (language, word),
  CHECK (word_norm(language, display) IS NOT DISTINCT FROM word)
);
ALTER TABLE daily_word ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_word FORCE ROW LEVEL SECURITY;
REVOKE ALL ON daily_word FROM PUBLIC, questify_app;

-- The valid guesses per language (a guess is valid when listed or when it is the period's own word).
CREATE TABLE word_guess_list (
  language text NOT NULL CHECK (language IN ('ar', 'en')),
  word     text NOT NULL,
  PRIMARY KEY (language, word),
  CHECK (word_norm(language, word) IS NOT DISTINCT FROM word)
);
ALTER TABLE word_guess_list ENABLE ROW LEVEL SECURITY;
ALTER TABLE word_guess_list FORCE ROW LEVEL SECURITY;
REVOKE ALL ON word_guess_list FROM PUBLIC, questify_app;

-- ================================================================ plays and finishes
-- A player's play of one period's content, insert-only; one word game per period whatever the language. Its foreign
-- key to player adds no lock (the door holds that row FOR KEY SHARE). No foreign key to player_xp, by design: the door
-- would hold its KEY SHARE and later need player_xp FOR UPDATE, and two doors of one player finishing at once would
-- each wait on the other's KEY SHARE. The doors derive player_id from the caller.
CREATE TABLE daily_play (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  player_id    uuid NOT NULL REFERENCES player (id),
  kind         text NOT NULL CHECK (kind IN ('challenge', 'word')),
  starts_on    date NOT NULL,
  challenge_id bigint REFERENCES daily_challenge (id),
  word_id      bigint REFERENCES daily_word (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (player_id, kind, starts_on),
  UNIQUE (id, player_id),
  CHECK ((kind = 'challenge') = (challenge_id IS NOT NULL) AND (kind = 'word') = (word_id IS NOT NULL))
);
CREATE INDEX daily_play_challenge_idx ON daily_play (challenge_id) WHERE challenge_id IS NOT NULL;
CREATE INDEX daily_play_word_idx ON daily_play (word_id) WHERE word_id IS NOT NULL;
ALTER TABLE daily_play ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_play FORCE ROW LEVEL SECURITY;
REVOKE ALL ON daily_play FROM PUBLIC, questify_app;

-- Each answer is final; the natural key is the replay key.
CREATE TABLE daily_answer (
  play_id    bigint NOT NULL REFERENCES daily_play (id),
  position   smallint NOT NULL CHECK (position BETWEEN 1 AND 3),
  choice     smallint NOT NULL CHECK (choice BETWEEN 1 AND 4),
  correct    boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (play_id, position)
);
ALTER TABLE daily_answer ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_answer FORCE ROW LEVEL SECURITY;
REVOKE ALL ON daily_answer FROM PUBLIC, questify_app;

-- Each guess, normalized, with its marks (2 right place, 1 elsewhere, 0 absent).
CREATE TABLE daily_guess (
  play_id    bigint NOT NULL REFERENCES daily_play (id),
  attempt    smallint NOT NULL CHECK (attempt BETWEEN 1 AND 6),
  guess      text NOT NULL,
  marks      text NOT NULL CHECK (marks ~ '^[012]{5}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (play_id, attempt)
);
ALTER TABLE daily_guess ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_guess FORCE ROW LEVEL SECURITY;
REVOKE ALL ON daily_guess FROM PUBLIC, questify_app;

-- One per play, kept on the erasure tombstone like xp_entry: XP is once per play. Its key to player_xp is checked
-- after the door holds that row FOR UPDATE, so it adds no lock. The field ranges keep every payout inside 0 to 1000.
CREATE TABLE daily_finish (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  play_id    bigint NOT NULL UNIQUE,
  player_id  uuid NOT NULL REFERENCES player_xp (player_id),
  kind       text NOT NULL CHECK (kind IN ('challenge', 'word')),
  solved     boolean,
  correct    smallint CHECK (correct BETWEEN 0 AND 3),
  xp         integer NOT NULL CHECK (xp BETWEEN 0 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, player_id),
  FOREIGN KEY (play_id, player_id) REFERENCES daily_play (id, player_id),
  CHECK ((kind = 'challenge' AND correct IS NOT NULL AND solved IS NULL)
         OR (kind = 'word' AND solved IS NOT NULL AND correct IS NULL))
);
ALTER TABLE daily_finish ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_finish FORCE ROW LEVEL SECURITY;
REVOKE ALL ON daily_finish FROM PUBLIC, questify_app;

-- The four play tables are append-only for every role, the owner included.
CREATE FUNCTION daily_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'daily plays can never be changed or removed' USING ERRCODE = 'insufficient_privilege';
END $$;
REVOKE ALL ON FUNCTION daily_append_only() FROM PUBLIC;
CREATE TRIGGER daily_play_no_update_or_delete BEFORE UPDATE OR DELETE ON daily_play
  FOR EACH ROW EXECUTE FUNCTION daily_append_only();
CREATE TRIGGER daily_play_no_truncate BEFORE TRUNCATE ON daily_play
  FOR EACH STATEMENT EXECUTE FUNCTION daily_append_only();
CREATE TRIGGER daily_answer_no_update_or_delete BEFORE UPDATE OR DELETE ON daily_answer
  FOR EACH ROW EXECUTE FUNCTION daily_append_only();
CREATE TRIGGER daily_answer_no_truncate BEFORE TRUNCATE ON daily_answer
  FOR EACH STATEMENT EXECUTE FUNCTION daily_append_only();
CREATE TRIGGER daily_guess_no_update_or_delete BEFORE UPDATE OR DELETE ON daily_guess
  FOR EACH ROW EXECUTE FUNCTION daily_append_only();
CREATE TRIGGER daily_guess_no_truncate BEFORE TRUNCATE ON daily_guess
  FOR EACH STATEMENT EXECUTE FUNCTION daily_append_only();
CREATE TRIGGER daily_finish_no_update_or_delete BEFORE UPDATE OR DELETE ON daily_finish
  FOR EACH ROW EXECUTE FUNCTION daily_append_only();
CREATE TRIGGER daily_finish_no_truncate BEFORE TRUNCATE ON daily_finish
  FOR EACH STATEMENT EXECUTE FUNCTION daily_append_only();
ALTER TABLE daily_play ENABLE ALWAYS TRIGGER daily_play_no_update_or_delete;
ALTER TABLE daily_play ENABLE ALWAYS TRIGGER daily_play_no_truncate;
ALTER TABLE daily_answer ENABLE ALWAYS TRIGGER daily_answer_no_update_or_delete;
ALTER TABLE daily_answer ENABLE ALWAYS TRIGGER daily_answer_no_truncate;
ALTER TABLE daily_guess ENABLE ALWAYS TRIGGER daily_guess_no_update_or_delete;
ALTER TABLE daily_guess ENABLE ALWAYS TRIGGER daily_guess_no_truncate;
ALTER TABLE daily_finish ENABLE ALWAYS TRIGGER daily_finish_no_update_or_delete;
ALTER TABLE daily_finish ENABLE ALWAYS TRIGGER daily_finish_no_truncate;

-- ================================================================ started content is frozen (ADR-308)
-- Content stranded on a day that is no longer a period start, with no plays, may be cleared whatever its day
-- (MINOR-7). Internal.
CREATE FUNCTION daily_clearable(k text, day date, content bigint) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT NOT daily_period_start(k, day)
         AND NOT EXISTS (SELECT 1 FROM daily_play y
                         WHERE (k = 'challenge' AND y.challenge_id = content) OR (k = 'word' AND y.word_id = content))
$$;
REVOKE ALL ON FUNCTION daily_clearable(text, date, bigint) FROM PUBLIC;

-- A challenge or a word whose period has started (by the clock) can be neither written nor changed, the owner
-- included; a word is never updated at all; the one DELETE let through is daily_clearable's.
CREATE FUNCTION daily_content_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  today date := questify_day(clock_timestamp());
  k     text := CASE TG_TABLE_NAME WHEN 'daily_word' THEN 'word' ELSE 'challenge' END;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'daily content is removed row by row' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' AND k = 'word' THEN
    RAISE EXCEPTION 'a daily word is replaced, never changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP <> 'INSERT' THEN
    IF OLD.starts_on <= today AND NOT (TG_OP = 'DELETE' AND daily_clearable(k, OLD.starts_on, OLD.id)) THEN
      RAISE EXCEPTION 'started content is fixed' USING ERRCODE = 'DK409', DETAIL = 'started';
    END IF;
  END IF;
  IF TG_OP <> 'DELETE' THEN
    IF NEW.starts_on <= today THEN
      RAISE EXCEPTION 'started content is fixed' USING ERRCODE = 'DK409', DETAIL = 'started';
    END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION daily_content_guard() FROM PUBLIC;
CREATE TRIGGER daily_challenge_guard BEFORE INSERT OR UPDATE OR DELETE ON daily_challenge
  FOR EACH ROW EXECUTE FUNCTION daily_content_guard();
CREATE TRIGGER daily_challenge_no_truncate BEFORE TRUNCATE ON daily_challenge
  FOR EACH STATEMENT EXECUTE FUNCTION daily_content_guard();
CREATE TRIGGER daily_word_guard BEFORE INSERT OR UPDATE OR DELETE ON daily_word
  FOR EACH ROW EXECUTE FUNCTION daily_content_guard();
CREATE TRIGGER daily_word_no_truncate BEFORE TRUNCATE ON daily_word
  FOR EACH STATEMENT EXECUTE FUNCTION daily_content_guard();
ALTER TABLE daily_challenge ENABLE ALWAYS TRIGGER daily_challenge_guard;
ALTER TABLE daily_challenge ENABLE ALWAYS TRIGGER daily_challenge_no_truncate;
ALTER TABLE daily_word ENABLE ALWAYS TRIGGER daily_word_guard;
ALTER TABLE daily_word ENABLE ALWAYS TRIGGER daily_word_no_truncate;

-- A challenge's question rows are replaced, never updated, and frozen with their challenge; a cascade from a cleared
-- challenge finds its parent gone and passes.
CREATE FUNCTION daily_slot_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  owner_day date;
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'daily content is removed row by row' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'a challenge''s questions are replaced, never changed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT c.starts_on INTO owner_day FROM daily_challenge c
  WHERE c.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.challenge_id ELSE NEW.challenge_id END;
  IF owner_day <= questify_day(clock_timestamp()) THEN
    RAISE EXCEPTION 'started content is fixed' USING ERRCODE = 'DK409', DETAIL = 'started';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
REVOKE ALL ON FUNCTION daily_slot_guard() FROM PUBLIC;
CREATE TRIGGER daily_challenge_question_guard BEFORE INSERT OR UPDATE OR DELETE ON daily_challenge_question
  FOR EACH ROW EXECUTE FUNCTION daily_slot_guard();
CREATE TRIGGER daily_challenge_question_no_truncate BEFORE TRUNCATE ON daily_challenge_question
  FOR EACH STATEMENT EXECUTE FUNCTION daily_slot_guard();
ALTER TABLE daily_challenge_question ENABLE ALWAYS TRIGGER daily_challenge_question_guard;
ALTER TABLE daily_challenge_question ENABLE ALWAYS TRIGGER daily_challenge_question_no_truncate;

-- A question held by a started challenge is frozen, the owner included.
CREATE FUNCTION daily_question_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'daily content is removed row by row' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF EXISTS (SELECT 1 FROM daily_challenge_question x JOIN daily_challenge c ON c.id = x.challenge_id
             WHERE x.question_id = OLD.id AND c.starts_on <= questify_day(clock_timestamp())) THEN
    RAISE EXCEPTION 'started content is fixed' USING ERRCODE = 'DK409', DETAIL = 'started';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
REVOKE ALL ON FUNCTION daily_question_guard() FROM PUBLIC;
CREATE TRIGGER daily_question_guard BEFORE UPDATE OR DELETE ON daily_question
  FOR EACH ROW EXECUTE FUNCTION daily_question_guard();
CREATE TRIGGER daily_question_no_truncate BEFORE TRUNCATE ON daily_question
  FOR EACH STATEMENT EXECUTE FUNCTION daily_question_guard();
ALTER TABLE daily_question ENABLE ALWAYS TRIGGER daily_question_guard;
ALTER TABLE daily_question ENABLE ALWAYS TRIGGER daily_question_no_truncate;

-- A challenge has exactly three questions at commit (deferred, so the set door may replace them in one group). A
-- definer: a deferred trigger fires at COMMIT, outside the door, as the API role.
CREATE FUNCTION daily_challenge_three() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  target bigint;
BEGIN
  IF TG_TABLE_NAME = 'daily_challenge' THEN
    target := NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    target := OLD.challenge_id;
  ELSE
    target := NEW.challenge_id;
  END IF;
  IF EXISTS (SELECT 1 FROM daily_challenge c WHERE c.id = target)
     AND (SELECT count(*) FROM daily_challenge_question x WHERE x.challenge_id = target) <> 3 THEN
    RAISE EXCEPTION 'a daily challenge has exactly three questions' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION daily_challenge_three() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER daily_challenge_three AFTER INSERT ON daily_challenge
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION daily_challenge_three();
CREATE CONSTRAINT TRIGGER daily_challenge_question_three AFTER INSERT OR DELETE ON daily_challenge_question
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION daily_challenge_three();
ALTER TABLE daily_challenge ENABLE ALWAYS TRIGGER daily_challenge_three;
ALTER TABLE daily_challenge_question ENABLE ALWAYS TRIGGER daily_challenge_question_three;

-- ================================================================ the XP row of a finish (ADR-309)
-- quest, removal, questify and streak keep 0068's shape; a daily entry pays once per finish of the same player, has no
-- ledger entry or event quest, and reverses nothing. A finish with 0 XP writes no entry.
ALTER TABLE xp_entry
  ADD COLUMN daily_finish_id bigint UNIQUE,
  ADD CONSTRAINT xp_entry_daily_finish_fkey FOREIGN KEY (daily_finish_id, player_id)
    REFERENCES daily_finish (id, player_id),
  DROP CONSTRAINT xp_entry_shape,
  ADD CONSTRAINT xp_entry_shape CHECK (
    (source = 'quest' AND delta > 0 AND reverses IS NULL AND ledger_entry_id IS NOT NULL AND quest_id IS NOT NULL
     AND questify_award_id IS NULL AND streak_reward_id IS NULL AND daily_finish_id IS NULL)
    OR (source = 'removal' AND delta < 0 AND reverses IS NOT NULL AND ledger_entry_id IS NOT NULL
        AND quest_id IS NOT NULL AND questify_award_id IS NULL AND streak_reward_id IS NULL AND daily_finish_id IS NULL)
    OR (source = 'questify' AND delta > 0 AND reverses IS NULL AND ledger_entry_id IS NULL AND quest_id IS NULL
        AND questify_award_id IS NOT NULL AND streak_reward_id IS NULL AND daily_finish_id IS NULL)
    OR (source = 'streak' AND delta > 0 AND reverses IS NULL AND ledger_entry_id IS NULL AND quest_id IS NULL
        AND questify_award_id IS NULL AND streak_reward_id IS NOT NULL AND daily_finish_id IS NULL)
    OR (source = 'daily' AND delta > 0 AND reverses IS NULL AND ledger_entry_id IS NULL AND quest_id IS NULL
        AND questify_award_id IS NULL AND streak_reward_id IS NULL AND daily_finish_id IS NOT NULL));

-- ================================================================ switches and amounts (ADR-309, ADR-312)
-- The platform switches `features.dailyChallenge.enabled` and `features.dailyWord.enabled`, on when absent.
CREATE FUNCTION daily_feature_on(k text) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT s.value -> (CASE k WHEN 'challenge' THEN 'dailyChallenge' ELSE 'dailyWord' END) -> 'enabled'
                          <> 'false'::jsonb
                   FROM platform_setting s WHERE s.key = 'features'), true)
$$;
REVOKE ALL ON FUNCTION daily_feature_on(text) FROM PUBLIC;

-- One field of the `xp` setting, used only when it is an integer 0 to `top`; anything else, or no row, is the default.
CREATE FUNCTION daily_xp_field(setting jsonb, field text, top integer, fallback integer) RETURNS integer
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN jsonb_typeof(setting -> field) = 'number' AND (setting ->> field) ~ '^(0|[1-9][0-9]{0,3})$'
               AND (setting ->> field)::integer <= top
         THEN (setting ->> field)::integer ELSE fallback END
$$;
REVOKE ALL ON FUNCTION daily_xp_field(jsonb, text, integer, integer) FROM PUBLIC;
-- The amounts (MAJOR-3): finishing 0 to 400 (20), each right answer 0 to 200 (10), a solved word 0 to 1000 (50), so
-- no payout exceeds daily_finish.xp's 1000.
CREATE FUNCTION daily_xp() RETURNS TABLE (finish integer, per_right integer, word integer)
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT daily_xp_field(s.value, 'dailyFinishXp', 400, 20), daily_xp_field(s.value, 'dailyRightXp', 200, 10),
         daily_xp_field(s.value, 'dailyWordXp', 1000, 50)
  FROM (SELECT (SELECT p.value FROM platform_setting p WHERE p.key = 'xp') AS value) s
$$;
REVOKE ALL ON FUNCTION daily_xp() FROM PUBLIC;

-- ================================================================ the warnings (FR-1733, FR-1811, FR-1814)
-- Whether a period has complete content: a challenge (its three questions are a commit-time rule), or the language's
-- word. Internal.
CREATE FUNCTION daily_has_content(k text, lang text, day date) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE k WHEN 'challenge' THEN EXISTS (SELECT 1 FROM daily_challenge c WHERE c.starts_on = day)
                ELSE EXISTS (SELECT 1 FROM daily_word w WHERE w.language = lang AND w.starts_on = day) END
$$;
REVOKE ALL ON FUNCTION daily_has_content(text, text, date) FROM PUBLIC;

-- From today's period forward, the consecutive periods with content (counted up to 60) and the days they cover from
-- today. A missing current period covers 0. Internal.
CREATE FUNCTION daily_coverage(k text, lang text, OUT periods integer, OUT days integer)
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  today date := questify_day(now());
  probe date := today;
  span  record;
BEGIN
  periods := 0;
  days := 0;
  WHILE periods < 60 LOOP
    SELECT p.starts_on, p.ends_on INTO span FROM daily_period(k, probe) p;
    EXIT WHEN span.starts_on IS NULL OR NOT daily_has_content(k, lang, span.starts_on);
    periods := periods + 1;
    days := days + (span.ends_on - greatest(span.starts_on, today) + 1);
    probe := span.ends_on + 1;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION daily_coverage(text, text) FROM PUBLIC;

-- The console's coverage line: the challenge warns under 7 days or 2 periods, a word language under 2 periods.
CREATE FUNCTION daily_cover_json(k text, lang text) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('coveredDays', c.days, 'coveredPeriods', c.periods,
                            'warn', c.periods < 2 OR (k = 'challenge' AND c.days < 7))
  FROM daily_coverage(k, lang) c
$$;
REVOKE ALL ON FUNCTION daily_cover_json(text, text) FROM PUBLIC;

-- ================================================================ the player's view (FR-730, FR-1810)
-- The current period's challenge for one player: every question with its options, and for an answered one the
-- choice, whether it was right and the right option; never the right option of an unanswered question. NULL when the
-- period has no challenge. Internal.
CREATE FUNCTION daily_challenge_view(who uuid, today date) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  WITH span AS (SELECT * FROM daily_period('challenge', today)),
  chal AS (SELECT c.* FROM daily_challenge c JOIN span s ON c.starts_on = s.starts_on),
  play AS (SELECT y.id FROM daily_play y JOIN chal c ON y.challenge_id = c.id
           WHERE y.player_id = who AND y.kind = 'challenge')
  SELECT jsonb_build_object(
    'id', c.id,
    'period', jsonb_build_object('startsOn', s.starts_on, 'endsOn', s.ends_on),
    'sponsor', CASE WHEN c.sponsor_ar IS NOT NULL THEN jsonb_build_object('ar', c.sponsor_ar, 'en', c.sponsor_en) END,
    'questions', (SELECT jsonb_agg(jsonb_build_object(
                    'id', q.id, 'position', x.position,
                    'prompt', jsonb_build_object('ar', q.prompt_ar, 'en', q.prompt_en),
                    'options', (SELECT jsonb_agg(jsonb_build_object('ar', o.ar, 'en', o.en) ORDER BY o.n)
                                FROM unnest(q.options_ar, q.options_en) WITH ORDINALITY o (ar, en, n)),
                    'answered', (SELECT jsonb_build_object('choice', a.choice, 'correct', a.correct, 'right', q.answer)
                                 FROM daily_answer a JOIN play p ON p.id = a.play_id WHERE a.position = x.position))
                  ORDER BY x.position)
                  FROM daily_challenge_question x JOIN daily_question q ON q.id = x.question_id
                  WHERE x.challenge_id = c.id),
    'finished', (SELECT jsonb_build_object('correct', f.correct, 'xp', f.xp)
                 FROM daily_finish f JOIN play p ON p.id = f.play_id))
  FROM chal c CROSS JOIN span s
$$;
REVOKE ALL ON FUNCTION daily_challenge_view(uuid, date) FROM PUBLIC;

-- A finished word play as its owner sees it: solved, the attempts, the XP and the word as written. Internal.
CREATE FUNCTION daily_word_finished(play bigint) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('solved', f.solved,
                            'attempts', (SELECT count(*)::integer FROM daily_guess g WHERE g.play_id = play),
                            'xp', f.xp, 'word', w.display)
  FROM daily_finish f JOIN daily_play y ON y.id = f.play_id JOIN daily_word w ON w.id = y.word_id
  WHERE f.play_id = play
$$;
REVOKE ALL ON FUNCTION daily_word_finished(bigint) FROM PUBLIC;

-- The current period's word game for one player: the languages with a word and their ids, and the player's play (its
-- guesses and marks; the word only once finished). NULL when the period has no word at all. Internal.
CREATE FUNCTION daily_word_view(who uuid, today date) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  WITH span AS (SELECT * FROM daily_period('word', today)),
  words AS (SELECT w.id, w.language FROM daily_word w JOIN span s ON w.starts_on = s.starts_on)
  SELECT jsonb_build_object(
    'period', jsonb_build_object('startsOn', s.starts_on, 'endsOn', s.ends_on),
    'length', 5,
    'languages', (SELECT jsonb_agg(w.language ORDER BY w.language) FROM words w),
    'words', (SELECT jsonb_agg(jsonb_build_object('language', w.language, 'id', w.id) ORDER BY w.language) FROM words w),
    'play', (SELECT jsonb_build_object(
               'language', w.language, 'wordId', w.id,
               'guesses', (SELECT coalesce(jsonb_agg(jsonb_build_object('guess', g.guess, 'marks', g.marks)
                                                     ORDER BY g.attempt), '[]'::jsonb)
                           FROM daily_guess g WHERE g.play_id = y.id),
               'finished', daily_word_finished(y.id))
             FROM daily_play y JOIN daily_word w ON w.id = y.word_id
             WHERE y.player_id = who AND y.kind = 'word' AND y.starts_on = s.starts_on))
  FROM span s
  WHERE EXISTS (SELECT 1 FROM words)
$$;
REVOKE ALL ON FUNCTION daily_word_view(uuid, date) FROM PUBLIC;

-- The caller's daily games (GET /v1/me/daily): each kind NULL while its switch is off or its period has no content
-- (FR-1733, FR-1811). NULL for a caller who is not an active player. Lock-free: an answer names the question or word
-- it was shown, so content replaced between this read and the answer is caught as `changed`.
CREATE FUNCTION own_daily() RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'challenge', CASE WHEN daily_feature_on('challenge') THEN daily_challenge_view(me.id, questify_day(now())) END,
    'word', CASE WHEN daily_feature_on('word') THEN daily_word_view(me.id, questify_day(now())) END)
  FROM (SELECT profile_player() AS id) me WHERE me.id IS NOT NULL
$$;
REVOKE ALL ON FUNCTION own_daily() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION own_daily() TO questify_app;

-- ================================================================ the player doors (FR-730, FR-731, FR-1810)
-- The caller as an active player, held FOR KEY SHARE (compatible with every live path; erase_player's FOR UPDATE
-- waits for the door, or the door sees the erasure and refuses). PI401 otherwise. Internal.
CREATE FUNCTION daily_player() RETURNS uuid
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  who uuid;
BEGIN
  SELECT p.id INTO who FROM player p WHERE p.id = app_player_id() AND p.status = 'active' FOR KEY SHARE;
  IF who IS NULL THEN
    RAISE EXCEPTION 'active player required' USING ERRCODE = 'PI401';
  END IF;
  RETURN who;
END $$;
REVOKE ALL ON FUNCTION daily_player() FROM PUBLIC;

-- The current period of a kind for a player door. Holds today's governing cadence row FOR KEY SHARE first (the
-- cadence door takes every row of the kind FOR UPDATE), then works the period out in a later statement, so it sees a
-- cadence change that committed while it waited, never a mix. Internal.
CREATE FUNCTION daily_current(k text, OUT starts_on date, OUT ends_on date)
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM 1 FROM daily_cadence c WHERE c.kind = k AND c.from_day <= questify_day(now())
  ORDER BY c.from_day DESC LIMIT 1 FOR KEY SHARE;
  SELECT p.starts_on, p.ends_on INTO starts_on, ends_on FROM daily_period(k, questify_day(now())) p;
END $$;
REVOKE ALL ON FUNCTION daily_current(text) FROM PUBLIC;

-- The caller's play of a period, made on the first move and then held FOR UPDATE, so two moves of one play serialize.
-- Internal.
CREATE FUNCTION daily_play_of(who uuid, k text, starts date, chal bigint, wd bigint) RETURNS daily_play
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  play daily_play%ROWTYPE;
BEGIN
  INSERT INTO daily_play (player_id, kind, starts_on, challenge_id, word_id) VALUES (who, k, starts, chal, wd)
  ON CONFLICT DO NOTHING;
  SELECT y.* INTO play FROM daily_play y WHERE y.player_id = who AND y.kind = k AND y.starts_on = starts FOR UPDATE;
  RETURN play;
END $$;
REVOKE ALL ON FUNCTION daily_play_of(uuid, text, date, bigint, bigint) FROM PUBLIC;

-- Finishes a play, in the completion trigger's order: the daily streak row (while its switch is on), then player_xp
-- FOR UPDATE, then the finish, its XP entry and xp_apply (levels and level items follow; the level's gems are paid at
-- the next questify_sync). Once per play (daily_finish.play_id UNIQUE). Answers the XP entry, or NULL when it paid 0.
-- Internal.
CREATE FUNCTION daily_finish_play(who uuid, play daily_play) RETURNS bigint
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  amount record;
  rights smallint;
  solved boolean;
  xp     integer;
  done   bigint;
  entry  bigint;
BEGIN
  IF daily_streak_on() AND NOT EXISTS (
    SELECT 1 FROM questify_streak_day d WHERE d.player_id = who AND d.day = questify_day(now())) THEN
    INSERT INTO questify_streak_day (player_id, day) VALUES (who, questify_day(now())) ON CONFLICT DO NOTHING;
  END IF;
  PERFORM 1 FROM player_xp x WHERE x.player_id = who FOR UPDATE;
  SELECT * INTO amount FROM daily_xp();
  IF play.kind = 'challenge' THEN
    SELECT count(*) FILTER (WHERE a.correct) INTO rights FROM daily_answer a WHERE a.play_id = play.id;
    xp := amount.finish + amount.per_right * rights;
  ELSE
    solved := EXISTS (SELECT 1 FROM daily_guess g WHERE g.play_id = play.id AND g.marks = '22222');
    xp := CASE WHEN solved THEN amount.word ELSE 0 END;
  END IF;
  INSERT INTO daily_finish (play_id, player_id, kind, solved, correct, xp)
  VALUES (play.id, who, play.kind, solved, rights, xp) RETURNING id INTO done;
  IF xp > 0 THEN
    INSERT INTO xp_entry (player_id, delta, source, daily_finish_id) VALUES (who, xp, 'daily', done)
    RETURNING id INTO entry;
    PERFORM xp_apply(who, entry, xp);
  END IF;
  RETURN entry;
END $$;
REVOKE ALL ON FUNCTION daily_finish_play(uuid, daily_play) FROM PUBLIC;

-- An answer's reply: the answer with the right option (now answered), the finish when the play is finished, the level
-- reached by this call's entry (NULL on a replay: it was shown the first time), the daily streak. Internal.
CREATE FUNCTION daily_answer_reply(who uuid, play daily_play, made daily_answer, entry bigint, replayed boolean)
  RETURNS jsonb LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'answer', jsonb_build_object('position', made.position, 'choice', made.choice, 'correct', made.correct,
                                 'right', (SELECT q.answer FROM daily_challenge_question x
                                           JOIN daily_question q ON q.id = x.question_id
                                           WHERE x.challenge_id = play.challenge_id AND x.position = made.position)),
    'finished', (SELECT jsonb_build_object('correct', f.correct, 'xp', f.xp) FROM daily_finish f
                 WHERE f.play_id = play.id),
    'levelUp', CASE WHEN entry IS NOT NULL THEN questify_level_up(who, ARRAY[entry]) END,
    'dailyStreak', daily_streak_of(who),
    'replayed', replayed)
$$;
REVOKE ALL ON FUNCTION daily_answer_reply(uuid, daily_play, daily_answer, bigint, boolean) FROM PUBLIC;

-- Answers one question of the current period's challenge, in order, once (FR-730). `question` is the question the
-- player was shown at `pos`. Every check about the period and the content comes before anything about the answer is
-- computed (MINOR-5). Refusals: PI401; DC404 unavailable (the switch is off); DC409 with the reason in DETAIL:
-- changed (an unknown challenge id, or another question at that position), period_over (a known challenge of another
-- period), answered (that position has another choice; no stored value is named), out_of_order; DC422 position or
-- choice. The same (position, choice) again replays the stored answer. The third answer finishes the play: 20 XP plus
-- 10 a right answer by default, once. Lock order: player KEY SHARE, today's cadence row KEY SHARE, the challenge KEY
-- SHARE, the play FOR UPDATE, then on a finish the streak row and player_xp FOR UPDATE.
CREATE FUNCTION daily_answer_submit(challenge bigint, question uuid, pos smallint, chosen smallint) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  who     uuid := daily_player();
  span    record;
  chal    daily_challenge%ROWTYPE;
  shown   uuid;
  play    daily_play%ROWTYPE;
  earlier daily_answer%ROWTYPE;
  options integer;
  right_one smallint;
  made    daily_answer%ROWTYPE;
  entry   bigint;
BEGIN
  IF NOT daily_feature_on('challenge') THEN
    RAISE EXCEPTION 'the daily challenge is not available' USING ERRCODE = 'DC404', DETAIL = 'unavailable';
  END IF;
  SELECT * INTO span FROM daily_current('challenge');
  SELECT c.* INTO chal FROM daily_challenge c WHERE c.id = challenge FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the challenge changed' USING ERRCODE = 'DC409', DETAIL = 'changed';
  END IF;
  IF chal.starts_on IS DISTINCT FROM span.starts_on THEN
    RAISE EXCEPTION 'that challenge is not the current one' USING ERRCODE = 'DC409', DETAIL = 'period_over';
  END IF;
  IF pos IS NULL OR pos NOT BETWEEN 1 AND 3 THEN
    RAISE EXCEPTION 'a position is 1 to 3' USING ERRCODE = 'DC422', DETAIL = 'position';
  END IF;
  SELECT x.question_id INTO shown FROM daily_challenge_question x WHERE x.challenge_id = chal.id AND x.position = pos;
  IF shown IS DISTINCT FROM question THEN
    RAISE EXCEPTION 'the challenge changed' USING ERRCODE = 'DC409', DETAIL = 'changed';
  END IF;
  play := daily_play_of(who, 'challenge', chal.starts_on, chal.id, NULL);
  SELECT a.* INTO earlier FROM daily_answer a WHERE a.play_id = play.id AND a.position = pos;
  IF FOUND THEN
    IF earlier.choice IS DISTINCT FROM chosen THEN
      RAISE EXCEPTION 'that question is answered' USING ERRCODE = 'DC409', DETAIL = 'answered';
    END IF;
    RETURN daily_answer_reply(who, play, earlier, NULL, true);
  END IF;
  IF pos <> (SELECT count(*) + 1 FROM daily_answer a WHERE a.play_id = play.id) THEN
    RAISE EXCEPTION 'answer the questions in order' USING ERRCODE = 'DC409', DETAIL = 'out_of_order';
  END IF;
  SELECT cardinality(q.options_en), q.answer INTO options, right_one FROM daily_question q WHERE q.id = shown;
  IF chosen IS NULL OR chosen NOT BETWEEN 1 AND options THEN
    RAISE EXCEPTION 'no such option' USING ERRCODE = 'DC422', DETAIL = 'choice';
  END IF;
  INSERT INTO daily_answer (play_id, position, choice, correct) VALUES (play.id, pos, chosen, chosen = right_one)
  RETURNING * INTO made;
  -- Its own statement, so the reply's read sees the finish (a STABLE function reads its caller's snapshot).
  IF pos = 3 THEN
    entry := daily_finish_play(who, play);
  END IF;
  RETURN daily_answer_reply(who, play, made, entry, false);
END $$;
REVOKE ALL ON FUNCTION daily_answer_submit(bigint, uuid, smallint, smallint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION daily_answer_submit(bigint, uuid, smallint, smallint) TO questify_app;

-- A guess's reply: the guess and its marks, the finish when the play is finished (the word only then), the level
-- reached by this call's entry (NULL on a replay), the daily streak. Internal.
CREATE FUNCTION daily_guess_reply(who uuid, play daily_play, made daily_guess, entry bigint, replayed boolean)
  RETURNS jsonb LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'guess', jsonb_build_object('attempt', made.attempt, 'guess', made.guess, 'marks', made.marks),
    'finished', daily_word_finished(play.id),
    'levelUp', CASE WHEN entry IS NOT NULL THEN questify_level_up(who, ARRAY[entry]) END,
    'dailyStreak', daily_streak_of(who),
    'replayed', replayed)
$$;
REVOKE ALL ON FUNCTION daily_guess_reply(uuid, daily_play, daily_guess, bigint, boolean) FROM PUBLIC;

-- Whether a guess may be played: DW422 length or letters for one that is not five letters of the language, not_a_word
-- for one that is neither listed nor the period's own word. A refused guess uses no attempt. Internal.
CREATE FUNCTION daily_guess_check(wd daily_word, guess text) RETURNS text
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  folded text := daily_fold(wd.language, guess);
  normal text := word_norm(wd.language, guess);
BEGIN
  IF folded IS NULL OR char_length(folded) <> 5 THEN
    RAISE EXCEPTION 'a guess has five letters' USING ERRCODE = 'DW422', DETAIL = 'length';
  END IF;
  IF normal IS NULL THEN
    RAISE EXCEPTION 'a guess uses the letters of its language' USING ERRCODE = 'DW422', DETAIL = 'letters';
  END IF;
  IF normal <> wd.word
     AND NOT EXISTS (SELECT 1 FROM word_guess_list g WHERE g.language = wd.language AND g.word = normal) THEN
    RAISE EXCEPTION 'not in the word list' USING ERRCODE = 'DW422', DETAIL = 'not_a_word';
  END IF;
  RETURN normal;
END $$;
REVOKE ALL ON FUNCTION daily_guess_check(daily_word, text) FROM PUBLIC;

-- Plays one guess of the current period's word (FR-1810). `target` is the word id the player was shown. Refusals: PI401;
-- DW404 unavailable; DW409 with the reason in DETAIL: changed (an unknown word id: replaced or cleared), period_over (a
-- known word of another period), other_language (this period is played in the other language), attempt_taken (that
-- attempt has another guess; nothing stored is named), finished, out_of_order; DW422 attempt, length, letters,
-- not_a_word (no attempt used, nothing written). The same (attempt, guess) again replays. The solving or sixth guess
-- finishes the play: 50 XP when solved by default, none when not. The word is answered only in `finished`. Lock order
-- as daily_answer_submit's.
CREATE FUNCTION daily_guess_submit(target bigint, try smallint, guess text) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  who     uuid := daily_player();
  span    record;
  wd      daily_word%ROWTYPE;
  play    daily_play%ROWTYPE;
  earlier daily_guess%ROWTYPE;
  normal  text;
  made    daily_guess%ROWTYPE;
  entry   bigint;
BEGIN
  IF NOT daily_feature_on('word') THEN
    RAISE EXCEPTION 'the daily word is not available' USING ERRCODE = 'DW404', DETAIL = 'unavailable';
  END IF;
  SELECT * INTO span FROM daily_current('word');
  SELECT w.* INTO wd FROM daily_word w WHERE w.id = target FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the word changed' USING ERRCODE = 'DW409', DETAIL = 'changed';
  END IF;
  IF wd.starts_on IS DISTINCT FROM span.starts_on THEN
    RAISE EXCEPTION 'that word is not the current one' USING ERRCODE = 'DW409', DETAIL = 'period_over';
  END IF;
  IF try IS NULL OR try NOT BETWEEN 1 AND 6 THEN
    RAISE EXCEPTION 'an attempt is 1 to 6' USING ERRCODE = 'DW422', DETAIL = 'attempt';
  END IF;
  play := daily_play_of(who, 'word', wd.starts_on, NULL, wd.id);
  IF play.word_id IS DISTINCT FROM wd.id THEN
    RAISE EXCEPTION 'this period is played in the other language' USING ERRCODE = 'DW409', DETAIL = 'other_language';
  END IF;
  SELECT g.* INTO earlier FROM daily_guess g WHERE g.play_id = play.id AND g.attempt = try;
  IF FOUND THEN
    IF earlier.guess IS DISTINCT FROM word_norm(wd.language, guess) THEN
      RAISE EXCEPTION 'that attempt is taken' USING ERRCODE = 'DW409', DETAIL = 'attempt_taken';
    END IF;
    RETURN daily_guess_reply(who, play, earlier, NULL, true);
  END IF;
  IF EXISTS (SELECT 1 FROM daily_finish f WHERE f.play_id = play.id) THEN
    RAISE EXCEPTION 'the game is over' USING ERRCODE = 'DW409', DETAIL = 'finished';
  END IF;
  IF try <> (SELECT count(*) + 1 FROM daily_guess g WHERE g.play_id = play.id) THEN
    RAISE EXCEPTION 'guess in order' USING ERRCODE = 'DW409', DETAIL = 'out_of_order';
  END IF;
  normal := daily_guess_check(wd, guess);
  INSERT INTO daily_guess (play_id, attempt, guess, marks) VALUES (play.id, try, normal, daily_marks(wd.word, normal))
  RETURNING * INTO made;
  IF made.marks = '22222' OR try = 6 THEN
    entry := daily_finish_play(who, play);
  END IF;
  RETURN daily_guess_reply(who, play, made, entry, false);
END $$;
REVOKE ALL ON FUNCTION daily_guess_submit(bigint, smallint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION daily_guess_submit(bigint, smallint, text) TO questify_app;

-- ================================================================ the console's doors (ADR-307, ADR-308, ADR-311)
-- Each door re-reads the admin from the account (questify_admin, QY403 otherwise); the API replays by Idempotency-Key.
-- Every write is audited `daily.*` with ids and changed field names only, never a word or an answer. Refusals: DK404,
-- DK409 with the reason in DETAIL (and a position in HINT), DK422 with the field in DETAIL. Content doors take an
-- explicit FOR UPDATE on the content row before they write (a plain UPDATE's NO KEY UPDATE would not wait for a player
-- door's KEY SHARE), then check the clock; they lock only content rows, never daily_cadence, a player, a play or XP.
CREATE FUNCTION daily_audit(admin uuid, verb text, kind text, target text, after jsonb, request uuid) RETURNS void
  LANGUAGE sql SET search_path = public, pg_temp AS $$
  INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, after, request_id)
  VALUES ('admin', admin, 'daily.' || verb, kind, target, after, request)
$$;
REVOKE ALL ON FUNCTION daily_audit(uuid, text, text, text, jsonb, uuid) FROM PUBLIC;

-- Whether a day's period has started, by the clock (read after the content row lock). Internal.
CREATE FUNCTION daily_started(day date) RETURNS boolean
  LANGUAGE sql VOLATILE SET search_path = public, pg_temp
  RETURN day <= questify_day(clock_timestamp());
REVOKE ALL ON FUNCTION daily_started(date) FROM PUBLIC;

-- A question for the console, with the day of the challenge that holds it (if any).
CREATE FUNCTION daily_question_json(q daily_question) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('id', q.id, 'prompt', jsonb_build_object('ar', q.prompt_ar, 'en', q.prompt_en),
    'options', (SELECT jsonb_agg(jsonb_build_object('ar', o.ar, 'en', o.en) ORDER BY o.n)
                FROM unnest(q.options_ar, q.options_en) WITH ORDINALITY o (ar, en, n)),
    'answer', q.answer, 'status', q.status,
    'scheduledOn', (SELECT c.starts_on FROM daily_challenge_question x JOIN daily_challenge c ON c.id = x.challenge_id
                    WHERE x.question_id = q.id),
    'createdAt', q.created_at, 'updatedAt', q.updated_at)
$$;
REVOKE ALL ON FUNCTION daily_question_json(daily_question) FROM PUBLIC;

-- A question's fields, trimmed: {prompt: {ar, en}, options: [{ar, en}] (2 to 4), answer (1-based)}; DK422 prompt,
-- options or answer otherwise. Internal.
CREATE FUNCTION daily_question_of(fields jsonb, OUT prompt_ar text, OUT prompt_en text, OUT options_ar text[],
                                  OUT options_en text[], OUT answer smallint)
  LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
BEGIN
  prompt_ar := btrim(fields #>> '{prompt,ar}');
  prompt_en := btrim(fields #>> '{prompt,en}');
  IF NOT coalesce(daily_text_ok(prompt_ar, 300) AND daily_text_ok(prompt_en, 300), false) THEN
    RAISE EXCEPTION 'a prompt in both languages, 1 to 300 characters' USING ERRCODE = 'DK422', DETAIL = 'prompt';
  END IF;
  IF jsonb_typeof(fields -> 'options') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'two to four options' USING ERRCODE = 'DK422', DETAIL = 'options';
  END IF;
  options_ar := ARRAY(SELECT btrim(o.v ->> 'ar') FROM jsonb_array_elements(fields -> 'options') WITH ORDINALITY o (v, n)
                      ORDER BY o.n);
  options_en := ARRAY(SELECT btrim(o.v ->> 'en') FROM jsonb_array_elements(fields -> 'options') WITH ORDINALITY o (v, n)
                      ORDER BY o.n);
  IF NOT coalesce(daily_options_ok(options_ar) AND daily_options_ok(options_en), false) THEN
    RAISE EXCEPTION 'two to four options in both languages, 1 to 120 characters' USING ERRCODE = 'DK422',
      DETAIL = 'options';
  END IF;
  IF jsonb_typeof(fields -> 'answer') IS DISTINCT FROM 'number' OR (fields ->> 'answer') !~ '^[1-4]$'
     OR (fields ->> 'answer')::integer > cardinality(options_en) THEN
    RAISE EXCEPTION 'the right option is one of the options' USING ERRCODE = 'DK422', DETAIL = 'answer';
  END IF;
  answer := (fields ->> 'answer')::smallint;
END $$;
REVOKE ALL ON FUNCTION daily_question_of(jsonb) FROM PUBLIC;

-- Locks a question for a change, in the order that serializes with a player door: the challenge that holds it FOR
-- UPDATE first (a player door holds it FOR KEY SHARE while it reads the questions), then the question FOR UPDATE, then
-- the clock. DK404 for an unknown question; DK409 changed when its challenge changed while the locks were taken, or
-- started. Answers the question and the day of its challenge (NULL when none). Internal.
CREATE FUNCTION daily_question_hold(target uuid, OUT q daily_question, OUT scheduled date)
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  held_by bigint;
  now_by  bigint;
BEGIN
  SELECT x.challenge_id INTO held_by FROM daily_challenge_question x WHERE x.question_id = target;
  IF held_by IS NOT NULL THEN
    SELECT c.starts_on INTO scheduled FROM daily_challenge c WHERE c.id = held_by FOR UPDATE;
  END IF;
  SELECT d.* INTO q FROM daily_question d WHERE d.id = target FOR UPDATE;
  IF q.id IS NULL THEN
    RAISE EXCEPTION 'no such question' USING ERRCODE = 'DK404';
  END IF;
  SELECT x.challenge_id INTO now_by FROM daily_challenge_question x WHERE x.question_id = target;
  IF now_by IS DISTINCT FROM held_by THEN
    RAISE EXCEPTION 'the question''s schedule changed; reload' USING ERRCODE = 'DK409', DETAIL = 'changed';
  END IF;
  IF scheduled IS NOT NULL AND daily_started(scheduled) THEN
    RAISE EXCEPTION 'the question''s challenge has started' USING ERRCODE = 'DK409', DETAIL = 'started';
  END IF;
END $$;
REVOKE ALL ON FUNCTION daily_question_hold(uuid) FROM PUBLIC;

-- Creates a question (target NULL, ready) or replaces one's prompt, options and right answer until its challenge has
-- started. Audited `daily.question_created` / `daily.question_updated` with the changed field names.
CREATE FUNCTION daily_question_save(target uuid, fields jsonb, request uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  admin   uuid := questify_admin();
  v       record;
  held    record;
  made    daily_question%ROWTYPE;
  changed text[] := ARRAY['prompt', 'options', 'answer'];
BEGIN
  SELECT * INTO v FROM daily_question_of(fields);
  IF target IS NULL THEN
    INSERT INTO daily_question (prompt_ar, prompt_en, options_ar, options_en, answer, created_by)
    VALUES (v.prompt_ar, v.prompt_en, v.options_ar, v.options_en, v.answer, admin) RETURNING * INTO made;
  ELSE
    SELECT * INTO held FROM daily_question_hold(target);
    UPDATE daily_question d
    SET prompt_ar = v.prompt_ar, prompt_en = v.prompt_en, options_ar = v.options_ar, options_en = v.options_en,
        answer = v.answer, updated_at = now()
    WHERE d.id = target RETURNING * INTO made;
    changed := array_remove(ARRAY[
      CASE WHEN ((held.q).prompt_ar, (held.q).prompt_en) IS DISTINCT FROM (made.prompt_ar, made.prompt_en)
           THEN 'prompt' END,
      CASE WHEN ((held.q).options_ar, (held.q).options_en) IS DISTINCT FROM (made.options_ar, made.options_en)
           THEN 'options' END,
      CASE WHEN (held.q).answer IS DISTINCT FROM made.answer THEN 'answer' END], NULL);
  END IF;
  PERFORM daily_audit(admin, CASE WHEN target IS NULL THEN 'question_created' ELSE 'question_updated' END,
                      'daily_question', made.id::text, jsonb_build_object('fields', to_jsonb(changed)), request);
  RETURN daily_question_json(made);
END $$;
REVOKE ALL ON FUNCTION daily_question_save(uuid, jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION daily_question_save(uuid, jsonb, uuid) TO questify_app;

-- Retires a question (the same locks): never while a challenge holds it (DK409 scheduled); a retired one answers as
-- it is. Audited `daily.question_retired`.
CREATE FUNCTION daily_question_retire(target uuid, request uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  admin uuid := questify_admin();
  held  record;
  made  daily_question%ROWTYPE;
BEGIN
  SELECT * INTO held FROM daily_question_hold(target);
  IF held.scheduled IS NOT NULL THEN
    RAISE EXCEPTION 'a scheduled question cannot be retired' USING ERRCODE = 'DK409', DETAIL = 'scheduled';
  END IF;
  IF (held.q).status = 'retired' THEN
    RETURN daily_question_json(held.q);
  END IF;
  UPDATE daily_question d SET status = 'retired', updated_at = now() WHERE d.id = target RETURNING * INTO made;
  PERFORM daily_audit(admin, 'question_retired', 'daily_question', made.id::text,
                      jsonb_build_object('status', 'retired'), request);
  RETURN daily_question_json(made);
END $$;
REVOKE ALL ON FUNCTION daily_question_retire(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION daily_question_retire(uuid, uuid) TO questify_app;

-- A challenge for the console.
CREATE FUNCTION daily_challenge_json(c daily_challenge) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('id', c.id, 'startsOn', c.starts_on,
    'questions', (SELECT coalesce(jsonb_agg(x.question_id ORDER BY x.position), '[]'::jsonb)
                  FROM daily_challenge_question x WHERE x.challenge_id = c.id),
    'sponsor', CASE WHEN c.sponsor_ar IS NOT NULL THEN jsonb_build_object('ar', c.sponsor_ar, 'en', c.sponsor_en) END)
$$;
REVOKE ALL ON FUNCTION daily_challenge_json(daily_challenge) FROM PUBLIC;

-- The day's challenge FOR UPDATE (a NULL row when there is none: the INSERT's unique key then serializes), then the
-- clock and the period start. DK422 day; DK409 started; DK422 not_period_start (the cadence read without a lock).
-- Internal.
CREATE FUNCTION daily_challenge_hold(day date) RETURNS daily_challenge
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  chal daily_challenge%ROWTYPE;
BEGIN
  IF day IS NULL THEN
    RAISE EXCEPTION 'a day is required' USING ERRCODE = 'DK422', DETAIL = 'day';
  END IF;
  SELECT c.* INTO chal FROM daily_challenge c WHERE c.starts_on = day FOR UPDATE;
  IF daily_started(day) THEN
    RAISE EXCEPTION 'the period has started' USING ERRCODE = 'DK409', DETAIL = 'started';
  END IF;
  IF NOT daily_period_start('challenge', day) THEN
    RAISE EXCEPTION 'the day does not start a period' USING ERRCODE = 'DK422', DETAIL = 'not_period_start';
  END IF;
  RETURN chal;
END $$;
REVOKE ALL ON FUNCTION daily_challenge_hold(date) FROM PUBLIC;

-- Checks the three questions of a challenge under their locks (taken in id order): each known (DK422 questions),
-- ready (DK409 retired) and held by no other challenge (DK409 used), the position in HINT. Internal.
CREATE FUNCTION daily_questions_check(questions uuid[], chal bigint) RETURNS void
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  picked daily_question%ROWTYPE;
BEGIN
  IF questions IS NULL OR cardinality(questions) <> 3 OR array_position(questions, NULL) IS NOT NULL
     OR (SELECT count(DISTINCT x) FROM unnest(questions) x) <> 3 THEN
    RAISE EXCEPTION 'three different questions' USING ERRCODE = 'DK422', DETAIL = 'questions';
  END IF;
  PERFORM 1 FROM daily_question q WHERE q.id = ANY (questions) ORDER BY q.id FOR UPDATE;
  FOR n IN 1..3 LOOP
    SELECT q.* INTO picked FROM daily_question q WHERE q.id = questions[n];
    IF NOT FOUND THEN
      RAISE EXCEPTION 'no such question' USING ERRCODE = 'DK422', DETAIL = 'questions', HINT = n::text;
    END IF;
    IF picked.status <> 'ready' THEN
      RAISE EXCEPTION 'a retired question' USING ERRCODE = 'DK409', DETAIL = 'retired', HINT = n::text;
    END IF;
    IF EXISTS (SELECT 1 FROM daily_challenge_question x
               WHERE x.question_id = picked.id AND x.challenge_id IS DISTINCT FROM chal) THEN
      RAISE EXCEPTION 'a question is used once' USING ERRCODE = 'DK409', DETAIL = 'used', HINT = n::text;
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION daily_questions_check(uuid[], bigint) FROM PUBLIC;

-- Sets a future period's challenge: three questions in order and an optional sponsor name {ar, en} (trimmed 1 to 60,
-- no control or bidi; DK422 sponsor). Replaces that day's question rows in one statement group. Locks: the challenge,
-- then its questions. Audited `daily.challenge_set` with the changed field names.
CREATE FUNCTION daily_challenge_set(day date, questions uuid[], sponsor jsonb, request uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  admin uuid := questify_admin();
  s_ar  text;
  s_en  text;
  old   daily_challenge%ROWTYPE;
  made  daily_challenge%ROWTYPE;
  kept  uuid[];
BEGIN
  IF sponsor IS NOT NULL AND jsonb_typeof(sponsor) <> 'null' THEN
    s_ar := btrim(sponsor ->> 'ar');
    s_en := btrim(sponsor ->> 'en');
    IF NOT coalesce(daily_text_ok(s_ar, 60) AND daily_text_ok(s_en, 60), false) THEN
      RAISE EXCEPTION 'a sponsor name in both languages, 1 to 60 characters' USING ERRCODE = 'DK422',
        DETAIL = 'sponsor';
    END IF;
  END IF;
  old := daily_challenge_hold(day);
  PERFORM daily_questions_check(questions, old.id);
  IF old.id IS NULL THEN
    INSERT INTO daily_challenge (starts_on, sponsor_ar, sponsor_en, set_by) VALUES (day, s_ar, s_en, admin)
    RETURNING * INTO made;
  ELSE
    kept := ARRAY(SELECT x.question_id FROM daily_challenge_question x WHERE x.challenge_id = old.id
                    ORDER BY x.position);
    UPDATE daily_challenge c SET sponsor_ar = s_ar, sponsor_en = s_en, set_by = admin, updated_at = now()
    WHERE c.id = old.id RETURNING * INTO made;
    DELETE FROM daily_challenge_question x WHERE x.challenge_id = old.id;
  END IF;
  INSERT INTO daily_challenge_question (challenge_id, position, question_id)
  SELECT made.id, n, questions[n] FROM generate_series(1, 3) n;
  PERFORM daily_audit(admin, 'challenge_set', 'daily_challenge', made.id::text, jsonb_build_object('fields', to_jsonb(
    array_remove(ARRAY[CASE WHEN kept IS DISTINCT FROM questions THEN 'questions' END,
                       CASE WHEN (old.sponsor_ar, old.sponsor_en) IS DISTINCT FROM (s_ar, s_en)
                                 OR old.id IS NULL THEN 'sponsor' END], NULL)), 'startsOn', day), request);
  RETURN daily_challenge_json(made);
END $$;
REVOKE ALL ON FUNCTION daily_challenge_set(date, uuid[], jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION daily_challenge_set(date, uuid[], jsonb, uuid) TO questify_app;

-- Clears a future period's challenge, or a stranded one with no plays whatever its day (MINOR-7); its questions go
-- back to the bank. DK404 none; DK409 started. Audited `daily.challenge_cleared`.
CREATE FUNCTION daily_challenge_clear(day date, request uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  admin uuid := questify_admin();
  chal  daily_challenge%ROWTYPE;
BEGIN
  SELECT c.* INTO chal FROM daily_challenge c WHERE c.starts_on = day FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no challenge on that day' USING ERRCODE = 'DK404';
  END IF;
  IF daily_started(day) AND NOT daily_clearable('challenge', day, chal.id) THEN
    RAISE EXCEPTION 'the period has started' USING ERRCODE = 'DK409', DETAIL = 'started';
  END IF;
  DELETE FROM daily_challenge c WHERE c.id = chal.id;
  PERFORM daily_audit(admin, 'challenge_cleared', 'daily_challenge', chal.id::text,
                      jsonb_build_object('startsOn', day), request);
  RETURN jsonb_build_object('startsOn', day, 'cleared', true);
END $$;
REVOKE ALL ON FUNCTION daily_challenge_clear(date, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION daily_challenge_clear(date, uuid) TO questify_app;

-- A daily word for the console (admins see the word).
CREATE FUNCTION daily_word_json(w daily_word) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('id', w.id, 'language', w.language, 'startsOn', w.starts_on, 'word', w.display)
$$;
REVOKE ALL ON FUNCTION daily_word_json(daily_word) FROM PUBLIC;

-- Sets a future period's word in one language: five letters of the language once normalized (DK422 word), not a
-- daily word of that language before (DK409 used), a future period start (DK409 started, DK422 not_period_start).
-- The row is replaced (deleted and inserted: a new id), never updated; the word joins the guess list. Audited
-- `daily.word_set` with the language and day, never the word.
CREATE FUNCTION daily_word_set(lang text, day date, chosen text, request uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  admin  uuid := questify_admin();
  shown  text;
  normal text;
  old    daily_word%ROWTYPE;
  made   daily_word%ROWTYPE;
BEGIN
  IF lang IS NULL OR lang NOT IN ('ar', 'en') THEN
    RAISE EXCEPTION 'a language is ar or en' USING ERRCODE = 'DK422', DETAIL = 'language';
  END IF;
  IF day IS NULL THEN
    RAISE EXCEPTION 'a day is required' USING ERRCODE = 'DK422', DETAIL = 'day';
  END IF;
  shown := daily_display(lang, chosen);
  normal := word_norm(lang, shown);
  IF normal IS NULL OR NOT daily_text_ok(shown, 40) THEN
    RAISE EXCEPTION 'five letters of the language' USING ERRCODE = 'DK422', DETAIL = 'word';
  END IF;
  SELECT w.* INTO old FROM daily_word w WHERE w.language = lang AND w.starts_on = day FOR UPDATE;
  IF daily_started(day) THEN
    RAISE EXCEPTION 'the period has started' USING ERRCODE = 'DK409', DETAIL = 'started';
  END IF;
  IF NOT daily_period_start('word', day) THEN
    RAISE EXCEPTION 'the day does not start a period' USING ERRCODE = 'DK422', DETAIL = 'not_period_start';
  END IF;
  IF EXISTS (SELECT 1 FROM daily_word w WHERE w.language = lang AND w.word = normal AND w.id IS DISTINCT FROM old.id) THEN
    RAISE EXCEPTION 'a word is a daily word once' USING ERRCODE = 'DK409', DETAIL = 'used';
  END IF;
  IF old.id IS NOT NULL THEN
    DELETE FROM daily_word w WHERE w.id = old.id;
  END IF;
  INSERT INTO daily_word (language, starts_on, word, display, set_by) VALUES (lang, day, normal, shown, admin)
  RETURNING * INTO made;
  INSERT INTO word_guess_list (language, word) VALUES (lang, normal) ON CONFLICT DO NOTHING;
  PERFORM daily_audit(admin, 'word_set', 'daily_word', made.id::text,
                      jsonb_build_object('language', lang, 'startsOn', day, 'replaced', old.id), request);
  RETURN daily_word_json(made);
END $$;
REVOKE ALL ON FUNCTION daily_word_set(text, date, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION daily_word_set(text, date, text, uuid) TO questify_app;

-- Clears a future period's word in one language, or a stranded one with no plays whatever its day (MINOR-7). The
-- guess list keeps the word. DK404 none; DK409 started. Audited `daily.word_cleared`.
CREATE FUNCTION daily_word_clear(lang text, day date, request uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  admin uuid := questify_admin();
  old   daily_word%ROWTYPE;
BEGIN
  SELECT w.* INTO old FROM daily_word w WHERE w.language = lang AND w.starts_on = day FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no word on that day' USING ERRCODE = 'DK404';
  END IF;
  IF daily_started(day) AND NOT daily_clearable('word', day, old.id) THEN
    RAISE EXCEPTION 'the period has started' USING ERRCODE = 'DK409', DETAIL = 'started';
  END IF;
  DELETE FROM daily_word w WHERE w.id = old.id;
  PERFORM daily_audit(admin, 'word_cleared', 'daily_word', old.id::text,
                      jsonb_build_object('language', lang, 'startsOn', day), request);
  RETURN jsonb_build_object('language', lang, 'startsOn', day, 'cleared', true);
END $$;
REVOKE ALL ON FUNCTION daily_word_clear(text, date, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION daily_word_clear(text, date, uuid) TO questify_app;

-- Adds and removes guess-list words, at most 20,000 of each per call (DK422 add or remove). Inputs are normalized; an
-- invalid one is refused (the first 50 are answered). A removal never touches stored guesses or daily words. Audited
-- `daily.word_list_changed` with the counts only.
CREATE FUNCTION word_list_change(lang text, adds text[], removes text[], request uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  admin   uuid := questify_admin();
  added   integer;
  removed integer;
  refused text[];
  total   integer;
BEGIN
  IF lang IS NULL OR lang NOT IN ('ar', 'en') THEN
    RAISE EXCEPTION 'a language is ar or en' USING ERRCODE = 'DK422', DETAIL = 'language';
  END IF;
  IF cardinality(coalesce(adds, '{}')) > 20000 THEN
    RAISE EXCEPTION 'at most 20,000 words a call' USING ERRCODE = 'DK422', DETAIL = 'add';
  END IF;
  IF cardinality(coalesce(removes, '{}')) > 20000 THEN
    RAISE EXCEPTION 'at most 20,000 words a call' USING ERRCODE = 'DK422', DETAIL = 'remove';
  END IF;
  WITH made AS (
    INSERT INTO word_guess_list (language, word)
    SELECT DISTINCT lang, word_norm(lang, a) FROM unnest(coalesce(adds, '{}')) a WHERE word_norm(lang, a) IS NOT NULL
    ON CONFLICT DO NOTHING RETURNING 1)
  SELECT count(*) INTO added FROM made;
  WITH gone AS (
    DELETE FROM word_guess_list g
    WHERE g.language = lang AND g.word IN (SELECT word_norm(lang, r) FROM unnest(coalesce(removes, '{}')) r)
    RETURNING 1)
  SELECT count(*) INTO removed FROM gone;
  refused := ARRAY(SELECT x FROM (
    SELECT a AS x, 1 AS part, n FROM unnest(coalesce(adds, '{}')) WITH ORDINALITY u (a, n) WHERE word_norm(lang, a) IS NULL
    UNION ALL
    SELECT r, 2, n FROM unnest(coalesce(removes, '{}')) WITH ORDINALITY u (r, n) WHERE word_norm(lang, r) IS NULL) bad
    ORDER BY bad.part, bad.n LIMIT 50);
  SELECT count(*) INTO total FROM word_guess_list g WHERE g.language = lang;
  PERFORM daily_audit(admin, 'word_list_changed', 'word_guess_list', lang,
                      jsonb_build_object('added', added, 'removed', removed, 'refused', cardinality(refused)), request);
  RETURN jsonb_build_object('added', added, 'removed', removed, 'refused', to_jsonb(refused), 'total', total);
END $$;
REVOKE ALL ON FUNCTION word_list_change(text, text[], text[], uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION word_list_change(text, text[], text[], uuid) TO questify_app;

-- Content of a kind left on a day that is not a period start (never served; the console offers to move or clear
-- it). Internal.
CREATE FUNCTION daily_unused(k text) RETURNS TABLE (language text, starts_on date)
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT NULL::text, c.starts_on FROM daily_challenge c WHERE k = 'challenge' AND NOT daily_period_start(k, c.starts_on)
  UNION ALL
  SELECT w.language, w.starts_on FROM daily_word w WHERE k = 'word' AND NOT daily_period_start(k, w.starts_on)
$$;
REVOKE ALL ON FUNCTION daily_unused(text) FROM PUBLIC;

-- Sets a kind's cadence from tomorrow (FR-1814; MAJOR-1, MAJOR-2). Locks every cadence row of the kind FOR UPDATE
-- (player doors hold today's governing one FOR KEY SHARE while they work out the period), then reads the clock once
-- and works out today, the governing row and tomorrow from that one read. Asking for the cadence in force today
-- drops any pending row and answers `unchanged`; otherwise tomorrow's row is written or replaced (the trigger refuses
-- it if 04:00 passed since the read). Answers the unused content count of the kind. DK422 kind or cadence. Audited
-- `daily.cadence_set`.
CREATE FUNCTION daily_cadence_set(k text, wanted text, request uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  admin    uuid := questify_admin();
  today    date;
  tomorrow date;
  in_force text;
  answer   jsonb;
BEGIN
  IF k IS NULL OR k NOT IN ('challenge', 'word') THEN
    RAISE EXCEPTION 'a kind is challenge or word' USING ERRCODE = 'DK422', DETAIL = 'kind';
  END IF;
  IF wanted IS NULL OR wanted NOT IN ('daily', 'weekly') THEN
    RAISE EXCEPTION 'a cadence is daily or weekly' USING ERRCODE = 'DK422', DETAIL = 'cadence';
  END IF;
  PERFORM 1 FROM daily_cadence c WHERE c.kind = k ORDER BY c.from_day FOR UPDATE;
  today := questify_day(clock_timestamp());
  tomorrow := today + 1;
  SELECT c.cadence INTO in_force FROM daily_cadence c WHERE c.kind = k AND c.from_day <= today
  ORDER BY c.from_day DESC LIMIT 1;
  IF wanted = in_force THEN
    DELETE FROM daily_cadence c WHERE c.kind = k AND c.from_day = tomorrow;
    answer := jsonb_build_object('kind', k, 'cadence', wanted, 'unchanged', true);
  ELSE
    INSERT INTO daily_cadence (kind, from_day, cadence, set_by) VALUES (k, tomorrow, wanted, admin)
    ON CONFLICT (kind, from_day) DO UPDATE SET cadence = excluded.cadence, set_by = excluded.set_by,
                                               created_at = now();
    answer := jsonb_build_object('kind', k, 'cadence', wanted, 'from', tomorrow);
  END IF;
  PERFORM daily_audit(admin, 'cadence_set', 'daily_cadence', k,
                      jsonb_build_object('cadence', wanted, 'from', CASE WHEN wanted <> in_force THEN tomorrow END),
                      request);
  RETURN answer || jsonb_build_object('unused', (SELECT count(*)::integer FROM daily_unused(k)));
END $$;
REVOKE ALL ON FUNCTION daily_cadence_set(text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION daily_cadence_set(text, text, uuid) TO questify_app;

-- ================================================================ the console's reads
-- The periods of a kind that touch [from_day, to_day], in order. Internal.
CREATE FUNCTION daily_spans(k text, from_day date, to_day date) RETURNS TABLE (starts_on date, ends_on date)
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  probe date := from_day;
  span  record;
BEGIN
  WHILE probe <= to_day LOOP
    SELECT p.starts_on, p.ends_on INTO span FROM daily_period(k, probe) p;
    IF span.starts_on IS NULL THEN
      probe := probe + 1;
    ELSE
      starts_on := span.starts_on;
      ends_on := span.ends_on;
      RETURN NEXT;
      probe := span.ends_on + 1;
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION daily_spans(text, date, date) FROM PUBLIC;

-- A kind's cadence today and the change pending for tomorrow, if any. Internal.
CREATE FUNCTION daily_cadence_json(k text) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'cadence', (SELECT c.cadence FROM daily_cadence c WHERE c.kind = k AND c.from_day <= questify_day(now())
                ORDER BY c.from_day DESC LIMIT 1),
    'next', (SELECT jsonb_build_object('cadence', c.cadence, 'from', c.from_day) FROM daily_cadence c
             WHERE c.kind = k AND c.from_day > questify_day(now()) ORDER BY c.from_day LIMIT 1))
$$;
REVOKE ALL ON FUNCTION daily_cadence_json(text) FROM PUBLIC;

-- The console's schedule (from_day to to_day, at most 120 days apart; DK422 range): the status of each kind (cadence,
-- the pending change, coverage and the warnings), every period with its content and Questify's own finish counts
-- (counts only, never players: ADR-067), and the unused content. Not audited: no personal data.
CREATE FUNCTION daily_console(from_day date, to_day date) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM questify_admin();
  IF from_day IS NULL OR to_day IS NULL OR to_day < from_day OR to_day - from_day > 120 THEN
    RAISE EXCEPTION 'a range of at most 120 days' USING ERRCODE = 'DK422', DETAIL = 'range';
  END IF;
  RETURN jsonb_build_object(
    'status', jsonb_build_object(
      'challenge', daily_cadence_json('challenge') || daily_cover_json('challenge', NULL),
      'word', daily_cadence_json('word') || jsonb_build_object('ar', daily_cover_json('word', 'ar'),
                                                               'en', daily_cover_json('word', 'en'))),
    'periods', (SELECT coalesce(jsonb_agg(p.body ORDER BY p.starts_on, p.kind), '[]'::jsonb) FROM (
      SELECT 'challenge' AS kind, s.starts_on, jsonb_build_object('kind', 'challenge', 'startsOn', s.starts_on,
        'endsOn', s.ends_on,
        'challenge', (SELECT daily_challenge_json(c) || jsonb_build_object('finishes',
                        (SELECT count(*)::integer FROM daily_finish f JOIN daily_play y ON y.id = f.play_id
                         WHERE y.challenge_id = c.id))
                      FROM daily_challenge c WHERE c.starts_on = s.starts_on)) AS body
      FROM daily_spans('challenge', from_day, to_day) s
      UNION ALL
      SELECT 'word', s.starts_on, jsonb_build_object('kind', 'word', 'startsOn', s.starts_on, 'endsOn', s.ends_on,
        'words', (SELECT coalesce(jsonb_object_agg(w.language, daily_word_json(w) || jsonb_build_object('finishes',
                    (SELECT count(*)::integer FROM daily_finish f JOIN daily_play y ON y.id = f.play_id
                     WHERE y.word_id = w.id))), '{}'::jsonb)
                  FROM daily_word w WHERE w.starts_on = s.starts_on))
      FROM daily_spans('word', from_day, to_day) s) p),
    'unused', (SELECT coalesce(jsonb_agg(jsonb_build_object('kind', u.kind, 'language', u.language,
                                                            'startsOn', u.starts_on)
                                         ORDER BY u.starts_on, u.kind, u.language), '[]'::jsonb)
               FROM (SELECT 'challenge' AS kind, x.language, x.starts_on FROM daily_unused('challenge') x
                     UNION ALL SELECT 'word', x.language, x.starts_on FROM daily_unused('word') x) u));
END $$;
REVOKE ALL ON FUNCTION daily_console(date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION daily_console(date, date) TO questify_app;

-- The question bank, newest first, with the right answers (admins write them): `status` ready, retired or NULL (all);
-- `before_id` the last question of the previous page; `page` 1 to 100 (50).
CREATE FUNCTION daily_question_list(wanted text, before_id uuid, page integer) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM questify_admin();
  IF wanted IS NOT NULL AND wanted NOT IN ('ready', 'retired') THEN
    RAISE EXCEPTION 'a status is ready or retired' USING ERRCODE = 'DK422', DETAIL = 'status';
  END IF;
  RETURN (SELECT coalesce(jsonb_agg(daily_question_json(q) ORDER BY q.created_at DESC, q.id DESC), '[]'::jsonb)
          FROM (SELECT d.* FROM daily_question d
                WHERE (wanted IS NULL OR d.status = wanted)
                  AND (before_id IS NULL OR (d.created_at, d.id) < (SELECT b.created_at, b.id FROM daily_question b
                                                                     WHERE b.id = before_id))
                ORDER BY d.created_at DESC, d.id DESC
                LIMIT least(greatest(coalesce(page, 50), 1), 100)) q);
END $$;
REVOKE ALL ON FUNCTION daily_question_list(text, uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION daily_question_list(text, uuid, integer) TO questify_app;

-- One page (100 words, page 1 first) of a language's guess list starting with `prefix` (normalized as a guess), and
-- how many words match.
CREATE FUNCTION word_list_page(lang text, prefix text, page integer) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  head text := coalesce(daily_fold(lang, prefix), '');
BEGIN
  PERFORM questify_admin();
  IF lang IS NULL OR lang NOT IN ('ar', 'en') THEN
    RAISE EXCEPTION 'a language is ar or en' USING ERRCODE = 'DK422', DETAIL = 'language';
  END IF;
  RETURN jsonb_build_object(
    'words', (SELECT coalesce(jsonb_agg(g.word ORDER BY g.word), '[]'::jsonb) FROM (
                SELECT l.word FROM word_guess_list l WHERE l.language = lang AND starts_with(l.word, head)
                ORDER BY l.word LIMIT 100 OFFSET (least(greatest(coalesce(page, 1), 1), 1000) - 1) * 100) g),
    'total', (SELECT count(*)::integer FROM word_guess_list l WHERE l.language = lang AND starts_with(l.word, head)));
END $$;
REVOKE ALL ON FUNCTION word_list_page(text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION word_list_page(text, text, integer) TO questify_app;
