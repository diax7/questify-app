-- Reports and moderation (T-705b, plan docs/plans/2026-11-02-t-704-t-705-player-safety.md section 5; FR-1404, FR-1411,
-- FR-1413, FR-1414, FR-1727): a player reports a quest, a reward, an announcement, a category, a session, a sponsor, an
-- event or a username; Questify's queue in the console groups the open reports by what they name; a platform admin
-- unpublishes a quest, a reward or an announcement and publishes it again; and the console lists the open anti-cheat
-- flags of every event.
--
-- A report keeps what was reported (`snapshot`), so a later edit or deletion still shows it. A reported username inside
-- an event also opens T-312's `report_player` ticket to the event team in the same transaction (Q-219, ADR-433). An
-- unpublish is a `content_hold` row: a quest is kept hidden (its team cannot show it while held, HD423), a reward leaves
-- the shop, the goal, the desk and the reserve door, an announcement leaves the players' lists and the center and is
-- skipped if it was still scheduled. Completions, the ledger and redemptions are never touched.
--
-- Deny by default: `content_report` keeps row-level security forced with no grant; `content_hold` is readable by the
-- API's role only through its policy (the event's own team, or an admin), never written by it; `reward.held_at` has no
-- update grant. Every new function is revoked from PUBLIC in the group that creates it and only the doors are granted
-- to questify_app. Deployed migrations untouched; the restated functions say which migration they restate.
SET LOCAL lock_timeout = '10s';

-- ================================================================ holds (FR-1414, ADR-434)
-- One row per unpublish; `released_*` when it was published again. One live hold per target. `note` is shown to the
-- organizer (as a suspension's reason is, Q-372); `was_visible` is a quest's `visible` before the hold, restored after.
CREATE TABLE content_hold (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         text NOT NULL CHECK (kind IN ('quest', 'reward', 'announcement')),
  target_id    uuid NOT NULL,
  organizer_id uuid NOT NULL,
  event_id     uuid NOT NULL,
  reason_code  text NOT NULL CHECK (reason_code IN ('offensive', 'hateful', 'sexual', 'spam', 'misleading', 'other')),
  note         text NOT NULL CHECK (char_length(note) BETWEEN 10 AND 300),
  was_visible  boolean,
  held_by      uuid NOT NULL REFERENCES staff_user (id),
  held_at      timestamptz NOT NULL DEFAULT now(),
  released_at  timestamptz,
  released_by  uuid REFERENCES staff_user (id),
  release_note text CHECK (char_length(release_note) BETWEEN 10 AND 300),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE CASCADE,
  CONSTRAINT content_hold_release CHECK (
    (released_at IS NULL) = (released_by IS NULL) AND (released_at IS NULL) = (release_note IS NULL)),
  CONSTRAINT content_hold_visible CHECK ((kind = 'quest') = (was_visible IS NOT NULL))
);
CREATE UNIQUE INDEX content_hold_live ON content_hold (kind, target_id) WHERE released_at IS NULL;
CREATE INDEX content_hold_event ON content_hold (event_id, held_at DESC);
ALTER TABLE content_hold ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_hold FORCE ROW LEVEL SECURITY;
REVOKE ALL ON content_hold FROM PUBLIC, questify_app;
-- The event's team reads its own holds (the dashboard shows why an item is gone); an admin reads all. Nobody but the
-- two doors writes one.
GRANT SELECT ON content_hold TO questify_app;
CREATE POLICY content_hold_team ON content_hold FOR SELECT TO questify_app
  USING ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope())) OR app_is_admin());

-- A reward held by Questify: no grant to write it (questify_app's UPDATE on reward is column by column).
ALTER TABLE reward ADD COLUMN held_at timestamptz;

-- Whether a target has a live hold. Reads past row-level security (the owner's), for every reader of a held item.
CREATE FUNCTION content_held(hold_kind text, target uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM content_hold h
                 WHERE h.kind = hold_kind AND h.target_id = target AND h.released_at IS NULL)
$$;
REVOKE ALL ON FUNCTION content_held(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION content_held(text, uuid) TO questify_app;

-- A held quest stays hidden: nobody but the two doors (which set `app.content_hold`) shows it again (HD423, answered
-- once by the API as content_held).
CREATE FUNCTION quest_hold_guard() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.visible AND NOT OLD.visible AND current_setting('app.content_hold', true) IS DISTINCT FROM 'on'
     AND content_held('quest', NEW.id) THEN
    RAISE EXCEPTION 'Questify unpublished this quest' USING ERRCODE = 'HD423';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION quest_hold_guard() FROM PUBLIC;
CREATE TRIGGER quest_hold_guard BEFORE UPDATE OF visible ON quest
  FOR EACH ROW EXECUTE FUNCTION quest_hold_guard();

-- ================================================================ reports (FR-1411, FR-1413, ADR-433)
-- One row per report. `target_id` is the reported row's id (the player's id for a username); `event_id` is NULL only for
-- a username reported outside an event. `reporter_id` is NULL after the reporter's erasure. Handled reports go 180 days
-- after handling (purge_handled_reports, the lifecycle tick).
CREATE TABLE content_report (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid REFERENCES player (id),
  event_id    uuid REFERENCES event (id) ON DELETE CASCADE,
  target_kind text NOT NULL CHECK (target_kind IN ('quest', 'reward', 'announcement', 'category', 'session', 'sponsor',
                                                   'event', 'username')),
  target_id   uuid NOT NULL,
  snapshot    jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object' AND octet_length(snapshot::text) <= 4096),
  reason      text NOT NULL CHECK (reason IN ('offensive', 'hateful', 'sexual', 'spam', 'misleading', 'other')),
  note        text CHECK (char_length(note) BETWEEN 1 AND 500),
  marked      boolean NOT NULL DEFAULT false,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'actioned', 'dismissed')),
  outcome     text CHECK (outcome IN ('dismissed', 'unpublished', 'event_suspended', 'username_changed',
                                      'player_banned')),
  handled_by  uuid REFERENCES staff_user (id),
  handled_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT content_report_handled CHECK (
    (status = 'open') = (outcome IS NULL) AND (status = 'open') = (handled_at IS NULL)
    AND (status = 'open') = (handled_by IS NULL)),
  CONSTRAINT content_report_dismissed CHECK ((status = 'dismissed') = (outcome IS NOT DISTINCT FROM 'dismissed')),
  CONSTRAINT content_report_event CHECK (target_kind = 'username' OR event_id IS NOT NULL)
);
-- One open report per reporter and target; the queue's open targets; the caps; the purge; erasure by target.
CREATE UNIQUE INDEX content_report_open_once ON content_report (reporter_id, target_kind, target_id)
  WHERE status = 'open' AND reporter_id IS NOT NULL;
CREATE INDEX content_report_open ON content_report (target_kind, target_id, created_at) WHERE status = 'open';
CREATE INDEX content_report_reporter ON content_report (reporter_id, created_at) WHERE reporter_id IS NOT NULL;
CREATE INDEX content_report_handled_at ON content_report (handled_at) WHERE status <> 'open';
CREATE INDEX content_report_event ON content_report (event_id) WHERE event_id IS NOT NULL;
ALTER TABLE content_report ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_report FORCE ROW LEVEL SECURITY;
REVOKE ALL ON content_report FROM PUBLIC, questify_app;

