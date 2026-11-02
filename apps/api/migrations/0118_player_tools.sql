-- Player tools for the console (T-704, plan docs/plans/2026-11-02-t-704-t-705-player-safety.md section 3; FR-1774,
-- FR-1775, FR-1702): find a player, a read-only record with the points record, a contact reveal, an admin rename and a
-- sign-in reset. Every door is for an active platform admin (`console_admin`, QE403 otherwise), takes a reason code and
-- a note for every action, and writes an audit entry with ids and codes only; notes and usernames live in the new
-- `player_admin_action` rows, which erasure deletes. A sign-in reset ends every token through a cutoff
-- (`player.tokens_valid_after`) that the token checks read, so no token issuer takes a new lock (plan, Race (D6)).
-- Deny by default: the two new tables keep row-level security forced and no grant; every new function is revoked from
-- PUBLIC in the group that creates it and only the six doors are granted to questify_app. Deployed migrations untouched.
SET LOCAL lock_timeout = '10s';

-- ================================================================ the sign-in cutoff (ADR-421)
-- A token (access or refresh) issued by a transaction that started at or before this moment is refused at its next use.
-- Set only by admin_reset_player_sign_in; readable with the rest of the player row, writable by definers only.
ALTER TABLE player ADD COLUMN tokens_valid_after timestamptz;

-- As 0012, plus the cutoff.
CREATE OR REPLACE FUNCTION player_session_owner(hash bytea) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.player_id FROM player_session s JOIN player p ON p.id = s.player_id
  WHERE s.token_hash = hash AND s.revoked_at IS NULL AND s.expires_at > now() AND p.status = 'active'
    AND s.created_at > coalesce(p.tokens_valid_after, '-infinity'::timestamptz)
