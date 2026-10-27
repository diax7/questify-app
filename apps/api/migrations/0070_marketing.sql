-- T-407: marketing consent per channel with its dated log and opt-out, the player's interests and city, the event's
-- interests, and the "For you" list (ADR-316 to ADR-319; plan docs/plans/2026-10-27-t-407-marketing-preferences.md).
-- Deny by default: every new table keeps row-level security forced and no grant; every function is closed to PUBLIC in
-- the statement group that creates it and only the doors are granted to the API role. Deployed migrations and 0057 to
-- 0069 untouched; erase_rows is restated (0064's body plus the new deletes).
SET LOCAL lock_timeout = '10s';
-- Every existing table this migration alters or references, up front, at the strongest mode a later statement needs.
-- event first (ADD COLUMN); player and city are foreign-key targets. Never ledger_entry, enrollment, xp_entry or
-- platform_setting: nothing here sits in a payer's path.
LOCK TABLE event IN ACCESS EXCLUSIVE MODE;
LOCK TABLE player IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE city IN SHARE ROW EXCLUSIVE MODE;

-- ================================================================ the interest catalog (ADR-319)
-- Seeded and read-only until the console edits it (T-703/T-709), like `city`.
CREATE TABLE interest (
  id       text PRIMARY KEY CHECK (id ~ '^[a-z][a-z0-9-]{1,29}$'),
  name_ar  text NOT NULL CHECK (length(btrim(name_ar)) BETWEEN 1 AND 40
                                AND name_ar !~ '[\x01-\x1F\x7F-\x9F  -‏  ‪-‮⁦-⁩]'),
  name_en  text NOT NULL CHECK (length(btrim(name_en)) BETWEEN 1 AND 40
                                AND name_en !~ '[\x01-\x1F\x7F-\x9F  -‏  ‪-‮⁦-⁩]'),
  position smallint NOT NULL UNIQUE CHECK (position >= 1)
);
ALTER TABLE interest ENABLE ROW LEVEL SECURITY;
ALTER TABLE interest FORCE ROW LEVEL SECURITY;
REVOKE ALL ON interest FROM PUBLIC, questify_app;
INSERT INTO interest (id, name_ar, name_en, position) VALUES
  ('sport', 'رياضة', 'Sport', 1),
  ('music', 'موسيقى', 'Music', 2),
  ('tech', 'تقنية', 'Technology', 3),
  ('gaming', 'ألعاب', 'Gaming', 4),
  ('food', 'طعام', 'Food', 5),
  ('art', 'فنون', 'Arts', 6),
  ('culture', 'ثقافة', 'Culture', 7),
  ('learning', 'تعليم', 'Learning', 8),
  ('business', 'أعمال', 'Business', 9),
  ('family', 'عائلة', 'Family', 10),
  ('wellness', 'صحة', 'Wellness', 11),
  ('travel', 'سفر', 'Travel', 12);

CREATE FUNCTION interest_list() RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', i.id, 'name', jsonb_build_object('ar', i.name_ar, 'en', i.name_en))
    ORDER BY i.position), '[]'::jsonb) FROM interest i
$$;
REVOKE ALL ON FUNCTION interest_list() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION interest_list() TO questify_app;

-- Catalog ids only, no repeats, at most `top`, in catalog order; NULL when the list is not valid. Internal.
CREATE FUNCTION interests_clean(wanted text[], top integer) RETURNS text[]
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN wanted IS NULL OR array_ndims(wanted) IS DISTINCT FROM 1 AND cardinality(wanted) > 0 THEN NULL
    WHEN cardinality(wanted) > top THEN NULL
    WHEN cardinality(wanted) <> (SELECT count(DISTINCT w) FROM unnest(wanted) w) THEN NULL
    WHEN EXISTS (SELECT 1 FROM unnest(wanted) w WHERE NOT EXISTS (SELECT 1 FROM interest i WHERE i.id = w)) THEN NULL
    ELSE ARRAY(SELECT i.id FROM interest i WHERE i.id = ANY (wanted) ORDER BY i.position)
  END
$$;
REVOKE ALL ON FUNCTION interests_clean(text[], integer) FROM PUBLIC;

-- ================================================================ the event's interests (ADR-319)
-- The event team sets them under the event's own policy and column grant (the city_id precedent); the trigger keeps
-- them to catalog ids, at most 3, in catalog order.
ALTER TABLE event ADD COLUMN interests text[] NOT NULL DEFAULT '{}' CHECK (cardinality(interests) <= 3);
GRANT INSERT (interests), UPDATE (interests) ON event TO questify_app;

