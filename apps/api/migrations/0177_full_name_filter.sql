-- The word lists on a full name (FOLLOWUPS batch 23, T-615 follow-up, ADR-817). A full name shown to other players is
-- free text the player typed; the username lists (FR-118, ADR-119) now check it the same way:
--   (1) at the join, a Full name answer holding a listed word is refused (JA422, DETAIL `name:<field id>`), so the join
--       rolls back and the card points at the field;
--   (2) where a name is read for other players (`public_full_name`), a stored name that fails, given before this check or
--       before a word was added to the lists, shows by username, so no such name reaches the ranking, the results or the
--       big screen.
-- Only the word lists: a name is never refused for being Arabic, short, a real person's name, or a username an admin
-- retired (`username_retired` is for usernames only). The staff read (`staff_full_name`) is unchanged: the organizer's
-- staff already receive the answer as typed.
-- New: `full_name_blocked` (internal, no grant). Restated with the same arguments, so their owner and grants stay:
-- check_join_answers (as 0037, plus the check in (1)), public_full_name (as 0109, plus the check in (2)). Nothing here
-- writes points or XP, changes a sign-in, a tenant rule or a redemption. 0176 and earlier untouched.
SET LOCAL lock_timeout = '10s';

-- ================================================================ the check
-- The name as other players would see it (`display_name_text`: invisible and direction characters gone, the first 60
-- characters), Arabic marks and tatweel dropped, folded like a username (`username_fold`), and every run of characters a
-- username could not hold made `_`, so a space or a dot separates words as `_` does in a username. Then the word-list
-- half of `username_blocked` (0016, 0118), unchanged: a `word` entry matches a whole word; a `part` entry matches
-- anywhere with the separators and digits removed, or with the digit spellings read as letters. Internal; no SET
-- clause, as `username_blocked`, so it is inlined (ADR-670).
CREATE FUNCTION full_name_blocked(name text) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  WITH folded AS (
    SELECT regexp_replace(
             username_fold(regexp_replace(coalesce(display_name_text(name), ''),
               '[̀-ͯؐ-ؚـً-ٰٟۖ-ۜ۟-۪ۤۧۨ-ۭ]',
               '', 'g')),
             '[^a-zء-غف-ي0-9]+', '_', 'g') AS v),
  forms AS (
    SELECT regexp_split_to_array(v, '[_0-9]+') AS tokens,
           regexp_replace(v, '[_0-9]', '', 'g') AS bare,
           regexp_replace(translate(v, '013457', 'oieast'), '[_0-9]', '', 'g') AS mapped
    FROM folded)
  SELECT EXISTS (
    SELECT 1 FROM username_word w, forms
    WHERE (w.match = 'word' AND w.word = ANY (forms.tokens))
       OR (w.match = 'part' AND (position(w.word IN forms.bare) > 0 OR position(w.word IN forms.mapped) > 0)))
$$;
REVOKE ALL ON FUNCTION full_name_blocked(text) FROM PUBLIC;

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
-- As 0109, plus: a name `full_name_blocked` refuses is not given, so the player shows by username.
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
    AND NOT full_name_blocked(a.value)
$$;
REVOKE ALL ON FUNCTION public_full_name(uuid) FROM PUBLIC;