$$;
REVOKE ALL ON FUNCTION player_session_owner(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION player_session_owner(bytea) TO questify_app;

-- As 0013, plus the cutoff: a refresh token issued before the player's last sign-in reset is `invalid` and ends its
-- family, exactly as a token of a player who is no longer active.
CREATE OR REPLACE FUNCTION rotate_player_refresh(presented bytea, access_hash bytea, refresh_hash bytea)
  RETURNS TABLE (outcome text, player_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  found_refresh player_refresh%ROWTYPE;
  successor     player_refresh%ROWTYPE;
  owner_status  text;
  cutoff        timestamptz;
BEGIN
  SELECT * INTO found_refresh FROM player_refresh r WHERE r.token_hash = presented FOR UPDATE;
  IF NOT FOUND OR found_refresh.expires_at <= now() THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid;
    RETURN;
  END IF;
  IF found_refresh.revoked_at IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM player_refresh r WHERE r.family = found_refresh.family AND r.revoked_at IS NULL) THEN
      PERFORM revoke_family(found_refresh.family);
      INSERT INTO audit_log (actor_type, action, target_type, target_id)
      VALUES ('system', 'player.refresh_reuse', 'player', found_refresh.player_id::text);
      RETURN QUERY SELECT 'reused'::text, NULL::uuid;
      RETURN;
    END IF;
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid;
    RETURN;
  END IF;
  SELECT p.status, p.tokens_valid_after INTO owner_status, cutoff FROM player p WHERE p.id = found_refresh.player_id;
  IF owner_status <> 'active' OR found_refresh.created_at <= coalesce(cutoff, '-infinity'::timestamptz) THEN
    PERFORM revoke_family(found_refresh.family);
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid;
    RETURN;
  END IF;
  IF found_refresh.used_at IS NOT NULL THEN
    SELECT * INTO successor FROM player_refresh r WHERE r.id = found_refresh.replaced_by FOR UPDATE;
    IF found_refresh.used_at > now() - interval '60 seconds' AND successor.used_at IS NULL
       AND successor.revoked_at IS NULL THEN
      UPDATE player_refresh SET revoked_at = now() WHERE id = successor.id;
    ELSE
      PERFORM revoke_family(found_refresh.family);
      INSERT INTO audit_log (actor_type, action, target_type, target_id)
      VALUES ('system', 'player.refresh_reuse', 'player', found_refresh.player_id::text);
      RETURN QUERY SELECT 'reused'::text, NULL::uuid;
      RETURN;
    END IF;
  END IF;
  UPDATE player_session SET revoked_at = now() WHERE refresh_family = found_refresh.family AND revoked_at IS NULL;
  PERFORM issue_player_tokens(found_refresh.player_id, access_hash, refresh_hash, found_refresh.family);
  UPDATE player_refresh
  SET used_at = coalesce(used_at, now()),
      replaced_by = (SELECT r.id FROM player_refresh r WHERE r.token_hash = refresh_hash)
  WHERE id = found_refresh.id;
  RETURN QUERY SELECT 'rotated'::text, found_refresh.player_id;
END $$;
REVOKE ALL ON FUNCTION rotate_player_refresh(bytea, bytea, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rotate_player_refresh(bytea, bytea, bytea) TO questify_app;

-- ================================================================ admin renames and retired names (ADR-420)
ALTER TABLE username_history DROP CONSTRAINT username_history_reason_check;
ALTER TABLE username_history ADD CONSTRAINT username_history_reason_check
  CHECK (reason IN ('signup', 'rename', 'admin'));

-- As 0038, plus `admin`: a rename made by admin_rename_player (which sets the transaction's flag while an admin is
-- seated) is recorded as `admin`, so the player's own change window, which counts `rename` rows only, is untouched.
CREATE OR REPLACE FUNCTION record_username() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO username_history (player_id, username, reason) VALUES (NEW.id, NEW.username, 'signup');
  ELSIF NEW.username IS DISTINCT FROM OLD.username AND NEW.username IS NOT NULL THEN
    INSERT INTO username_history (player_id, username, reason)
    VALUES (NEW.id, NEW.username,
            CASE WHEN current_setting('app.username_reason', true) = 'admin' AND app_admin_id() IS NOT NULL
                 THEN 'admin' ELSE 'rename' END);
  END IF;
  RETURN NULL;
END $$;

-- A name an admin took away, folded, with no player id: nobody takes it again (sign-up and rename refuse it as
-- blocked). The console's word-list page will un-retire one (T-705).
CREATE TABLE username_retired (
  fold       text PRIMARY KEY CHECK (char_length(fold) BETWEEN 3 AND 30),
  retired_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE username_retired ENABLE ROW LEVEL SECURITY;
ALTER TABLE username_retired FORCE ROW LEVEL SECURITY;
REVOKE ALL ON username_retired FROM PUBLIC;

-- As 0016, plus the retired names. Its callers are definers (create_player, rename_player, admin_rename_player).
CREATE OR REPLACE FUNCTION username_blocked(name text) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  WITH folded AS (SELECT username_fold(name) AS v),
  forms AS (
    SELECT regexp_split_to_array(v, '[_0-9]+') AS tokens,
           regexp_replace(v, '[_0-9]', '', 'g') AS bare,
           regexp_replace(translate(v, '013457', 'oieast'), '[_0-9]', '', 'g') AS mapped
    FROM folded)
  SELECT EXISTS (
    SELECT 1 FROM username_word w, forms
    WHERE (w.match = 'word' AND w.word = ANY (forms.tokens))
       OR (w.match = 'part' AND (position(w.word IN forms.bare) > 0 OR position(w.word IN forms.mapped) > 0)))
    OR EXISTS (SELECT 1 FROM username_retired r, folded WHERE r.fold = folded.v)
$$;
REVOKE ALL ON FUNCTION username_blocked(text) FROM PUBLIC;

-- The console's username search is a folded prefix; `_` is escaped in the pattern.
CREATE INDEX player_username_prefix ON player (username_fold(username) text_pattern_ops) WHERE username IS NOT NULL;
-- The record's "contacts last changed" reads the newest contact change of one player.
CREATE INDEX audit_log_contact_change_idx ON audit_log (target_id, at) WHERE action = 'player.contact_change';

-- ================================================================ what Questify did to an account (ADR-419)
-- One row per admin action on a player: the reason code, the internal note and, for a rename, both names. The
-- record's "Questify actions". Append-only; erasure deletes the player's rows under `app.erasure`.
CREATE TABLE player_admin_action (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id     uuid NOT NULL REFERENCES player (id),
  admin_id      uuid NOT NULL REFERENCES staff_user (id),
  kind          text NOT NULL CHECK (kind IN ('rename', 'reset_sign_in', 'contact_reveal')),
  reason_code   text NOT NULL CHECK (reason_code ~ '^[a-z][a-z_]{1,31}$'),
  note          text NOT NULL CHECK (char_length(note) BETWEEN 10 AND 300),
  from_username text,
  to_username   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'rename') = (from_username IS NOT NULL AND to_username IS NOT NULL)),
  CHECK (kind = 'rename' OR (from_username IS NULL AND to_username IS NULL))
);
CREATE INDEX player_admin_action_player_idx ON player_admin_action (player_id, created_at DESC);
CREATE INDEX player_admin_action_admin_idx ON player_admin_action (admin_id);
ALTER TABLE player_admin_action ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_admin_action FORCE ROW LEVEL SECURITY;
REVOKE ALL ON player_admin_action FROM PUBLIC;

CREATE FUNCTION player_admin_action_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.erasure', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'player admin actions can never be changed or removed' USING ERRCODE = 'insufficient_privilege';
END $$;
REVOKE ALL ON FUNCTION player_admin_action_append_only() FROM PUBLIC;
CREATE TRIGGER player_admin_action_no_change BEFORE UPDATE OR DELETE ON player_admin_action
  FOR EACH ROW EXECUTE FUNCTION player_admin_action_append_only();
CREATE TRIGGER player_admin_action_no_truncate BEFORE TRUNCATE ON player_admin_action
  FOR EACH STATEMENT EXECUTE FUNCTION player_admin_action_append_only();
ALTER TABLE player_admin_action ENABLE ALWAYS TRIGGER player_admin_action_no_change;
ALTER TABLE player_admin_action ENABLE ALWAYS TRIGGER player_admin_action_no_truncate;

-- The reason codes each action accepts (the console's lists, packages/shared) and the note: 10 to 300 characters
-- without control or direction characters (as T-702's texts). PA400 otherwise. Returns the trimmed note.
CREATE FUNCTION player_action_note(action_kind text, code text, note text) RETURNS text
  LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
BEGIN
  IF code IS NULL OR NOT (code = ANY (CASE action_kind
       WHEN 'contact_reveal' THEN ARRAY['support_request', 'legal_request']
       WHEN 'rename' THEN ARRAY['offensive', 'impersonation', 'personal_data', 'spam', 'other']
       WHEN 'reset_sign_in' THEN ARRAY['lost_access', 'compromised', 'locked_out', 'other']
       ELSE ARRAY[]::text[] END)) THEN
    RAISE EXCEPTION 'unknown reason code for %', action_kind USING ERRCODE = 'PA400';
  END IF;
  IF note IS NULL OR char_length(btrim(note)) NOT BETWEEN 10 AND 300
     OR note ~ '[[:cntrl:]\u2028\u2029\u202A-\u202E\u2066-\u2069]' THEN
    RAISE EXCEPTION 'a note of 10 to 300 characters is required' USING ERRCODE = 'PA400';
  END IF;
  RETURN btrim(note);
END $$;
REVOKE ALL ON FUNCTION player_action_note(text, text, text) FROM PUBLIC;

-- The player a door acts on: an account that is not erased, locked when asked. PA404 for an unknown id or a tombstone
-- (nothing there to act on; FR-1776 has no restore).
CREATE FUNCTION player_for_admin(target uuid, lock_it boolean) RETURNS player
  LANGUAGE plpgsql VOLATILE SET search_path = public, pg_temp AS $$
DECLARE
  hit player;
BEGIN
  IF lock_it THEN
    SELECT p.* INTO hit FROM player p WHERE p.id = target FOR NO KEY UPDATE;
  ELSE
    SELECT p.* INTO hit FROM player p WHERE p.id = target;
  END IF;
  IF NOT FOUND OR hit.status = 'deleted' THEN
    RAISE EXCEPTION 'no such player' USING ERRCODE = 'PA404';
  END IF;
  RETURN hit;
END $$;
REVOKE ALL ON FUNCTION player_for_admin(uuid, boolean) FROM PUBLIC;

-- Masked contacts: the country code and first digit, then the last two digits; the first letter of an email's name and
-- its domain. The full values leave the database only through console_player_contact.
CREATE FUNCTION contact_masked(phone text, email text) RETURNS jsonb
  LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'phone', CASE WHEN phone IS NOT NULL THEN left(phone, 5) || '•••••' || right(phone, 2) END,
    'email', CASE WHEN email IS NOT NULL
                  THEN left(split_part(email, '@', 1), 1) || '•••@' || split_part(email, '@', 2) END)
$$;
REVOKE ALL ON FUNCTION contact_masked(text, text) FROM PUBLIC;

-- ================================================================ the personal notice of a rename (ADR-420)
-- Fixed text with no name and no reason (push text leaves the country); opens the center.
INSERT INTO notice_kind (kind, class, topic, membership, before_start, priority, ttl) VALUES
  ('username_changed', 'personal', NULL, 'none', false, 0, interval '7 days');

-- ================================================================ find a player (FR-1774)
-- By username: a folded prefix of at least 3 characters, 20 rows. By phone or email: the exact normalized value (the
-- API normalizes), never a pattern, so a contact cannot be enumerated. Tombstones are never found. One audit entry with
-- how the search was made, how many rows and their ids: never the text searched for. PA400 for a bad search.
CREATE FUNCTION console_player_search(search_by text, q text, request uuid) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me    uuid := console_admin();
  key     text := btrim(coalesce(q, ''));
  -- The folded prefix with LIKE's own characters escaped (a username may hold `_`).
  pattern text := replace(replace(replace(username_fold(key), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  hits    jsonb;
BEGIN
  IF search_by NOT IN ('username', 'phone', 'email') OR char_length(key) NOT BETWEEN 3 AND 254
     OR (search_by = 'phone' AND key !~ '^\+966[0-9]{9}$') THEN
    RAISE EXCEPTION 'a username of 3 or more characters, a phone or an email is required' USING ERRCODE = 'PA400';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', m.id, 'username', m.username, 'avatar', m.avatar, 'status', m.status, 'createdAt', m.created_at,
           'contacts', contact_masked(m.phone_e164, m.email)) ORDER BY m.ord, m.id), '[]'::jsonb)
    INTO hits
    FROM (SELECT p.id, p.username, p.avatar, p.status, p.created_at, pc.phone_e164, pc.email,
                 username_fold(p.username) AS ord
          FROM (SELECT x.id FROM player x
                WHERE search_by = 'username' AND x.username IS NOT NULL
                  AND username_fold(x.username) LIKE pattern
                UNION ALL
                SELECT c.player_id FROM player_contact c WHERE search_by = 'phone' AND c.phone_e164 = key
                UNION ALL
                SELECT c.player_id FROM player_contact c WHERE search_by = 'email' AND c.email = lower(key)) f
          JOIN player p ON p.id = f.id
          LEFT JOIN player_contact pc ON pc.player_id = p.id
          WHERE p.status <> 'deleted'
          ORDER BY username_fold(p.username), p.id
          LIMIT 20) m;
  INSERT INTO audit_log (actor_type, actor_id, action, target_type, after, request_id)
  VALUES ('admin', me, 'console.players_search', 'player',
          jsonb_build_object('by', search_by, 'count', jsonb_array_length(hits),
                             'playerIds', (SELECT coalesce(jsonb_agg(x -> 'id'), '[]'::jsonb)
                                           FROM jsonb_array_elements(hits) x)),
          request);
  RETURN hits;
END $$;
REVOKE ALL ON FUNCTION console_player_search(text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_player_search(text, text, uuid) TO questify_app;

-- ================================================================ the read-only record (FR-1774, FR-1702)
-- The events a player is in, newest first (200 at most): the event and its organizer, the membership, the score, and
-- whether the event's exclusion list names one of the player's contacts (an event ban by phone or email domain).
CREATE FUNCTION console_player_events(target uuid) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'eventId', x.event_id, 'event', jsonb_build_object('ar', x.name_ar, 'en', x.name_en),
           'organizer', x.organizer, 'status', x.status, 'score', x.score, 'joinedAt', x.joined_at,
           'excluded', x.excluded) ORDER BY x.joined_at DESC, x.event_id), '[]'::jsonb)
  FROM (SELECT n.event_id, e.name_ar, e.name_en, o.name AS organizer, n.status, n.score, n.joined_at,
               excluded_from_event(n.event_id, n.player_id) AS excluded
        FROM enrollment n JOIN event e ON e.id = n.event_id JOIN organizer o ON o.id = n.organizer_id
        WHERE n.player_id = target
        ORDER BY n.joined_at DESC, n.event_id LIMIT 200) x