CREATE FUNCTION event_interests_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  clean text[] := interests_clean(NEW.interests, 3);
BEGIN
  IF clean IS NULL THEN
    RAISE EXCEPTION 'an event takes up to 3 distinct catalog interests' USING ERRCODE = 'EI422';
  END IF;
  NEW.interests := clean;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION event_interests_guard() FROM PUBLIC;
CREATE TRIGGER event_interests_guard BEFORE INSERT OR UPDATE OF interests ON event
  FOR EACH ROW WHEN (cardinality(NEW.interests) > 0) EXECUTE FUNCTION event_interests_guard();

-- ================================================================ the player's city and interests (FR-733)
-- Private to the player: no public profile, organizer or console door reads it. Written and read by the doors below.
CREATE TABLE player_preference (
  player_id  uuid PRIMARY KEY REFERENCES player (id) ON DELETE RESTRICT,
  city_id    text REFERENCES city (id),
  interests  text[] NOT NULL DEFAULT '{}' CHECK (cardinality(interests) <= 8),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX player_preference_city_idx ON player_preference (city_id) WHERE city_id IS NOT NULL;
CREATE INDEX player_preference_interests_idx ON player_preference USING gin (interests);
ALTER TABLE player_preference ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_preference FORCE ROW LEVEL SECURITY;
REVOKE ALL ON player_preference FROM PUBLIC, questify_app;

-- The caller as an active player, the row held FOR NO KEY UPDATE so one player's consent and preference writes run one
-- at a time (erase_player takes the same row FOR UPDATE first). PI401 otherwise. Internal.
CREATE FUNCTION marketing_player() RETURNS uuid
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  who uuid;
BEGIN
  SELECT p.id INTO who FROM player p WHERE p.id = app_player_id() AND p.status = 'active' FOR NO KEY UPDATE;
  IF who IS NULL THEN
    RAISE EXCEPTION 'active player required' USING ERRCODE = 'PI401';
  END IF;
  RETURN who;
END $$;
REVOKE ALL ON FUNCTION marketing_player() FROM PUBLIC;

CREATE FUNCTION own_preferences() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  who uuid := profile_player();
BEGIN
  IF who IS NULL THEN
    RAISE EXCEPTION 'active player required' USING ERRCODE = 'PI401';
  END IF;
  RETURN coalesce(
    (SELECT jsonb_build_object('cityId', f.city_id, 'interests', to_jsonb(f.interests))
     FROM player_preference f WHERE f.player_id = who),
    jsonb_build_object('cityId', NULL, 'interests', '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION own_preferences() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION own_preferences() TO questify_app;

-- Replaces the caller's city and interests (both given; a null city and an empty list clear them). PF422 with the field
-- in DETAIL for an unknown city, or interests that are unknown, repeated or more than 8.
CREATE FUNCTION set_preferences(chosen_city text, wanted text[]) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  who   uuid := marketing_player();
  clean text[] := interests_clean(coalesce(wanted, '{}'), 8);
BEGIN
  IF chosen_city IS NOT NULL AND NOT EXISTS (SELECT 1 FROM city c WHERE c.id = chosen_city) THEN
    RAISE EXCEPTION 'unknown city' USING ERRCODE = 'PF422', DETAIL = 'cityId';
  END IF;
  IF clean IS NULL THEN
    RAISE EXCEPTION 'interests are catalog ids, no repeats, at most 8' USING ERRCODE = 'PF422', DETAIL = 'interests';
  END IF;
  INSERT INTO player_preference (player_id, city_id, interests) VALUES (who, chosen_city, clean)
  ON CONFLICT (player_id) DO UPDATE SET city_id = EXCLUDED.city_id, interests = EXCLUDED.interests, updated_at = now();
  RETURN own_preferences();
END $$;
REVOKE ALL ON FUNCTION set_preferences(text, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_preferences(text, text[]) TO questify_app;

-- ================================================================ marketing consent (FR-735, FR-736, FR-1113, FR-1114)
-- The proof of consent: one row per change, with its channel, date, how it was given and the text version shown.
CREATE TABLE marketing_consent (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  player_id    uuid NOT NULL REFERENCES player (id) ON DELETE RESTRICT,
  channel      text NOT NULL CHECK (channel IN ('push', 'sms', 'email')),
  granted      boolean NOT NULL,
  method       text NOT NULL CHECK (method IN ('signup', 'settings', 'opt_out_link')),
  text_version text CHECK (text_version ~ '^[0-9]+(\.[0-9]+){0,2}$'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT granted OR text_version IS NOT NULL),
  CHECK (method <> 'opt_out_link' OR NOT granted)
);
CREATE INDEX marketing_consent_player_idx ON marketing_consent (player_id, id DESC);
ALTER TABLE marketing_consent ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_consent FORCE ROW LEVEL SECURITY;
REVOKE ALL ON marketing_consent FROM PUBLIC, questify_app;

-- Append-only for every role; erasure deletes under app.erasure (the player_acceptance precedent).
CREATE FUNCTION marketing_consent_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.erasure', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'consent records can never be changed or removed' USING ERRCODE = 'insufficient_privilege';
END $$;
REVOKE ALL ON FUNCTION marketing_consent_append_only() FROM PUBLIC;
CREATE TRIGGER marketing_consent_no_change BEFORE UPDATE OR DELETE ON marketing_consent
  FOR EACH ROW EXECUTE FUNCTION marketing_consent_append_only();
CREATE TRIGGER marketing_consent_no_truncate BEFORE TRUNCATE ON marketing_consent
  FOR EACH STATEMENT EXECUTE FUNCTION marketing_consent_append_only();
ALTER TABLE marketing_consent ENABLE ALWAYS TRIGGER marketing_consent_no_change;
ALTER TABLE marketing_consent ENABLE ALWAYS TRIGGER marketing_consent_no_truncate;

-- Where each channel stands now. Written only by the trigger below, so it cannot disagree with the log.
CREATE TABLE marketing_state (
  player_id  uuid NOT NULL REFERENCES player (id) ON DELETE RESTRICT,
  channel    text NOT NULL CHECK (channel IN ('push', 'sms', 'email')),
  opted_in   boolean NOT NULL,
  changed_at timestamptz NOT NULL,
  PRIMARY KEY (player_id, channel)
);
CREATE INDEX marketing_state_audience_idx ON marketing_state (channel, player_id) WHERE opted_in;
ALTER TABLE marketing_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE marketing_state FORCE ROW LEVEL SECURITY;
REVOKE ALL ON marketing_state FROM PUBLIC, questify_app;

CREATE FUNCTION marketing_state_apply() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO marketing_state (player_id, channel, opted_in, changed_at)
  VALUES (NEW.player_id, NEW.channel, NEW.granted, NEW.created_at)
  ON CONFLICT (player_id, channel) DO UPDATE SET opted_in = EXCLUDED.opted_in, changed_at = EXCLUDED.changed_at;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION marketing_state_apply() FROM PUBLIC;
CREATE TRIGGER marketing_consent_state AFTER INSERT ON marketing_consent
  FOR EACH ROW EXECUTE FUNCTION marketing_state_apply();

-- A birth year proves 18 only from the year after (ADR-317, Q-286): a possible minor is never offered or accepted for a
-- marketing channel. An erased player has no birth year. Internal.
CREATE FUNCTION marketing_adult(born smallint) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT born IS NOT NULL AND extract(year FROM now() AT TIME ZONE 'Asia/Riyadh')::integer - born >= 19
$$;
REVOKE ALL ON FUNCTION marketing_adult(smallint) FROM PUBLIC;

-- The caller's consent: each channel (off until a recorded yes), whether the sign-up step was answered, whether the
-- caller may opt in.
CREATE FUNCTION own_marketing() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  who uuid := profile_player();
BEGIN
  IF who IS NULL THEN
    RAISE EXCEPTION 'active player required' USING ERRCODE = 'PI401';
  END IF;
  RETURN jsonb_build_object(
    'channels', (SELECT jsonb_object_agg(c.channel, jsonb_build_object(
                   'optedIn', coalesce(s.opted_in, false), 'changedAt', s.changed_at))
                 FROM (VALUES ('push'), ('sms'), ('email')) c (channel)
                 LEFT JOIN marketing_state s ON s.player_id = who AND s.channel = c.channel),
    'asked', EXISTS (SELECT 1 FROM marketing_state s WHERE s.player_id = who),
    'canOptIn', marketing_adult((SELECT p.birth_year FROM player p WHERE p.id = who)));
END $$;
REVOKE ALL ON FUNCTION own_marketing() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION own_marketing() TO questify_app;

-- Sets channels the caller named: `channels` = {push?, sms?, email?} booleans, `how` signup or settings, `version` the
-- consent text shown. A row is logged for a channel whose state changes or has no state yet, so the sign-up step is
-- recorded even when every channel stays off. MK422 (field in DETAIL) for a bad body; MK403 `age` for a turn-on by a
-- possible minor; turning off is never refused.
CREATE FUNCTION set_marketing(channels jsonb, how text, version text) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  who   uuid := marketing_player();
  ch    text;
  val   jsonb;
  want  boolean;
  cur   boolean;
  adult boolean := marketing_adult((SELECT p.birth_year FROM player p WHERE p.id = who));
BEGIN
  IF how IS NULL OR how NOT IN ('signup', 'settings') THEN
    RAISE EXCEPTION 'unknown method' USING ERRCODE = 'MK422', DETAIL = 'method';
  END IF;
  IF version IS NULL OR version !~ '^[0-9]+(\.[0-9]+){0,2}$' THEN
    RAISE EXCEPTION 'unknown text version' USING ERRCODE = 'MK422', DETAIL = 'textVersion';
  END IF;
  IF channels IS NULL OR jsonb_typeof(channels) <> 'object' OR channels = '{}'::jsonb THEN
    RAISE EXCEPTION 'name at least one channel' USING ERRCODE = 'MK422', DETAIL = 'channels';
  END IF;
  FOR ch, val IN SELECT e.key, e.value FROM jsonb_each(channels) e LOOP
    IF ch NOT IN ('push', 'sms', 'email') OR jsonb_typeof(val) <> 'boolean' THEN
      RAISE EXCEPTION 'a channel is push, sms or email, set to true or false' USING ERRCODE = 'MK422', DETAIL = 'channels';
    END IF;
  END LOOP;
  FOR ch, val IN SELECT e.key, e.value FROM jsonb_each(channels) e ORDER BY e.key LOOP
    want := val::text::boolean;
    SELECT s.opted_in INTO cur FROM marketing_state s WHERE s.player_id = who AND s.channel = ch;
    IF want AND NOT adult AND cur IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'marketing needs a player of full legal capacity' USING ERRCODE = 'MK403', DETAIL = 'age';
    END IF;
    IF cur IS NULL OR cur <> want THEN
      INSERT INTO marketing_consent (player_id, channel, granted, method, text_version)
      VALUES (who, ch, want, how, CASE WHEN want THEN version END);
    END IF;
  END LOOP;
  RETURN own_marketing();
END $$;
REVOKE ALL ON FUNCTION set_marketing(jsonb, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_marketing(jsonb, text, text) TO questify_app;

-- The opt-out link's door (FR-1114): the API has checked the link's signature. Turns the channel off for an active or
-- banned player; `opted_out`, `already_off` (no record written) or `gone` (no such player, or an erased one).
CREATE FUNCTION marketing_opt_out(who uuid, ch text) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  held uuid;
BEGIN
  IF ch IS NULL OR ch NOT IN ('push', 'sms', 'email') THEN
    RAISE EXCEPTION 'unknown channel' USING ERRCODE = 'MK422', DETAIL = 'channel';
  END IF;
  SELECT p.id INTO held FROM player p WHERE p.id = who AND p.status IN ('active', 'banned') FOR NO KEY UPDATE;
  IF held IS NULL THEN
    RETURN 'gone';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM marketing_state s WHERE s.player_id = who AND s.channel = ch AND s.opted_in) THEN
    RETURN 'already_off';
  END IF;
  INSERT INTO marketing_consent (player_id, channel, granted, method) VALUES (who, ch, false, 'opt_out_link');
  RETURN 'opted_out';
END $$;
REVOKE ALL ON FUNCTION marketing_opt_out(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION marketing_opt_out(uuid, text) TO questify_app;

-- The recipients of a promotion on one channel (FR-737, FR-1111): active players opted in on it, optionally living in
-- `in_city` or holding any of `any_of`, by player id after `after_player`, at most 1000. Players who cannot opt in
-- (marketing_adult) are left out here too, so a promotion never reaches one by construction. The only door a promotional
-- sender may choose recipients through. Ids only.
CREATE FUNCTION marketing_audience(ch text, in_city text, any_of text[], after_player uuid, page integer)
  RETURNS TABLE (player_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.player_id
  FROM marketing_state s
  JOIN player p ON p.id = s.player_id AND p.status = 'active' AND marketing_adult(p.birth_year)
  LEFT JOIN player_preference f ON f.player_id = s.player_id
  WHERE s.channel = ch AND s.opted_in
    AND (after_player IS NULL OR s.player_id > after_player)
    AND (in_city IS NULL OR f.city_id = in_city)
    AND (any_of IS NULL OR cardinality(any_of) = 0 OR f.interests && any_of)
  ORDER BY s.player_id
  LIMIT least(greatest(coalesce(page, 100), 1), 1000)
$$;
REVOKE ALL ON FUNCTION marketing_audience(text, text, text[], uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION marketing_audience(text, text, text[], uuid, integer) TO questify_app;

-- A platform admin's read of one player's consent (FR-1113): where each channel stands and the log, newest first (the
-- latest 200), with one audit row per read. QY403 not an admin, QY404 no such player.
CREATE FUNCTION marketing_consent_history(target uuid, request uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  admin uuid := questify_admin();
BEGIN
  IF NOT EXISTS (SELECT 1 FROM player p WHERE p.id = target) THEN
    RAISE EXCEPTION 'no such player' USING ERRCODE = 'QY404';
  END IF;
  INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, request_id)
  VALUES ('admin', admin, 'marketing.consent_read', 'player', target::text, request);
  RETURN jsonb_build_object(
    'channels', (SELECT jsonb_object_agg(c.channel, jsonb_build_object(
                   'optedIn', coalesce(s.opted_in, false), 'changedAt', s.changed_at))
                 FROM (VALUES ('push'), ('sms'), ('email')) c (channel)
                 LEFT JOIN marketing_state s ON s.player_id = target AND s.channel = c.channel),
    'history', (SELECT coalesce(jsonb_agg(jsonb_build_object('channel', h.channel, 'granted', h.granted,
                  'method', h.method, 'textVersion', h.text_version, 'at', h.created_at) ORDER BY h.id DESC),
                  '[]'::jsonb)
                FROM (SELECT * FROM marketing_consent m WHERE m.player_id = target ORDER BY m.id DESC LIMIT 200) h));
END $$;
REVOKE ALL ON FUNCTION marketing_consent_history(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION marketing_consent_history(uuid, uuid) TO questify_app;

-- ================================================================ "For you" (FR-734, ADR-319)
-- Public events the list shows (scheduled or live) that the caller has not joined, matching the caller's interests or
-- city: both first, then interests, then the city; inside a group more shared interests, then the soonest start. At
-- most 20. Private and unlisted events and events the caller is in never appear.
CREATE FUNCTION own_for_you() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  who uuid := profile_player();
BEGIN
  IF who IS NULL THEN
    RAISE EXCEPTION 'active player required' USING ERRCODE = 'PI401';
  END IF;
  RETURN (
    WITH me AS (
      SELECT coalesce(f.interests, '{}') AS interests, f.city_id
      FROM (SELECT 1) one LEFT JOIN player_preference f ON f.player_id = who),
    hits AS (
      SELECT e.*, event_status_now(e.status, e.starts_at, e.ends_at) AS status_now,
             (SELECT count(*) FROM unnest(e.interests) i WHERE i = ANY (me.interests))::integer AS shared,
             (e.city_id IS NOT NULL AND e.city_id = me.city_id) AS same_city
      FROM me CROSS JOIN event e
      WHERE e.access = 'public' AND 'public_list' = ANY (e.join_methods)
        AND event_status_now(e.status, e.starts_at, e.ends_at) IN ('scheduled', 'live')
        AND NOT EXISTS (SELECT 1 FROM enrollment n WHERE n.event_id = e.id AND n.player_id = who)),
    top AS (
      SELECT h.* FROM hits h WHERE h.shared > 0 OR h.same_city
      ORDER BY (h.shared > 0 AND h.same_city) DESC, (h.shared > 0) DESC, h.shared DESC, h.starts_at, h.id
      LIMIT 20)
    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'id', t.id, 'joinCode', t.join_code,
        'name', jsonb_build_object('ar', t.name_ar, 'en', t.name_en),
        'venue', jsonb_build_object('ar', t.venue_ar, 'en', t.venue_en),
        'kind', t.kind, 'timezone', t.timezone, 'startsAt', t.starts_at, 'endsAt', t.ends_at,
        'statusNow', t.status_now,
        'city', (SELECT jsonb_build_object('ar', c.name_ar, 'en', c.name_en) FROM city c WHERE c.id = t.city_id),
        'interests', to_jsonb(t.interests))
      ORDER BY (t.shared > 0 AND t.same_city) DESC, (t.shared > 0) DESC, t.shared DESC, t.starts_at, t.id), '[]'::jsonb)
    FROM top t);
END $$;
REVOKE ALL ON FUNCTION own_for_you() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION own_for_you() TO questify_app;

-- ================================================================ erasure
-- 0064's body plus the preference, state and consent rows (the consent log under the erasure flag, Q-289).
CREATE OR REPLACE FUNCTION erase_rows(me uuid, enrolled uuid[], key bytea) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM 1 FROM player_xp x WHERE x.player_id = me FOR UPDATE;
  DELETE FROM player_equipment WHERE player_id = me;
  PERFORM set_config('app.erasure','on',true);
  DELETE FROM player_item WHERE player_id = me;
  DELETE FROM souvenir_receipt WHERE player_id = me;
  PERFORM set_config('app.erasure','',true);
  -- The append-only histories let a DELETE through under this flag only, for this transaction.
  PERFORM set_config('app.erasure', 'on', true);
  DELETE FROM username_history WHERE player_id = me;
  DELETE FROM player_acceptance WHERE player_id = me;
  DELETE FROM marketing_consent WHERE player_id = me;
  PERFORM set_config('app.erasure', '', true);
  DELETE FROM marketing_state WHERE player_id = me;
  DELETE FROM player_preference WHERE player_id = me;
  DELETE FROM player_fingerprint WHERE player_id = me;
  -- Open sign-in codes for the account's contacts (they hold the contact in clear).
  DELETE FROM player_login_challenge l
  WHERE l.contact_key = key
     OR l.contact IN (SELECT unnest(ARRAY[pc.phone_e164, pc.email]) FROM player_contact pc WHERE pc.player_id = me);
  DELETE FROM player_contact WHERE player_id = me;
  DELETE FROM player_contact_challenge WHERE player_id = me;
  DELETE FROM player_session WHERE player_id = me;
  DELETE FROM player_refresh WHERE player_id = me;
  DELETE FROM player_deletion_challenge WHERE player_id = me;
  DELETE FROM staff_assignment WHERE player_id = me;
  DELETE FROM ticket WHERE player_id = me;
  DELETE FROM join_answer WHERE enrollment_id = ANY (enrolled);
  DELETE FROM flag WHERE enrollment_id = ANY (enrolled);
  DELETE FROM completion_position WHERE enrollment_id = ANY (enrolled);
  DELETE FROM meeting m WHERE m.scanner_enrollment = ANY (enrolled) OR m.shown_enrollment = ANY (enrolled);
  DELETE FROM meet_pass p WHERE p.enrollment_id = ANY (enrolled);
  UPDATE quest_completion SET device_id = NULL WHERE enrollment_id = ANY (enrolled) AND device_id IS NOT NULL;
  UPDATE ledger_note t SET reason = NULL
  FROM ledger_entry l WHERE l.id = t.entry_id AND l.enrollment_id = ANY (enrolled) AND t.reason IS NOT NULL;
  UPDATE enrollment n
  SET status = CASE WHEN n.status IN ('active', 'pending') THEN 'left' ELSE n.status END,
      waitlisted = false, goal_reward_id = NULL, redeem_paused_at = NULL
  WHERE n.id = ANY (enrolled);
  UPDATE submission s
  SET body = NULL, reason = CASE WHEN s.reason_system THEN s.reason END, erased_at = now()
  WHERE s.enrollment_id = ANY (enrolled) AND s.erased_at IS NULL;
  DELETE FROM quest_vote WHERE enrollment_id = ANY (enrolled);
  DELETE FROM survey_response WHERE enrollment_id = ANY (enrolled);
  DELETE FROM category_bonus WHERE enrollment_id = ANY (enrolled);
  DELETE FROM category_reveal WHERE enrollment_id = ANY (enrolled);
  DELETE FROM quest_item_miss WHERE enrollment_id = ANY (enrolled);
  DELETE FROM passport_stamp WHERE enrollment_id = ANY (enrolled);
  DELETE FROM quiz_answer a USING quiz_attempt t WHERE t.id = a.attempt_id AND t.enrollment_id = ANY (enrolled);
  DELETE FROM game_round g WHERE g.enrollment_id = ANY (enrolled);
  -- Last: the staff_assignment delete above enqueues while the enrollments are still active (enqueue_souvenir_on_staff).
  DELETE FROM souvenir_work WHERE enrollment_id = ANY (enrolled);
  UPDATE player
  SET status = 'deleted', deleted_at = now(), username = NULL, birth_year = NULL, avatar = 'falcon',
      my_qr_version = my_qr_version + 1
  WHERE id = me;
END $$;
REVOKE ALL ON FUNCTION erase_rows(uuid,uuid[],bytea) FROM PUBLIC;