-- A pair of texts as {ar, en}, each cut to `size` characters; absent languages left out.
CREATE FUNCTION report_pair(ar text, en text, size integer) RETURNS jsonb
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object('ar', left(ar, size), 'en', left(en, size)))
$$;
REVOKE ALL ON FUNCTION report_pair(text, text, integer) FROM PUBLIC;

-- What a target says now: {title, text} in both languages (titles 120 characters, texts 300, so the 4 KB cap holds even
-- for four-byte characters), or {username} for a player. NULL when it is gone (or an erased player).
CREATE FUNCTION report_snapshot(target_kind text, target uuid) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE target_kind
    WHEN 'quest' THEN (SELECT jsonb_build_object('title', report_pair(q.title_ar, q.title_en, 120),
                                                 'text', report_pair(q.description_ar, q.description_en, 300))
                       FROM quest q WHERE q.id = target)
    WHEN 'reward' THEN (SELECT jsonb_build_object('title', report_pair(r.name_ar, r.name_en, 120),
                                                  'text', report_pair(r.description_ar, r.description_en, 300))
                        FROM reward r WHERE r.id = target)
    WHEN 'announcement' THEN (SELECT jsonb_build_object('title', report_pair(a.title_ar, a.title_en, 120),
                                                        'text', report_pair(a.body_ar, a.body_en, 300))
                              FROM announcement a WHERE a.id = target)
    WHEN 'category' THEN (SELECT jsonb_build_object('title', report_pair(c.name_ar, c.name_en, 120))
                          FROM category c WHERE c.id = target)
    WHEN 'session' THEN (SELECT jsonb_build_object('title', report_pair(s.title_ar, s.title_en, 120),
                                                   'text', report_pair(s.description_ar, s.description_en, 300))
                         FROM event_session s WHERE s.id = target)
    WHEN 'sponsor' THEN (SELECT jsonb_build_object('title', report_pair(s.name_ar, s.name_en, 120))
                         FROM sponsor s WHERE s.id = target)
    WHEN 'event' THEN (SELECT jsonb_build_object('title', report_pair(e.name_ar, e.name_en, 120),
                                                 'text', report_pair(e.rules_ar, e.rules_en, 300))
                       FROM event e WHERE e.id = target)
    WHEN 'username' THEN (SELECT jsonb_build_object('username', p.username)
                          FROM player p WHERE p.id = target AND p.username IS NOT NULL)
  END
$$;
REVOKE ALL ON FUNCTION report_snapshot(text, uuid) FROM PUBLIC;

-- The event a target belongs to; NULL for an unknown target (and for a username, which belongs to none).
CREATE FUNCTION report_event(target_kind text, target uuid) RETURNS uuid
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE target_kind
    WHEN 'quest' THEN (SELECT q.event_id FROM quest q WHERE q.id = target)
    WHEN 'reward' THEN (SELECT r.event_id FROM reward r WHERE r.id = target)
    WHEN 'announcement' THEN (SELECT a.event_id FROM announcement a WHERE a.id = target)
    WHEN 'category' THEN (SELECT c.event_id FROM category c WHERE c.id = target)
    WHEN 'session' THEN (SELECT s.event_id FROM event_session s WHERE s.id = target)
    WHEN 'sponsor' THEN (SELECT s.event_id FROM sponsor s WHERE s.id = target)
    WHEN 'event' THEN (SELECT e.id FROM event e WHERE e.id = target)
  END
$$;
REVOKE ALL ON FUNCTION report_event(text, uuid) FROM PUBLIC;