$$;
REVOKE ALL ON FUNCTION console_player_events(uuid) FROM PUBLIC;

-- Flags raised on the player's memberships (100 newest) and the report tickets that name the player, counted per event
-- (the reports' text stays with the event team).
CREATE FUNCTION console_player_flags_reports(target uuid) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'flags', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', f.id, 'eventId', f.event_id, 'kind', f.kind, 'status', f.status,
                                          'raisedAt', f.raised_at) ORDER BY f.raised_at DESC, f.id DESC)
      FROM (SELECT g.* FROM flag g JOIN enrollment n ON n.id = g.enrollment_id
            WHERE n.player_id = target ORDER BY g.raised_at DESC, g.id DESC LIMIT 100) f), '[]'::jsonb),
    'reports', coalesce((
      SELECT jsonb_agg(jsonb_build_object('eventId', r.event_id, 'total', r.total, 'open', r.open)
                       ORDER BY r.event_id)
      FROM (SELECT t.event_id, count(*)::integer AS total, count(*) FILTER (WHERE t.status = 'open')::integer AS open
            FROM ticket t JOIN enrollment n ON n.id = t.reported_enrollment_id
            WHERE n.player_id = target AND t.kind = 'report_player'
            GROUP BY t.event_id) r), '[]'::jsonb))
$$;
REVOKE ALL ON FUNCTION console_player_flags_reports(uuid) FROM PUBLIC;

-- One account for the console, read-only, with one audit entry (ids only). An erased account answers its id, status
-- and dates only. Contacts are masked; when they last changed comes from T-108's own audit entries (channel and kind,
-- never the value). Sessions: live sign-ins (refresh families) issued after the last reset.
CREATE FUNCTION console_player_record(target uuid, request uuid) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me     uuid := console_admin();
  p      player;
  answer jsonb;
BEGIN
  SELECT x.* INTO p FROM player x WHERE x.id = target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such player' USING ERRCODE = 'PA404';
  END IF;
  IF p.status = 'deleted' THEN
    answer := jsonb_build_object('player', jsonb_build_object('id', p.id, 'status', p.status,
                                                              'createdAt', p.created_at, 'deletedAt', p.deleted_at));
  ELSE
    answer := jsonb_build_object(
      'player', jsonb_build_object(
        'id', p.id, 'username', p.username, 'avatar', p.avatar, 'status', p.status, 'createdAt', p.created_at,
        'level', coalesce((SELECT x.level FROM player_xp x WHERE x.player_id = p.id), 1),
        'xp', coalesce((SELECT x.xp FROM player_xp x WHERE x.player_id = p.id), 0)),
      'contacts', coalesce((SELECT contact_masked(pc.phone_e164, pc.email)
                            FROM player_contact pc WHERE pc.player_id = p.id),
                           jsonb_build_object('phone', NULL, 'email', NULL)),
      'contactsChanged', (SELECT jsonb_build_object('at', a.at, 'channel', a.after ->> 'channel',
                                                    'kind', a.after ->> 'kind')
                          FROM audit_log a
                          WHERE a.action = 'player.contact_change' AND a.target_id = p.id::text
                          ORDER BY a.at DESC LIMIT 1),
      'usernames', coalesce((SELECT jsonb_agg(jsonb_build_object('username', h.username, 'reason', h.reason,
                                                                 'changedAt', h.changed_at)
                                              ORDER BY h.changed_at DESC, h.id DESC)
                             FROM (SELECT * FROM username_history u WHERE u.player_id = p.id
                                   ORDER BY u.changed_at DESC, u.id DESC LIMIT 50) h), '[]'::jsonb),
      'events', console_player_events(p.id),
      'sessions', (SELECT count(DISTINCT r.family)::integer FROM player_refresh r
                   WHERE r.player_id = p.id AND r.revoked_at IS NULL AND r.expires_at > now()
                     AND r.created_at > coalesce(p.tokens_valid_after, '-infinity'::timestamptz)),
      'actions', coalesce((SELECT jsonb_agg(jsonb_build_object(
                                    'id', a.id, 'kind', a.kind, 'reasonCode', a.reason_code, 'note', a.note,
                                    'fromUsername', a.from_username, 'toUsername', a.to_username,
                                    'by', s.email, 'at', a.created_at) ORDER BY a.created_at DESC, a.id)
                           FROM (SELECT * FROM player_admin_action x WHERE x.player_id = p.id
                                 ORDER BY x.created_at DESC LIMIT 100) a
                           JOIN staff_user s ON s.id = a.admin_id), '[]'::jsonb))
      || console_player_flags_reports(p.id);
  END IF;
  INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, request_id)
  VALUES ('admin', me, 'console.player_read', 'player', p.id::text, request);
  RETURN answer;