-- Whether the member can see the target (the plan's visibility rule): a visible quest they may play, a reward of their
-- shop that is not unpublished, an announcement sent to them, a category they see; the event's sessions, sponsors and
-- page to any active member.
CREATE FUNCTION report_target_seen(target_kind text, target uuid, mine enrollment) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE target_kind
    WHEN 'quest' THEN member_sees_quest(mine.id, target)
    WHEN 'reward' THEN EXISTS (SELECT 1 FROM reward r
                               WHERE r.id = target AND r.status = 'active' AND r.held_at IS NULL
                                 AND in_audience(mine.id, r.audience_kind, r.audience_field_id, r.audience_values))
    WHEN 'announcement' THEN EXISTS (SELECT 1 FROM announcement a
                                     WHERE a.id = target AND a.status = 'sent'
                                       AND a.rehearsal = (mine.joined_via IS NOT DISTINCT FROM 'rehearsal')
                                       AND NOT content_held('announcement', a.id))
    WHEN 'category' THEN EXISTS (SELECT 1 FROM category c WHERE c.id = target AND sees_category(mine.id, c))
    ELSE true
  END
$$;
REVOKE ALL ON FUNCTION report_target_seen(text, uuid, enrollment) FROM PUBLIC;

-- The fixed text of the team's ticket for a username reported in an event (both languages; no player text).
CREATE FUNCTION report_ticket_text(why text) RETURNS text
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT 'بلاغ عن اسم مستخدم من التطبيق: '
         || CASE why WHEN 'offensive' THEN 'مسيء' WHEN 'hateful' THEN 'يحض على الكراهية' WHEN 'sexual' THEN 'جنسي'
                     WHEN 'spam' THEN 'إزعاج' WHEN 'misleading' THEN 'مضلل' ELSE 'سبب آخر' END
         || E'.\n' || 'A username was reported in the app: '
         || CASE why WHEN 'offensive' THEN 'offensive' WHEN 'hateful' THEN 'hateful' WHEN 'sexual' THEN 'sexual'
                     WHEN 'spam' THEN 'spam' WHEN 'misleading' THEN 'misleading' ELSE 'another reason' END || '.'
$$;
REVOKE ALL ON FUNCTION report_ticket_text(text) FROM PUBLIC;

-- The reporter's caps, counted in the database while the reporter's advisory lock is held: 10 an hour, 30 a day (RP429,
-- DETAIL hour or day).
CREATE FUNCTION report_caps(me uuid) RETURNS void
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
BEGIN
  IF (SELECT count(*) FROM content_report r
      WHERE r.reporter_id = me AND r.created_at > now() - interval '1 hour') >= 10 THEN
    RAISE EXCEPTION 'ten reports in an hour' USING ERRCODE = 'RP429', DETAIL = 'hour';
  END IF;
  IF (SELECT count(*) FROM content_report r
      WHERE r.reporter_id = me AND r.created_at > now() - interval '1 day') >= 30 THEN
    RAISE EXCEPTION 'thirty reports in a day' USING ERRCODE = 'RP429', DETAIL = 'day';
  END IF;
END $$;
REVOKE ALL ON FUNCTION report_caps(uuid) FROM PUBLIC;

-- A username reported inside an event: the team's `report_player` ticket too (T-312), when the event's help desk is on
-- and the event is not archived; one open report per reporter and reported member, so a second is not opened.
CREATE FUNCTION report_open_ticket(me uuid, mine enrollment, theirs uuid, why text, report uuid) RETURNS void
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  ev event;
BEGIN
  SELECT e.* INTO ev FROM event e WHERE e.id = mine.event_id;
  IF NOT help_desk_on(ev) OR ev.status = 'archived' THEN
    RETURN;
  END IF;
  INSERT INTO ticket (player_id, organizer_id, event_id, enrollment_id, reported_enrollment_id, kind, body, marked,
                      idempotency_key)
  VALUES (me, mine.organizer_id, mine.event_id, mine.id, theirs, 'report_player', report_ticket_text(why), false,
          'report:' || report)
  ON CONFLICT DO NOTHING;
END $$;
REVOKE ALL ON FUNCTION report_open_ticket(uuid, enrollment, uuid, text, uuid) FROM PUBLIC;

-- The calling player's report (FR-1411). `target` names the row for every kind but a username, which is named by
-- `chosen_name`; `in_event` is the event a username was reported in (NULL: a Questify-wide profile). The reporter must
-- be an active player who can see the target: an active member of its event, or for a username any active player (an
-- active member of `in_event`, reporting another active member of it). The note is cleaned (SV422) and marked by the
-- word lists (FR-1628), never blocked. Outcomes: reported, already_reported (one open report per reporter and target).
-- RP404 for anything the reporter cannot see (no oracle), RP422 for a kind or a reason not in the lists or a note over
-- 500 characters, RP429 for the caps.
CREATE FUNCTION report_content(target_kind text, target uuid, chosen_name text, in_event uuid, why text, note text)
  RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me      uuid := app_player_id();
  ev_id   uuid;
  mine    enrollment;
  theirs  enrollment;
  named   uuid := target;
  cleaned text;
  shot    jsonb;
  made    uuid;
BEGIN
  IF me IS NULL OR app_device_id() IS NOT NULL
     OR NOT EXISTS (SELECT 1 FROM player p WHERE p.id = me AND p.status = 'active') THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF target_kind IS NULL OR target_kind NOT IN ('quest', 'reward', 'announcement', 'category', 'session', 'sponsor',
                                                'event', 'username')
     OR why IS NULL OR why NOT IN ('offensive', 'hateful', 'sexual', 'spam', 'misleading', 'other') THEN
    RAISE EXCEPTION 'a kind and a reason from the lists' USING ERRCODE = 'RP422';
  END IF;
  IF note IS NOT NULL AND btrim(note) <> '' THEN
    cleaned := clean_submission_text(note);
    IF char_length(cleaned) > 500 THEN
      RAISE EXCEPTION 'a note of at most 500 characters' USING ERRCODE = 'RP422';
    END IF;
  END IF;
  IF target_kind = 'username' THEN
    SELECT p.id INTO named FROM player p
    WHERE username_fold(p.username) = username_fold(chosen_name) AND p.status = 'active' AND p.id <> me;
    ev_id := in_event;
  ELSE
    ev_id := report_event(target_kind, target);
  END IF;
  IF ev_id IS NOT NULL THEN
    SELECT n.* INTO mine FROM enrollment n WHERE n.event_id = ev_id AND n.player_id = me AND n.status = 'active';
  END IF;
  IF named IS NULL OR (ev_id IS NULL AND (target_kind <> 'username' OR in_event IS NOT NULL))
     OR (ev_id IS NOT NULL AND mine.id IS NULL) THEN
    RAISE EXCEPTION 'nothing to report there' USING ERRCODE = 'RP404';
  END IF;
  IF target_kind = 'username' AND ev_id IS NOT NULL THEN
    SELECT n.* INTO theirs FROM enrollment n WHERE n.event_id = ev_id AND n.player_id = named AND n.status = 'active';
    IF theirs.id IS NULL THEN
      RAISE EXCEPTION 'nothing to report there' USING ERRCODE = 'RP404';
    END IF;
  ELSIF target_kind <> 'username' AND NOT report_target_seen(target_kind, target, mine) THEN
    RAISE EXCEPTION 'nothing to report there' USING ERRCODE = 'RP404';
  END IF;

  -- One reporter at a time: the duplicate check and the caps hold under concurrent reports.
  PERFORM pg_advisory_xact_lock(hashtextextended('content_report:' || me, 0));
  IF EXISTS (SELECT 1 FROM content_report r
             WHERE r.reporter_id = me AND r.target_kind = report_content.target_kind AND r.target_id = named
               AND r.status = 'open') THEN
    RETURN 'already_reported';
  END IF;
  PERFORM report_caps(me);
  shot := report_snapshot(target_kind, named);
  INSERT INTO content_report (reporter_id, event_id, target_kind, target_id, snapshot, reason, note, marked)
  VALUES (me, ev_id, target_kind, named, shot, why, cleaned, cleaned IS NOT NULL AND text_marked(cleaned))
  RETURNING id INTO made;
  IF theirs.id IS NOT NULL THEN
    PERFORM report_open_ticket(me, mine, theirs.id, why, made);
  END IF;
  RETURN 'reported';
END $$;
REVOKE ALL ON FUNCTION report_content(text, uuid, text, uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION report_content(text, uuid, text, uuid, text, text) TO questify_app;

-- ================================================================ unpublish (FR-1414, ADR-434)
-- The admin's note on an unpublish or a republish: 10 to 300 characters, no control or direction characters (HD400).
CREATE FUNCTION hold_note(note text) RETURNS text
  LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
BEGIN
  IF note IS NULL OR char_length(btrim(note)) NOT BETWEEN 10 AND 300
     OR note ~ '[[:cntrl:]\u2028\u2029\u202A-\u202E\u2066-\u2069]' THEN
    RAISE EXCEPTION 'a note of 10 to 300 characters is required' USING ERRCODE = 'HD400';
  END IF;
  RETURN btrim(note);
END $$;
REVOKE ALL ON FUNCTION hold_note(text) FROM PUBLIC;

-- The target row, locked FOR UPDATE so two admins at once are one after the other: its event and organizer, and a
-- quest's `visible`. HD404 for an unknown target or a removed reward; HD400 for a kind that cannot be held.
CREATE FUNCTION hold_target(hold_kind text, target uuid, OUT ev_id uuid, OUT org_id uuid, OUT shown boolean)
  LANGUAGE plpgsql VOLATILE SET search_path = public, pg_temp AS $$
BEGIN
  IF hold_kind = 'quest' THEN
    SELECT q.event_id, q.organizer_id, q.visible INTO ev_id, org_id, shown FROM quest q WHERE q.id = target FOR UPDATE;
  ELSIF hold_kind = 'reward' THEN
    SELECT r.event_id, r.organizer_id INTO ev_id, org_id FROM reward r
    WHERE r.id = target AND r.status = 'active' FOR UPDATE;
  ELSIF hold_kind = 'announcement' THEN
    SELECT a.event_id, a.organizer_id INTO ev_id, org_id FROM announcement a WHERE a.id = target FOR UPDATE;
  ELSE
    RAISE EXCEPTION 'only a quest, a reward or an announcement is unpublished' USING ERRCODE = 'HD400';
  END IF;
  IF ev_id IS NULL THEN
    RAISE EXCEPTION 'nothing to unpublish there' USING ERRCODE = 'HD404';
  END IF;
END $$;
REVOKE ALL ON FUNCTION hold_target(text, uuid) FROM PUBLIC;

-- Unpublishes a quest, a reward or an announcement (FR-1414). Works on a suspended event too. Closes every open report
-- of the target as `unpublished`, alerts the organizer's members (`content_unpublished`, ids only; their switches
-- decide), and audits `content.unpublish` with the event (the event's log shows Questify did it, ADR-409). Outcomes:
-- unpublished, already_unpublished (with the live hold).
CREATE FUNCTION admin_unpublish(hold_kind text, target uuid, reason_code text, note text, request uuid)
  RETURNS TABLE (outcome text, hold_id uuid)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me    uuid := console_admin();
  clean text := hold_note(note);
  t     record;
  live  uuid;
  made  uuid;
BEGIN
  IF reason_code IS NULL OR reason_code NOT IN ('offensive', 'hateful', 'sexual', 'spam', 'misleading', 'other') THEN
    RAISE EXCEPTION 'unknown reason code' USING ERRCODE = 'HD400';
  END IF;
  t := hold_target(hold_kind, target);
  SELECT h.id INTO live FROM content_hold h
  WHERE h.kind = hold_kind AND h.target_id = target AND h.released_at IS NULL;
  IF live IS NOT NULL THEN
    RETURN QUERY SELECT 'already_unpublished'::text, live;
    RETURN;
  END IF;
  INSERT INTO content_hold (kind, target_id, organizer_id, event_id, reason_code, note, was_visible, held_by)
  VALUES (hold_kind, target, t.org_id, t.ev_id, reason_code, clean, CASE WHEN hold_kind = 'quest' THEN t.shown END, me)
  RETURNING id INTO made;
  IF hold_kind = 'quest' AND t.shown THEN
    PERFORM set_config('app.content_hold', 'on', true);
    UPDATE quest SET visible = false WHERE id = target;
    PERFORM set_config('app.content_hold', '', true);
  ELSIF hold_kind = 'reward' THEN
    UPDATE reward SET held_at = now() WHERE id = target;
  END IF;
  UPDATE content_report r SET status = 'actioned', outcome = 'unpublished', handled_by = me, handled_at = now()
  WHERE r.target_kind = hold_kind AND r.target_id = target AND r.status = 'open';
  PERFORM alert_enqueue(t.org_id, t.ev_id, 'content_unpublished', 'hold:' || made);
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after, request_id)
  VALUES ('admin', me, t.org_id, t.ev_id, 'content.unpublish', hold_kind, target::text,
          jsonb_build_object('holdId', made, 'reasonCode', reason_code), request);
  RETURN QUERY SELECT 'unpublished'::text, made;
END $$;
REVOKE ALL ON FUNCTION admin_unpublish(text, uuid, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_unpublish(text, uuid, text, text, uuid) TO questify_app;

-- Publishes a held item again: a quest gets back the `visible` it had, a reward returns to the shop, an announcement to
-- the lists (one skipped while held stays skipped). Audited `content.republish`. Outcomes: republished, not_unpublished.
CREATE FUNCTION admin_republish(hold_kind text, target uuid, note text, request uuid) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me    uuid := console_admin();
  clean text := hold_note(note);
  t     record;
  hold  content_hold;
BEGIN
  t := hold_target(hold_kind, target);
  SELECT h.* INTO hold FROM content_hold h
  WHERE h.kind = hold_kind AND h.target_id = target AND h.released_at IS NULL FOR UPDATE;
  IF hold.id IS NULL THEN
    RETURN 'not_unpublished';
  END IF;
  UPDATE content_hold SET released_at = now(), released_by = me, release_note = clean WHERE id = hold.id;
  IF hold_kind = 'quest' AND hold.was_visible THEN
    PERFORM set_config('app.content_hold', 'on', true);
    UPDATE quest SET visible = true WHERE id = target;
    PERFORM set_config('app.content_hold', '', true);
  ELSIF hold_kind = 'reward' THEN
    UPDATE reward SET held_at = NULL WHERE id = target;
  END IF;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after, request_id)
  VALUES ('admin', me, t.org_id, t.ev_id, 'content.republish', hold_kind, target::text,
          jsonb_build_object('holdId', hold.id), request);
  RETURN 'republished';
END $$;
REVOKE ALL ON FUNCTION admin_republish(text, uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_republish(text, uuid, text, uuid) TO questify_app;

-- ================================================================ what a hold hides (ADR-434)
-- As 0107, plus: a held reward is not in the shop for anyone (RN404, as a removed one). Every spend passes here: the
-- app's reserve, a desk sale's offer and its acceptance.
CREATE OR REPLACE FUNCTION spend_checks(enrolled enrollment, item reward, ev event, at_desk uuid) RETURNS timestamptz
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  rehearsing  boolean := coalesce(play_phase(ev, enrolled) = 'rehearsal', false);
  shop        text;
  desk        text;
  held        integer;
  pickup_from timestamptz := now();
BEGIN
  IF enrolled.status <> 'active' THEN
    RAISE EXCEPTION 'enrollment not active' USING ERRCODE = 'RA403', DETAIL = enrolled.status;
  END IF;
  IF enrolled.redeem_paused_at IS NOT NULL THEN
    RAISE EXCEPTION 'redeeming is paused for this player' USING ERRCODE = 'RP403';
  END IF;
  IF item.status <> 'active' OR item.held_at IS NOT NULL
     OR NOT in_audience(enrolled.id, item.audience_kind, item.audience_field_id, item.audience_values) THEN
    RAISE EXCEPTION 'reward not found' USING ERRCODE = 'RN404';
  END IF;
  IF reward_community_lock(item) IS NOT NULL THEN
    RAISE EXCEPTION 'reward not open' USING ERRCODE = 'RW403', DETAIL = 'community_locked';
  END IF;
  IF NOT feature_enabled(ev, 'shop') THEN
    RAISE EXCEPTION 'the shop is switched off' USING ERRCODE = 'RS403', DETAIL = 'feature_off';
  END IF;
  IF at_desk IS NULL AND item.kind IN ('item', 'experience') AND NOT ev.reservation_on THEN
    RAISE EXCEPTION 'this prize is redeemed at the desk' USING ERRCODE = 'RS403', DETAIL = 'reservation_off';
  END IF;
  IF at_desk IS NOT NULL AND ev.reservation_on THEN
    RAISE EXCEPTION 'this event reserves prizes' USING ERRCODE = 'DS409', DETAIL = 'reservation_on';
  END IF;
  shop := CASE WHEN rehearsing THEN 'open' ELSE shop_state(ev.status, ev.starts_at, ev.ends_at, ev.shop_days_after) END;
  IF shop <> 'open' THEN
    RAISE EXCEPTION 'shop not open' USING ERRCODE = 'RS403', DETAIL = shop;
  END IF;
  IF item.kind IN ('item', 'experience') AND NOT rehearsing THEN
    desk := desk_state(ev.desk_hours);
    IF at_desk IS NOT NULL AND desk <> 'open' THEN
      RAISE EXCEPTION 'the desk is closed' USING ERRCODE = 'RS403', DETAIL = 'desk_closed';
    END IF;
    IF desk = 'finished' THEN
      RAISE EXCEPTION 'shop not open' USING ERRCODE = 'RS403', DETAIL = 'desk_finished';
    END IF;
    IF desk = 'closed' THEN
      SELECT min(lower(w)) INTO pickup_from FROM unnest(ev.desk_hours) w WHERE lower(w) > now();
    END IF;
  END IF;
  IF item.opens_at IS NOT NULL AND item.opens_at > now() THEN
    RAISE EXCEPTION 'reward not open' USING ERRCODE = 'RW403', DETAIL = 'not_started';
  END IF;
  IF item.closes_at IS NOT NULL AND item.closes_at <= now() THEN
    RAISE EXCEPTION 'reward not open' USING ERRCODE = 'RW403', DETAIL = 'ended';
  END IF;
  IF item.units_out >= item.stock_total THEN
    RAISE EXCEPTION 'sold out' USING ERRCODE = 'RO409';
  END IF;
  IF item.per_player_limit IS NOT NULL THEN
    SELECT count(*) INTO held FROM redemption d
    WHERE d.enrollment_id = enrolled.id AND d.reward_id = item.id AND d.status NOT IN ('cancelled', 'expired');
    IF held >= item.per_player_limit THEN
      RAISE EXCEPTION 'limit reached' USING ERRCODE = 'RL409', DETAIL = item.per_player_limit::text;
    END IF;
  END IF;
  IF enrolled.balance < item.price THEN
    RAISE EXCEPTION 'balance too low' USING ERRCODE = 'RB422';
  END IF;
  RETURN pickup_from;
END $$;

-- As 0054, without a held reward.
CREATE OR REPLACE FUNCTION shop_rewards(target uuid)
  RETURNS TABLE (id uuid, kind text, name_ar text, name_en text, description_ar text, description_en text,
                 price integer, stock_left integer, per_player_limit integer, opens_at timestamptz,
                 closes_at timestamptz, section text, tag_new boolean, tag_limited boolean, popular boolean,
                 held_by_me integer, community_lock jsonb)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  popular_floor CONSTANT integer := 3;
  popular_count CONSTANT integer := 3;
  mine          uuid;
BEGIN
  SELECT n.id INTO mine FROM enrollment n JOIN player p ON p.id = n.player_id
  WHERE n.event_id = target AND n.player_id = app_player_id() AND n.status = 'active' AND p.status = 'active';
  IF mine IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
  WITH taken AS (
    SELECT d.reward_id FROM redemption d
    WHERE d.event_id = target AND d.reward_id IS NOT NULL AND d.status NOT IN ('cancelled', 'expired')
    GROUP BY d.reward_id HAVING count(*) >= popular_floor
    ORDER BY count(*) DESC, d.reward_id LIMIT popular_count
  )
  SELECT r.id, r.kind, r.name_ar, r.name_en, r.description_ar, r.description_en, r.price,
         r.stock_total - r.units_out, r.per_player_limit, r.opens_at, r.closes_at, r.section, r.tag_new,
         r.tag_limited, EXISTS (SELECT 1 FROM taken t WHERE t.reward_id = r.id),
         (SELECT count(*)::integer FROM redemption d
          WHERE d.enrollment_id = mine AND d.reward_id = r.id AND d.status NOT IN ('cancelled', 'expired')),
         community_lock_note(reward_community_lock(r))
  FROM reward r
  WHERE r.event_id = target AND r.status = 'active' AND r.held_at IS NULL
    AND in_audience(mine, r.audience_kind, r.audience_field_id, r.audience_values)
  ORDER BY r.position, r.id;
END $$;

-- As 0037; a held reward cannot be pinned.
CREATE OR REPLACE FUNCTION set_goal(target_event uuid, target_reward uuid) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  mine uuid;
BEGIN
  IF target_reward IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM reward r JOIN enrollment n ON n.event_id = r.event_id AND n.player_id = app_player_id()
       WHERE r.id = target_reward AND r.event_id = target_event AND r.status = 'active' AND r.held_at IS NULL
         AND in_audience(n.id, r.audience_kind, r.audience_field_id, r.audience_values)) THEN
    RAISE EXCEPTION 'no such reward in this event' USING ERRCODE = 'RN404';
  END IF;
  UPDATE enrollment n SET goal_reward_id = target_reward
  FROM player p
  WHERE p.id = n.player_id AND n.event_id = target_event AND n.player_id = app_player_id() AND n.status = 'active'
    AND p.status = 'active'
  RETURNING n.id INTO mine;
  IF mine IS NULL THEN
    RAISE EXCEPTION 'not a member of this event' USING ERRCODE = 'RN404';
  END IF;
  RETURN target_reward;
END $$;

-- As 0107, without a held reward.
CREATE OR REPLACE FUNCTION desk_sale_rewards(target_event uuid, scanned uuid, scanned_version integer)
  RETURNS TABLE (reward_id uuid, kind text, name_ar text, name_en text, price integer, stock_left integer, can text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me         uuid := app_player_id();
  found_n    enrollment%ROWTYPE;
  ev         event%ROWTYPE;
  rehearsing boolean;
  open_now   boolean;
BEGIN
  PERFORM ensure_rehearsal_wiped(target_event);
  found_n := desk_scanned(target_event, me, scanned, scanned_version, false);
  SELECT * INTO ev FROM event e WHERE e.id = target_event;
  IF ev.reservation_on OR NOT feature_enabled(ev, 'shop') OR found_n.status <> 'active'
     OR desk_hold(found_n, ev) IS NOT NULL THEN
    RETURN;
  END IF;
  rehearsing := coalesce(play_phase(ev, found_n) = 'rehearsal', false);
  open_now := rehearsing OR (shop_state(ev.status, ev.starts_at, ev.ends_at, ev.shop_days_after) = 'open'
                             AND desk_state(ev.desk_hours) = 'open');
  RETURN QUERY
  SELECT r.id, r.kind, r.name_ar, r.name_en, r.price, r.stock_total - r.units_out,
         CASE WHEN NOT open_now OR coalesce(r.opens_at > now(), false) OR coalesce(r.closes_at <= now(), false)
                THEN 'not_open'
              WHEN r.units_out >= r.stock_total THEN 'sold_out'
              WHEN r.per_player_limit IS NOT NULL AND r.per_player_limit <= (
                SELECT count(*) FROM redemption d
                WHERE d.enrollment_id = found_n.id AND d.reward_id = r.id AND d.status NOT IN ('cancelled', 'expired'))
                THEN 'limit'
              WHEN found_n.balance < r.price THEN 'too_few_points'
              ELSE 'ok' END
  FROM reward r
  WHERE r.event_id = target_event AND r.status = 'active' AND r.held_at IS NULL AND r.kind IN ('item', 'experience')
    AND in_audience(found_n.id, r.audience_kind, r.audience_field_id, r.audience_values)
    AND reward_community_lock(r) IS NULL
  ORDER BY r.position, r.id;
END $$;

-- As 0078, plus: a notice naming a held reward reaches nobody (the claim checks it again, so a queued push is skipped).
CREATE OR REPLACE FUNCTION notice_reward_seen(nt notice, member enrollment) RETURNS boolean
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  target uuid;
  r      reward;
BEGIN
  IF NOT nt.refs ? 'reward' OR nt.audience <> 'event' THEN
    RETURN true;
  END IF;
  target := push_ref(nt.refs, 'reward');
  SELECT x.* INTO r FROM reward x WHERE x.id = target AND x.event_id = nt.event_id;
  RETURN FOUND AND r.held_at IS NULL AND in_audience(member.id, r.audience_kind, r.audience_field_id, r.audience_values);
END $$;

-- Whether a notice is an announcement Questify unpublished: its center rows are withdrawn from reads and its pushes not
-- yet sent are skipped.
CREATE FUNCTION notice_withdrawn(nt notice) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT nt.kind = 'announcement' AND coalesce(content_held('announcement', push_ref(nt.refs, 'announcement')), false)
$$;
REVOKE ALL ON FUNCTION notice_withdrawn(notice) FROM PUBLIC;

-- As 0080, plus: a withdrawn announcement is visible to nobody.
CREATE OR REPLACE FUNCTION notice_visible(nt notice, member enrollment) RETURNS boolean
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  target uuid;
  cat    category;
BEGIN
  IF notice_withdrawn(nt) THEN
    RETURN false;
  END IF;
  IF nt.refs ? 'category' THEN
    target := push_ref(nt.refs, 'category');
    SELECT c.* INTO cat FROM category c WHERE c.id = target AND c.event_id = nt.event_id;
    IF NOT FOUND THEN
      RETURN false;
    ELSIF nt.kind <> 'category_hint' AND NOT sees_category(member.id, cat) THEN
      RETURN false;
    END IF;
  END IF;
  IF nt.refs ? 'quest' AND nt.audience = 'event' THEN
    RETURN member_sees_quest(member.id, push_ref(nt.refs, 'quest')) AND notice_reward_seen(nt, member);
  ELSIF nt.refs ? 'quest' THEN
    target := push_ref(nt.refs, 'quest');
    SELECT c.* INTO cat FROM quest q JOIN category c ON c.id = q.category_id
    WHERE q.id = target AND q.event_id = nt.event_id;
    IF NOT FOUND OR NOT sees_category(member.id, cat) THEN
      RETURN false;
    END IF;
  END IF;
  RETURN notice_reward_seen(nt, member);
END $$;

-- As 0076, without the rows of a withdrawn announcement.
CREATE OR REPLACE FUNCTION own_notifications(before bigint, size integer) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  who uuid := push_player();
BEGIN
  RETURN coalesce((
    SELECT jsonb_agg(x.item ORDER BY x.id DESC)
    FROM (SELECT c.id, jsonb_build_object(
                   'id', c.id, 'kind', nt.kind, 'class', k.class, 'topic', k.topic, 'eventId', c.event_id,
                   'refs', nt.refs, 'params', nt.params, 'createdAt', c.created_at, 'read', c.read_at IS NOT NULL,
                   'terms', e.config -> 'terms', 'timezone', e.timezone) AS item
          FROM notification c
          JOIN notice nt ON nt.id = c.notice_id
          JOIN notice_kind k ON k.kind = nt.kind
          LEFT JOIN event e ON e.id = c.event_id
          WHERE c.player_id = who AND (before IS NULL OR c.id < before) AND NOT notice_withdrawn(nt)
          ORDER BY c.id DESC
          LIMIT least(greatest(coalesce(size, 20), 1), 50)) x), '[]'::jsonb);
END $$;

-- As 0076, without the rows of a withdrawn announcement.
CREATE OR REPLACE FUNCTION own_unread_notifications() RETURNS integer
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT count(*)::integer FROM (
    SELECT 1 FROM notification c JOIN player p ON p.id = c.player_id AND p.status = 'active'
    JOIN notice nt ON nt.id = c.notice_id
    WHERE c.player_id = app_player_id() AND c.read_at IS NULL AND app_device_id() IS NULL AND NOT notice_withdrawn(nt)
    LIMIT 100) x
$$;

-- As 0081, without a held announcement.
CREATE OR REPLACE FUNCTION member_announcements(target_event uuid, size integer) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  member enrollment;
BEGIN
  SELECT n.* INTO member
  FROM enrollment n
  JOIN player p ON p.id = n.player_id AND p.status = 'active'
  JOIN event e ON e.id = n.event_id AND e.status <> 'archived'
  WHERE n.event_id = target_event AND n.player_id = app_player_id() AND n.status = 'active'
    AND app_device_id() IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not an active member of this event' USING ERRCODE = 'AM403';
  END IF;
  RETURN coalesce((
    SELECT jsonb_agg(x.item ORDER BY x.sent_at DESC, x.id DESC)
    FROM (SELECT a.id, a.sent_at, jsonb_build_object(
                   'id', a.id, 'title', jsonb_build_object('ar', a.title_ar, 'en', a.title_en),
                   'body', jsonb_build_object('ar', a.body_ar, 'en', a.body_en), 'sentAt', a.sent_at) AS item
          FROM announcement a
          WHERE a.event_id = target_event AND a.status = 'sent'
            AND a.rehearsal = (member.joined_via IS NOT DISTINCT FROM 'rehearsal')
            AND NOT content_held('announcement', a.id)
          ORDER BY a.sent_at DESC, a.id DESC
          LIMIT least(greatest(coalesce(size, 20), 1), 50)) x), '[]'::jsonb);
END $$;

-- A scheduled announcement Questify holds is skipped when its time comes (`held`); one republished before then goes.
ALTER TABLE announcement DROP CONSTRAINT announcement_skip_reason_check;
ALTER TABLE announcement ADD CONSTRAINT announcement_skip_reason_check
  CHECK (skip_reason IN ('event_closed', 'not_live', 'late', 'held'));

-- As 0081, plus the `held` skip.
CREATE OR REPLACE FUNCTION push_due_announcement(lim integer) RETURNS integer
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  due    announcement;
  ev     event;
  phase  text;
  why    text;
  made   bigint;
  moved  integer := 0;
BEGIN
  FOR due IN
    SELECT a.* FROM announcement a WHERE a.status = 'scheduled' AND a.send_at <= now()
    ORDER BY a.send_at, a.id LIMIT push_due_announcement.lim
  LOOP
    SELECT e.* INTO ev FROM event e WHERE e.id = due.event_id FOR SHARE;
    SELECT a.* INTO due FROM announcement a WHERE a.id = due.id AND a.status = 'scheduled'
      FOR UPDATE SKIP LOCKED;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;
    phase := announcement_phase(ev);
    why := CASE WHEN content_held('announcement', due.id) THEN 'held'
                WHEN phase = 'closed' THEN 'event_closed'
                WHEN phase <> 'live' THEN 'not_live'
                WHEN due.send_at < now() - interval '30 minutes' THEN 'late' END;
    IF why IS NOT NULL THEN
      UPDATE announcement SET status = 'skipped', skip_reason = why WHERE id = due.id;
      INSERT INTO audit_log (actor_type, organizer_id, event_id, action, target_type, target_id, after)
      VALUES ('system', due.organizer_id, due.event_id, 'announcement.skip', 'announcement', due.id::text,
              jsonb_build_object('reason', why));
      moved := moved + 1;
    ELSE
      made := notice_create('announcement', due.organizer_id, due.event_id, NULL, jsonb_build_object('announcement', due.id),
                            announcement_params(ev, due.title_ar, due.title_en, due.push_body_ar, due.push_body_en),
                            'announcement:' || due.id, NULL);
      IF made IS NOT NULL THEN
        UPDATE announcement SET status = 'sent', sent_at = now(), notice_id = made WHERE id = due.id;
        INSERT INTO audit_log (actor_type, organizer_id, event_id, action, target_type, target_id)
        VALUES ('system', due.organizer_id, due.event_id, 'announcement.release', 'announcement', due.id::text);
        moved := moved + 1;
      END IF;
    END IF;
  END LOOP;
  RETURN moved;
END $$;

-- ================================================================ the console's queue (FR-1404, ADR-435)
-- Every door is for an active admin (QE403 otherwise) and audits its read with ids and counts only.

-- The open targets, one row per target with its report count, oldest first (at most 100), optionally of one kind; each
-- with its event and organizer, the latest snapshot as its label, and `overdue` past the 24 hours the guidelines state.
CREATE FUNCTION console_reports(only_kind text, request uuid) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me     uuid := console_admin();
  result jsonb;
BEGIN
  SELECT jsonb_build_object(
           'targets', coalesce(jsonb_agg(jsonb_build_object(
             'kind', g.target_kind, 'targetId', g.target_id, 'reports', g.n, 'firstAt', g.first_at,
             'lastAt', g.last_at, 'overdue', g.first_at < now() - interval '24 hours',
             'snapshot', (SELECT r.snapshot FROM content_report r
                          WHERE r.target_kind = g.target_kind AND r.target_id = g.target_id AND r.status = 'open'
                          ORDER BY r.created_at DESC, r.id DESC LIMIT 1),
             'event', CASE WHEN e.id IS NOT NULL THEN jsonb_build_object(
                        'id', e.id, 'name', report_pair(e.name_ar, e.name_en, 120), 'organizer', o.name) END)
             ORDER BY g.first_at, g.target_id), '[]'::jsonb),
           'total', (SELECT count(*) FROM (SELECT 1 FROM content_report r
                                           WHERE r.status = 'open' AND (only_kind IS NULL OR r.target_kind = only_kind)
                                           GROUP BY r.target_kind, r.target_id) x))
  INTO result
  FROM (SELECT r.target_kind, r.target_id, count(*) AS n, min(r.created_at) AS first_at, max(r.created_at) AS last_at,
               (array_agg(r.event_id ORDER BY r.created_at DESC))[1] AS event_id
        FROM content_report r
        WHERE r.status = 'open' AND (only_kind IS NULL OR r.target_kind = only_kind)
        GROUP BY r.target_kind, r.target_id
        ORDER BY min(r.created_at), r.target_id
        LIMIT 100) g
  LEFT JOIN event e ON e.id = g.event_id
  LEFT JOIN organizer o ON o.id = e.organizer_id;
  INSERT INTO audit_log (actor_type, actor_id, action, target_type, after, request_id)
  VALUES ('admin', me, 'console.reports_read', 'content_report',
          jsonb_build_object('kind', only_kind, 'shown', jsonb_array_length(result -> 'targets')), request);
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION console_reports(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_reports(text, uuid) TO questify_app;

-- One target's reports, open and handled (newest first, at most 200): what each reporter saw, the reason, the note,
-- the time and the reporter's current username (NULL once erased); the target's content now (NULL when gone), its
-- event and organizer (with whether the event is suspended), its live hold, and for a username the player's id and
-- standing so the console can open the record. Audited `console.report_read`. QA404 when nothing was ever reported.
CREATE FUNCTION console_report(target_kind text, target uuid, request uuid) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me     uuid := console_admin();
  ev_id  uuid;
  result jsonb;
BEGIN
  SELECT r.event_id INTO ev_id FROM content_report r
  WHERE r.target_kind = console_report.target_kind AND r.target_id = target
  ORDER BY r.created_at DESC LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no reports for this target' USING ERRCODE = 'QA404';
  END IF;
  SELECT jsonb_build_object(
    'kind', target_kind, 'targetId', target,
    'current', report_snapshot(target_kind, target),
    'player', CASE WHEN target_kind = 'username' THEN
                (SELECT jsonb_build_object('id', p.id, 'status', p.status) FROM player p WHERE p.id = target) END,
    'event', (SELECT jsonb_build_object('id', e.id, 'name', report_pair(e.name_ar, e.name_en, 120),
                                        'organizer', o.name, 'suspended', event_suspended(e.id))
              FROM event e JOIN organizer o ON o.id = e.organizer_id WHERE e.id = coalesce(ev_id,
                report_event(target_kind, target))),
    'hold', (SELECT jsonb_build_object('id', h.id, 'reasonCode', h.reason_code, 'note', h.note, 'heldAt', h.held_at)
             FROM content_hold h WHERE h.kind = target_kind AND h.target_id = target AND h.released_at IS NULL),
    'reports', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', x.id, 'reason', x.reason, 'note', x.note, 'marked', x.marked, 'status', x.status,
               'outcome', x.outcome, 'createdAt', x.created_at, 'handledAt', x.handled_at, 'snapshot', x.snapshot,
               'reporter', (SELECT p.username FROM player p WHERE p.id = x.reporter_id))
             ORDER BY x.created_at DESC, x.id DESC)
      FROM (SELECT r.* FROM content_report r
            WHERE r.target_kind = console_report.target_kind AND r.target_id = target
            ORDER BY r.created_at DESC, r.id DESC LIMIT 200) x), '[]'::jsonb))
  INTO result;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, request_id)
  VALUES ('admin', me, (SELECT e.organizer_id FROM event e WHERE e.id = ev_id), ev_id, 'console.report_read',
          target_kind, target::text, request);
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION console_report(text, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_report(text, uuid, uuid) TO questify_app;

-- Closes every open report of a target in one statement with the action taken (or `dismissed`), audited
-- `report.resolve` with ids, the outcome and how many closed. Answers that count (0: nothing was open). RP422 for an
-- outcome not in the list.
CREATE FUNCTION admin_report_resolve(target_kind text, target uuid, resolution text, request uuid) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me     uuid := console_admin();
  closed integer;
  ev_id  uuid;
BEGIN
  IF resolution IS NULL OR resolution NOT IN ('dismissed', 'unpublished', 'event_suspended', 'username_changed',
                                              'player_banned') THEN
    RAISE EXCEPTION 'an outcome from the list' USING ERRCODE = 'RP422';
  END IF;
  WITH done AS (
    UPDATE content_report r
    SET status = CASE WHEN resolution = 'dismissed' THEN 'dismissed' ELSE 'actioned' END, outcome = resolution,
        handled_by = me, handled_at = now()
    WHERE r.target_kind = admin_report_resolve.target_kind AND r.target_id = target AND r.status = 'open'
    RETURNING r.event_id)
  SELECT count(*), max(d.event_id::text)::uuid INTO closed, ev_id FROM done d;
  IF closed > 0 THEN
    INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after,
                           request_id)
    VALUES ('admin', me, (SELECT e.organizer_id FROM event e WHERE e.id = ev_id), ev_id, 'report.resolve', target_kind,
            target::text, jsonb_build_object('outcome', resolution, 'closed', closed), request);
  END IF;
  RETURN closed;