END $$;
REVOKE ALL ON FUNCTION console_player_record(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_player_record(uuid, uuid) TO questify_app;

-- The points record of a player, newest first, 50 a page (`before`: the last id of the page before), all events or
-- one. Each entry: its kind, the score and balance change, the quest or reward it was for, when, and who made it as a
-- kind only (player, system, operator, staff); ledger notes are not shown. One audit entry per page (ids only).
CREATE FUNCTION console_player_ledger(target uuid, only_event uuid, before bigint, request uuid) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me      uuid := console_admin();
  p       player;
  entries jsonb;
BEGIN
  SELECT x.* INTO p FROM player x WHERE x.id = target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such player' USING ERRCODE = 'PA404';
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'id', l.id, 'eventId', l.event_id, 'kind', l.kind, 'score', l.score_delta, 'balance', l.balance_delta,
           'quest', CASE WHEN q.id IS NOT NULL THEN jsonb_build_object('ar', q.title_ar, 'en', q.title_en) END,
           'reward', CASE WHEN w.id IS NOT NULL THEN jsonb_build_object('ar', w.name_ar, 'en', w.name_en) END,
           'actor', l.actor, 'rehearsal', l.rehearsal, 'at', l.created_at) ORDER BY l.id DESC), '[]'::jsonb)
    INTO entries
    FROM (SELECT x.* FROM ledger_entry x JOIN enrollment n ON n.id = x.enrollment_id
          WHERE n.player_id = p.id AND (only_event IS NULL OR x.event_id = only_event)
            AND (before IS NULL OR x.id < before)
          ORDER BY x.id DESC LIMIT 50) l
    LEFT JOIN quest q ON q.id = l.quest_id
    LEFT JOIN redemption r ON r.id = l.redemption_id
    LEFT JOIN reward w ON w.id = r.reward_id;
  INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, after, request_id)
  VALUES ('admin', me, 'console.player_ledger_read', 'player', p.id::text,
          jsonb_build_object('eventId', only_event, 'count', jsonb_array_length(entries)), request);
  RETURN entries;
END $$;
REVOKE ALL ON FUNCTION console_player_ledger(uuid, uuid, bigint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_player_ledger(uuid, uuid, bigint, uuid) TO questify_app;

-- ================================================================ the contact reveal (ADR-422)
-- The full phone and email, to answer a verified support or legal request: a reason code and a note, a
-- `contact_reveal` action row and an audit entry on every call (the API keeps no copy and never replays one).
CREATE FUNCTION console_player_contact(target uuid, reason_code text, note text, request uuid) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me     uuid := console_admin();
  clean  text := player_action_note('contact_reveal', reason_code, note);
  p      player := player_for_admin(target, false);
  action uuid;
  shown  jsonb;
BEGIN
  INSERT INTO player_admin_action (player_id, admin_id, kind, reason_code, note)
  VALUES (p.id, me, 'contact_reveal', reason_code, clean) RETURNING id INTO action;
  INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, after, request_id)
  VALUES ('admin', me, 'console.player_contact_read', 'player', p.id::text,
          jsonb_build_object('actionId', action, 'reasonCode', reason_code), request);
  SELECT jsonb_build_object('phone', pc.phone_e164, 'email', pc.email) INTO shown
    FROM player_contact pc WHERE pc.player_id = p.id;
  RETURN coalesce(shown, jsonb_build_object('phone', NULL, 'email', NULL));