END $$;
REVOKE ALL ON FUNCTION admin_report_resolve(text, uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_report_resolve(text, uuid, text, uuid) TO questify_app;

-- ================================================================ platform flags (FR-1404, ADR-435)
-- Open anti-cheat flags across events, one row per event (count, oldest, kinds), oldest first, at most 100; read-only
-- (the team resolves). Audited `console.flags_read` with how many events were shown.
CREATE FUNCTION console_flags(request uuid) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me     uuid := console_admin();
  result jsonb;
BEGIN
  SELECT jsonb_build_object(
           'events', coalesce(jsonb_agg(jsonb_build_object(
             'eventId', g.event_id, 'name', report_pair(e.name_ar, e.name_en, 120), 'organizer', o.name,
             'open', g.n, 'oldestAt', g.oldest, 'kinds', g.kinds, 'suspended', event_suspended(e.id))
             ORDER BY g.oldest, g.event_id), '[]'::jsonb),
           'total', (SELECT count(*) FROM flag f WHERE f.status = 'open'))
  INTO result
  FROM (SELECT f.event_id, count(*) AS n, min(f.raised_at) AS oldest,
               to_jsonb(array_agg(DISTINCT f.kind ORDER BY f.kind)) AS kinds
        FROM flag f WHERE f.status = 'open'
        GROUP BY f.event_id ORDER BY min(f.raised_at), f.event_id LIMIT 100) g
  JOIN event e ON e.id = g.event_id
  JOIN organizer o ON o.id = e.organizer_id;
  INSERT INTO audit_log (actor_type, actor_id, action, target_type, after, request_id)
  VALUES ('admin', me, 'console.flags_read', 'flag',
          jsonb_build_object('shown', jsonb_array_length(result -> 'events')), request);
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION console_flags(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_flags(uuid) TO questify_app;

-- ================================================================ retention and erasure
-- Handled reports go 180 days after handling (plan section 6); open ones wait in the queue. Reads across organizers on
-- purpose (a retention sweep, rules.md). Answers how many went.
CREATE FUNCTION purge_handled_reports(batch integer) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  gone integer;
BEGIN
  WITH due AS (
    SELECT r.id FROM content_report r
    WHERE r.status <> 'open' AND r.handled_at + interval '180 days' <= now()
    ORDER BY r.handled_at, r.id
    LIMIT least(greatest(coalesce(batch, 1000), 1), 1000)
    FOR UPDATE SKIP LOCKED)
  DELETE FROM content_report r USING due WHERE r.id = due.id;
  GET DIAGNOSTICS gone = ROW_COUNT;
  RETURN gone;
END $$;
REVOKE ALL ON FUNCTION purge_handled_reports(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION purge_handled_reports(integer) TO questify_app;

-- As 0120, plus the reports about the account's username (deleted) and its own reports (kept, no longer naming it).
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
  -- The ban's action row is deleted below; the player row stops pointing at it first (plan review).
  UPDATE player SET ban_action_id = NULL WHERE id = me AND ban_action_id IS NOT NULL;
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
  DELETE FROM player_block WHERE blocker_id = me OR blocked_id = me;
  DELETE FROM content_report WHERE target_kind = 'username' AND target_id = me;
  UPDATE content_report SET reporter_id = NULL, note = NULL, marked = false WHERE reporter_id = me;
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

-- Restated from 0098 and 0092: a duplicated event never copies a held quest or reward (T-705b review MAJOR).
CREATE OR REPLACE FUNCTION public.event_copy_quests(src event, tgt event, shift interval)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  n integer;
BEGIN
  INSERT INTO quest (id, organizer_id, event_id, category_id, type, title_ar, title_en, description_ar, description_en,
                     points, repeat_cap, opens_at, closes_at, visible, position, type_config, verification, item_id,
                     place_lat, place_lng, place_radius_m, flash)
  SELECT copy_id(q.id, tgt.id), tgt.organizer_id, tgt.id, copy_id(q.category_id, tgt.id), q.type, q.title_ar, q.title_en,
         q.description_ar, q.description_en, q.points, q.repeat_cap, q.opens_at + shift, q.closes_at + shift, q.visible,
         q.position,
         CASE WHEN q.type = 'enter_code' THEN jsonb_set(q.type_config, '{code}', to_jsonb(fresh_entry_code()))
              ELSE q.type_config END,
         q.verification, copy_id(q.item_id, tgt.id), q.place_lat, q.place_lng, q.place_radius_m, q.flash
  FROM quest q WHERE q.event_id = src.id AND q.deleted_at IS NULL AND NOT content_held('quest', q.id);
  GET DIAGNOSTICS n = ROW_COUNT;
  INSERT INTO quest_first_bonus (quest_id, organizer_id, event_id, points, slots)
  SELECT copy_id(b.quest_id, tgt.id), tgt.organizer_id, tgt.id, b.points, b.slots
  FROM quest_first_bonus b WHERE b.event_id = src.id AND NOT EXISTS (SELECT 1 FROM quest d WHERE d.id = b.quest_id AND (d.deleted_at IS NOT NULL OR content_held('quest', d.id)));
  INSERT INTO passport_step (id, organizer_id, event_id, quest_id, name_ar, name_en, position)
  SELECT copy_id(p.id, tgt.id), tgt.organizer_id, tgt.id, copy_id(p.quest_id, tgt.id), p.name_ar, p.name_en, p.position
  FROM passport_step p WHERE p.event_id = src.id AND NOT EXISTS (SELECT 1 FROM quest d WHERE d.id = p.quest_id AND (d.deleted_at IS NOT NULL OR content_held('quest', d.id)));
  UPDATE event e SET focus_quest_id = copy_id(src.focus_quest_id, tgt.id)
  WHERE e.id = tgt.id AND src.focus_quest_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM quest d WHERE d.id = src.focus_quest_id AND (d.deleted_at IS NOT NULL OR content_held('quest', d.id)));
  RETURN n;
END $$;

CREATE OR REPLACE FUNCTION event_copy_prizes(src event, tgt event, shift interval) RETURNS jsonb
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  rewards integer;
  prizes  integer;
BEGIN
  INSERT INTO reward (id, organizer_id, event_id, kind, name_ar, name_en, description_ar, description_en, price,
                      stock_total, per_player_limit, opens_at, closes_at, section, tag_new, tag_limited, position,
                      audience_kind, audience_field_id, audience_values)
  SELECT copy_id(r.id, tgt.id), tgt.organizer_id, tgt.id, r.kind, r.name_ar, r.name_en, r.description_ar,
         r.description_en, r.price, CASE WHEN r.kind = 'digital' THEN 0 ELSE r.stock_total END, r.per_player_limit,
         r.opens_at + shift, r.closes_at + shift, r.section, r.tag_new, r.tag_limited, r.position, r.audience_kind,
         copy_id(r.audience_field_id, tgt.id), r.audience_values
  FROM reward r WHERE r.event_id = src.id AND r.status = 'active' AND NOT content_held('reward', r.id);
  GET DIAGNOSTICS rewards = ROW_COUNT;
  INSERT INTO rank_prize (id, organizer_id, event_id, rank_from, rank_to, kind, name_ar, name_en, description_ar,
                          description_en)
  SELECT copy_id(p.id, tgt.id), tgt.organizer_id, tgt.id, p.rank_from, p.rank_to, p.kind, p.name_ar, p.name_en,
         p.description_ar, p.description_en
  FROM rank_prize p WHERE p.event_id = src.id AND p.status = 'active';
  GET DIAGNOSTICS prizes = ROW_COUNT;
  RETURN jsonb_build_object('rewards', rewards, 'rankPrizes', prizes);
END $$;

-- Restated from 0088: a held reward's sponsor tag is not shown (T-705b review NIT).
CREATE OR REPLACE FUNCTION sponsor_tag_shown(t sponsor_tag, member uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE t.kind
    WHEN 'quest' THEN member_sees_quest(member, t.quest_id)
    WHEN 'category' THEN EXISTS (SELECT 1 FROM category c
                                 WHERE c.id = t.category_id AND c.event_id = t.event_id AND sees_category(member, c))
    ELSE EXISTS (SELECT 1 FROM reward r
                 WHERE r.id = t.reward_id AND r.event_id = t.event_id AND r.status = 'active' AND r.held_at IS NULL
                   AND in_audience(member, r.audience_kind, r.audience_field_id, r.audience_values))
  END
$$;