END $$;
REVOKE ALL ON FUNCTION console_player_contact(uuid, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_player_contact(uuid, text, text, uuid) TO questify_app;

-- ================================================================ the admin rename (FR-1775, ADR-420)
-- Same characters, folding, uniqueness and word lists as a player's own change, not bound by the player's change window
-- and not using it up. The old name is retired. The player gets a personal notice with fixed text. Locks the player
-- row as rename_player does, so the two run one after the other. Outcomes: invalid (characters), unchanged,
-- username_blocked (a listed word or a retired name), username_taken, renamed. PA404 for a tombstone or unknown id.
CREATE FUNCTION admin_rename_player(target uuid, new_name text, reason_code text, note text, request uuid)
  RETURNS TABLE (outcome text, action_id uuid)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me     uuid := console_admin();
  clean  text := player_action_note('rename', reason_code, note);
  p      player := player_for_admin(target, true);
  action uuid;
BEGIN
  IF new_name IS NULL OR new_name !~ '^[ء-غف-يA-Za-z0-9_]{3,30}$' THEN
    RETURN QUERY SELECT 'invalid'::text, NULL::uuid;
    RETURN;
  END IF;
  IF p.username = new_name THEN
    RETURN QUERY SELECT 'unchanged'::text, NULL::uuid;
    RETURN;
  END IF;
  IF username_blocked(new_name) THEN
    RETURN QUERY SELECT 'username_blocked'::text, NULL::uuid;
    RETURN;
  END IF;
  PERFORM set_config('app.username_reason', 'admin', true);
  BEGIN
    UPDATE player SET username = new_name WHERE id = p.id;
  EXCEPTION WHEN unique_violation THEN
    PERFORM set_config('app.username_reason', '', true);
    RETURN QUERY SELECT 'username_taken'::text, NULL::uuid;
    RETURN;
  END;
  PERFORM set_config('app.username_reason', '', true);
  INSERT INTO username_retired (fold) VALUES (username_fold(p.username)) ON CONFLICT DO NOTHING;
  INSERT INTO player_admin_action (player_id, admin_id, kind, reason_code, note, from_username, to_username)
  VALUES (p.id, me, 'rename', reason_code, clean, p.username, new_name) RETURNING id INTO action;
  PERFORM notice_create('username_changed', NULL, NULL, p.id, '{}'::jsonb, '{}'::jsonb,
                        'username_changed:' || action, NULL);
  INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, after, request_id)
  VALUES ('admin', me, 'player.admin_rename', 'player', p.id::text,
          jsonb_build_object('actionId', action, 'reasonCode', reason_code), request);
  RETURN QUERY SELECT 'renamed'::text, action;
END $$;
REVOKE ALL ON FUNCTION admin_rename_player(uuid, text, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_rename_player(uuid, text, text, text, uuid) TO questify_app;

-- ================================================================ the sign-in reset (FR-1775, ADR-421)
-- Removes access only: the admin never sees, sets or sends a code, a contact or a token. In this order (plan, Race
-- (D6)): the player row FOR NO KEY UPDATE (never waits for a token insert's foreign-key check); the player's open
-- codes (sign-in by contact, contact change, deletion) so a sign-in holding its code finishes first; every refresh and
-- access token in one UPDATE each; the push devices and their queued sends; then the cutoff, taken last with
-- clock_timestamp(), so a token issued by any transaction that started before it is refused. The API clears the
-- contacts' code and failure throttles in the same transaction. Works on an active or banned account; PA404 otherwise.
CREATE FUNCTION admin_reset_player_sign_in(target uuid, reason_code text, note text, request uuid)
  RETURNS TABLE (action_id uuid, ended integer)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me       uuid := console_admin();
  clean    text := player_action_note('reset_sign_in', reason_code, note);
  p        player := player_for_admin(target, true);
  action   uuid;
  families integer;
BEGIN
  DELETE FROM player_login_challenge l
  WHERE l.contact IN (SELECT unnest(ARRAY[pc.phone_e164, pc.email]) FROM player_contact pc WHERE pc.player_id = p.id);
  DELETE FROM player_contact_challenge WHERE player_id = p.id;
  DELETE FROM player_deletion_challenge WHERE player_id = p.id;
  WITH revoked AS (
    UPDATE player_refresh SET revoked_at = now() WHERE player_id = p.id AND revoked_at IS NULL RETURNING family)
  SELECT count(DISTINCT family)::integer INTO families FROM revoked;
  UPDATE player_session SET revoked_at = now() WHERE player_id = p.id AND revoked_at IS NULL;
  DELETE FROM push_send s USING push_device d WHERE s.device_id = d.id AND d.player_id = p.id;
  DELETE FROM push_device WHERE player_id = p.id;
  UPDATE player SET tokens_valid_after = clock_timestamp() WHERE id = p.id;
  INSERT INTO player_admin_action (player_id, admin_id, kind, reason_code, note)
  VALUES (p.id, me, 'reset_sign_in', reason_code, clean) RETURNING id INTO action;
  INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, after, request_id)
  VALUES ('admin', me, 'player.reset_sign_in', 'player', p.id::text,
          jsonb_build_object('actionId', action, 'reasonCode', reason_code, 'endedFamilies', families), request);
  RETURN QUERY SELECT action, families;
END $$;
REVOKE ALL ON FUNCTION admin_reset_player_sign_in(uuid, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_reset_player_sign_in(uuid, text, text, uuid) TO questify_app;

-- ================================================================ erasure
-- As 0107, plus the account's admin action rows (they hold notes and usernames), deleted under the erasure flag. The
-- retired names hold no player id and stay.
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
  DELETE FROM player_admin_action WHERE player_id = me;
  PERFORM set_config('app.erasure', '', true);
  DELETE FROM marketing_state WHERE player_id = me;
  DELETE FROM player_preference WHERE player_id = me;
  DELETE FROM invitation_recipient WHERE player_id = me;
  DELETE FROM notice WHERE player_id = me;
  DELETE FROM notification WHERE player_id = me;
  DELETE FROM push_send s USING push_device d WHERE s.device_id = d.id AND d.player_id = me;
  DELETE FROM push_device WHERE player_id = me;
  DELETE FROM push_topic_mute WHERE player_id = me;
  DELETE FROM push_topic_on WHERE player_id = me;
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
  -- After the assignment delete and the enrollment update: the order accept_desk_sale locks in (T-612).
  UPDATE desk_sale s SET status = 'withdrawn', ended_at = now() WHERE s.operator_id = me AND s.status = 'offered';
  DELETE FROM desk_sale s WHERE s.enrollment_id = ANY (enrolled);
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
