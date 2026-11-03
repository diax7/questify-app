-- T-706b: a push to a group of players (FR-1777; plan docs/plans/2026-11-03-t-706b-group-push.md; ADR-530 to ADR-535).
-- A platform admin sends a push to everyone in an event, or to the players who opted in to promotional push, optionally
-- by city and interests. Two free-text kinds go through the push store (`notice_kind`, the announcements' renderer and
-- name rule): `group_push_event` (event class: ONE notice, the store's event fan-out reaches the event's players) and
-- `group_push_promo` (promo class: one notice per player, written by the push worker's fan door in pages of 500 players
-- read through `marketing_audience`; the store checks the consent again at the fan-out and at the claim). `group_push`
-- is the record of each send. A player gets at most one promotional push a week across these sends and the Questify
-- invitations (`promo_push_free`, Q-421; `invitation_candidates` asks the mirror of it).
-- Deny by default: the new table keeps row-level security forced and no grant; every function is closed to PUBLIC in the
-- statement group that creates it; the three admin doors (console_admin() first, QE403) and the system fan door are
-- granted to the API role. `notice_status_ok` and `invitation_candidates` are restated (0078's and 0079's bodies plus one
-- rule each). Deployed migrations untouched.
SET LOCAL lock_timeout = '10s';
-- Every existing table this migration references or indexes, up front: event, staff_user and city are foreign-key
-- targets; notice gains an index. Never player, enrollment, ledger_entry, xp_entry or platform_setting.
LOCK TABLE event IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE staff_user IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE city IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE notice IN SHARE MODE;

-- ================================================================ the kinds (ADR-531)
-- The event kind is mutable by the announcements topic (a muted topic keeps the center row and loses the push) and lives
-- a day; the promotional kind has no topic (its way out is the marketing consent, ADR-065) and lives three days.
INSERT INTO notice_kind (kind, class, topic, membership, before_start, priority, ttl) VALUES
  ('group_push_event', 'event', 'announcements', 'active', false, 1, interval '24 hours'),
  ('group_push_promo', 'promo', NULL, 'none', false, 2, interval '3 days');

-- ================================================================ the table (ADR-531)
-- One row per send. The audience and the text are frozen at creation (group_push_frozen); only the cursor, the counts and
-- the state move. `cursor_player` is the last player of the page the fan door read (an opaque pagination cursor).
-- `reach` is what the admin saw in the preview when it was sent; `notices` the notices written; `capped` the players
-- left out by the weekly cap.
CREATE TABLE group_push (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audience      text NOT NULL CHECK (audience IN ('event', 'promo')),
  organizer_id  uuid,
  event_id      uuid,
  city_id       text REFERENCES city (id),
  interests     text[] NOT NULL DEFAULT '{}' CHECK (cardinality(interests) <= 8),
  title_ar      text NOT NULL CHECK (char_length(title_ar) BETWEEN 1 AND 60 AND title_ar !~ '[[:cntrl:]]'),
  title_en      text NOT NULL CHECK (char_length(title_en) BETWEEN 1 AND 60 AND title_en !~ '[[:cntrl:]]'),
  body_ar       text NOT NULL CHECK (char_length(body_ar) BETWEEN 1 AND 140 AND body_ar !~ '[[:cntrl:]]'),
  body_en       text NOT NULL CHECK (char_length(body_en) BETWEEN 1 AND 140 AND body_en !~ '[[:cntrl:]]'),
  state         text NOT NULL CHECK (state IN ('sending', 'done')),
  cursor_player uuid,
  reach         integer NOT NULL DEFAULT 0 CHECK (reach >= 0),
  notices       integer NOT NULL DEFAULT 0 CHECK (notices >= 0),
  capped        integer NOT NULL DEFAULT 0 CHECK (capped >= 0),
  created_by    uuid NOT NULL REFERENCES staff_user (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE CASCADE,
  CONSTRAINT group_push_event_shape CHECK (
    (audience = 'event' AND event_id IS NOT NULL AND organizer_id IS NOT NULL AND city_id IS NULL
     AND cardinality(interests) = 0)
    OR (audience = 'promo' AND event_id IS NULL AND organizer_id IS NULL)),
  CONSTRAINT group_push_finished CHECK ((state = 'done') = (finished_at IS NOT NULL))
);
-- The console's list (newest first) and the fan door's scan of the sends still running.
CREATE INDEX group_push_recent ON group_push (created_at DESC, id DESC);
CREATE INDEX group_push_running ON group_push (created_at, id) WHERE state = 'sending';
-- The weekly cap's probe: a player's group promotional notices by time.
CREATE INDEX notice_group_promo ON notice (player_id, created_at) WHERE kind = 'group_push_promo';
ALTER TABLE group_push ENABLE ROW LEVEL SECURITY;
ALTER TABLE group_push FORCE ROW LEVEL SECURITY;
REVOKE ALL ON group_push FROM PUBLIC, questify_app;

-- The audience, the text, the author and the time never change, and a finished send never changes again, not even for the
-- table's owner: "the text is frozen at send" is a database fact.
CREATE FUNCTION group_push_frozen() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF (NEW.id, NEW.audience, NEW.organizer_id, NEW.event_id, NEW.city_id, NEW.interests, NEW.title_ar, NEW.title_en,
      NEW.body_ar, NEW.body_en, NEW.reach, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.audience, OLD.organizer_id, OLD.event_id, OLD.city_id, OLD.interests, OLD.title_ar,
                       OLD.title_en, OLD.body_ar, OLD.body_en, OLD.reach, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'a group push''s audience and text are frozen' USING ERRCODE = 'GP409', DETAIL = 'frozen';
  ELSIF OLD.state = 'done' THEN
    RAISE EXCEPTION 'a finished group push does not change' USING ERRCODE = 'GP409', DETAIL = 'finished';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION group_push_frozen() FROM PUBLIC;
CREATE TRIGGER group_push_frozen BEFORE UPDATE ON group_push
  FOR EACH ROW EXECUTE FUNCTION group_push_frozen();

-- ================================================================ who receives an event push (ADR-532)
-- As 0078, plus one rule for this kind: the real members of a scheduled, live or ended event (a draft has none and an
-- archived event gets no push; a rehearsal account is the organizer's test seat, never a player to tell).
CREATE OR REPLACE FUNCTION notice_status_ok(k notice_kind, status_now text, member enrollment) RETURNS boolean
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN k.kind = 'group_push_event'
      THEN status_now IN ('scheduled', 'live', 'ended') AND member.joined_via IS DISTINCT FROM 'rehearsal'
    WHEN status_now IN ('draft', 'scheduled')
      THEN (member.joined_via IS NOT DISTINCT FROM 'rehearsal') <> k.before_start
    WHEN status_now IN ('live', 'ended')
      THEN NOT k.before_start AND member.joined_via IS DISTINCT FROM 'rehearsal'
    ELSE false END
$$;
REVOKE ALL ON FUNCTION notice_status_ok(notice_kind, text, enrollment) FROM PUBLIC;

-- ================================================================ the weekly cap (ADR-534, Q-421)
-- Whether a player may be sent a promotional push now: no Questify invitation by push that is queued, sending, or sent
-- (or unknown) in the last 7 days, and no group promotional push in the last 7 days. Plain SQL with no SET clause and
-- schema-qualified tables, so its callers (definers) inline it. No grant.
CREATE FUNCTION promo_push_free(who uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT NOT EXISTS (SELECT 1 FROM public.notice n
                     WHERE n.player_id = who AND n.kind = 'group_push_promo' AND n.created_at > now() - interval '7 days')
     AND NOT EXISTS (SELECT 1 FROM public.invitation_recipient r
                     WHERE r.player_id = who AND r.channel = 'push'
                       AND (r.state IN ('queued', 'sending')
                            OR (r.state IN ('sent', 'unknown') AND r.sent_at > now() - interval '7 days')))
$$;
REVOKE ALL ON FUNCTION promo_push_free(uuid) FROM PUBLIC;

-- As 0079, with the mirror of the cap: a push candidate told by a group promotional push in the last 7 days is not
-- invited by push (an SMS candidate is unaffected: the cap is per channel). Plain SQL, no SET clause, tables
-- schema-qualified (inlined by its callers).
CREATE OR REPLACE FUNCTION invitation_candidates(target uuid) RETURNS TABLE (player_id uuid, draw text, channel text)
  LANGUAGE sql STABLE AS $$
  SELECT p.player_id, md5(c.id::text || p.player_id::text), p.channel
  FROM public.invitation_campaign c
  CROSS JOIN LATERAL (
    SELECT x.player_id, 'push'::text AS channel
    FROM public.promo_pool('push', c.city_id, c.interests) x
    WHERE 'push' = ANY (coalesce(c.channels, ARRAY['push', 'sms']))
      AND EXISTS (SELECT 1 FROM public.push_live_devices() d WHERE d.player_id = x.player_id)
      AND NOT EXISTS (SELECT 1 FROM public.notice g
                      WHERE g.player_id = x.player_id AND g.kind = 'group_push_promo'
                        AND g.created_at > now() - interval '7 days')
    UNION ALL
    SELECT x.player_id, 'sms'::text
    FROM public.promo_pool('sms', c.city_id, c.interests) x
    WHERE 'sms' = ANY (coalesce(c.channels, ARRAY['push', 'sms']))
      AND NOT ('push' = ANY (coalesce(c.channels, ARRAY['push', 'sms']))
               AND EXISTS (SELECT 1 FROM public.marketing_state s
                           WHERE s.player_id = x.player_id AND s.channel = 'push' AND s.opted_in)
               AND EXISTS (SELECT 1 FROM public.push_live_devices() d WHERE d.player_id = x.player_id))) p
  WHERE c.id = target
    AND (c.history = 'none'
         OR (c.history = 'recent' AND EXISTS (
               SELECT 1 FROM public.enrollment n
               WHERE n.player_id = p.player_id AND n.status NOT IN ('pending', 'declined')
                 AND n.joined_via IS DISTINCT FROM 'rehearsal' AND n.joined_at >= now() - interval '365 days'))
         OR (c.history = 'own' AND EXISTS (
               SELECT 1 FROM public.enrollment n
               WHERE n.player_id = p.player_id AND n.organizer_id = c.organizer_id AND n.event_id <> c.event_id
                 AND n.status NOT IN ('pending', 'declined') AND n.joined_via IS DISTINCT FROM 'rehearsal')))
    AND NOT EXISTS (SELECT 1 FROM public.enrollment n WHERE n.event_id = c.event_id AND n.player_id = p.player_id)
    AND NOT EXISTS (SELECT 1 FROM public.invitation_recipient r JOIN public.invitation_campaign o ON o.id = r.campaign_id
                    WHERE r.player_id = p.player_id AND o.event_id = c.event_id
                      AND r.state IN ('queued', 'sending', 'sent', 'unknown'))
    AND NOT EXISTS (SELECT 1 FROM public.invitation_recipient r
                    WHERE r.player_id = p.player_id
                      AND (r.state IN ('queued', 'sending')
                           OR (r.state IN ('sent', 'unknown') AND r.sent_at > now() - interval '7 days')))
$$;
REVOKE ALL ON FUNCTION invitation_candidates(uuid) FROM PUBLIC;

-- ================================================================ the draft (internal)
-- The admin's draft checked and turned into a row (not stored): the audience (GP400 `audience`, `cityId` or `interests`;
-- GP404 for a join code that names no event; GP409 for an event that cannot take a push: a draft, an archived or a
-- suspended one) and the text (CA400 with the field: 1 to 60 characters for a title, 1 to 140 for a body, no control or
-- direction character, no placeholder). The API has cleaned and checked the same already; this keeps a bypassed API from
-- storing anything else.
CREATE FUNCTION group_push_draft(draft jsonb) RETURNS group_push
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  made  group_push;
  ev    event;
  code  text;
  wants text[];
  clean text[];
BEGIN
  IF jsonb_typeof(draft) IS DISTINCT FROM 'object' OR jsonb_typeof(draft -> 'audience') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'name the audience' USING ERRCODE = 'GP400', DETAIL = 'audience';
  END IF;
  made.audience := draft #>> '{audience,kind}';
  IF made.audience = 'event' THEN
    code := btrim(draft #>> '{audience,joinCode}');
    IF code IS NULL OR code = '' THEN
      RAISE EXCEPTION 'name the event by its join code' USING ERRCODE = 'GP400', DETAIL = 'joinCode';
    END IF;
    SELECT e.* INTO ev FROM event e WHERE lower(e.join_code) = lower(code);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'no such event' USING ERRCODE = 'GP404';
    ELSIF event_status_now(ev.status, ev.starts_at, ev.ends_at) IN ('draft', 'archived') THEN
      RAISE EXCEPTION 'this event cannot take a push' USING ERRCODE = 'GP409', DETAIL = 'event_not_open';
    ELSIF event_suspended(ev.id) THEN
      RAISE EXCEPTION 'this event is suspended' USING ERRCODE = 'GP409', DETAIL = 'event_suspended';
    END IF;
    made.event_id := ev.id;
    made.organizer_id := ev.organizer_id;
    made.interests := '{}';
  ELSIF made.audience = 'promo' THEN
    made.city_id := nullif(btrim(coalesce(draft #>> '{audience,cityId}', '')), '');
    IF made.city_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM city c WHERE c.id = made.city_id) THEN
      RAISE EXCEPTION 'unknown city' USING ERRCODE = 'GP400', DETAIL = 'cityId';
    END IF;
    IF coalesce(jsonb_typeof(draft #> '{audience,interests}'), 'array') <> 'array' THEN
      RAISE EXCEPTION 'interests are a list' USING ERRCODE = 'GP400', DETAIL = 'interests';
    END IF;
    wants := ARRAY(SELECT jsonb_array_elements_text(coalesce(draft #> '{audience,interests}', '[]'::jsonb)));
    clean := interests_clean(wants, 8);
    IF clean IS NULL THEN
      RAISE EXCEPTION 'interests are catalog ids, no repeats, at most 8' USING ERRCODE = 'GP400', DETAIL = 'interests';
    END IF;
    made.interests := clean;
  ELSE
    RAISE EXCEPTION 'the audience is an event or opted-in players' USING ERRCODE = 'GP400', DETAIL = 'audience';
  END IF;
  made.title_ar := message_template_text(draft #>> '{title,ar}', 'title.ar', 60, '{}', '{}');
  made.title_en := message_template_text(draft #>> '{title,en}', 'title.en', 60, '{}', '{}');
  made.body_ar := message_template_text(draft #>> '{body,ar}', 'body.ar', 140, '{}', '{}');
  made.body_en := message_template_text(draft #>> '{body,en}', 'body.en', 140, '{}', '{}');
  RETURN made;
END $$;
REVOKE ALL ON FUNCTION group_push_draft(jsonb) FROM PUBLIC;

-- How many players a draft reaches: an event's active real members, or the opted-in players not yet told this week, counted
-- up to 100,001 (the console shows "more than 100,000"). The push store checks every player again when it sends.
CREATE FUNCTION group_push_reach(g group_push) RETURNS integer
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE g.audience
    WHEN 'event' THEN
      (SELECT count(*)::integer FROM enrollment n JOIN player p ON p.id = n.player_id AND p.status = 'active'
       WHERE n.event_id = g.event_id AND n.status = 'active' AND n.joined_via IS DISTINCT FROM 'rehearsal')
    ELSE
      (SELECT count(*)::integer
       FROM (SELECT 1 FROM promo_pool('push', g.city_id, g.interests) p WHERE promo_push_free(p.player_id)
             LIMIT 100001) x)
    END
$$;
REVOKE ALL ON FUNCTION group_push_reach(group_push) FROM PUBLIC;

-- The send as the console shows it: the audience, the event's names and join code, the text and the counts.
CREATE FUNCTION group_push_json(g group_push) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', g.id,
    'audience', g.audience,
    'event', (SELECT jsonb_build_object('id', e.id, 'joinCode', e.join_code,
                                        'name', jsonb_build_object('ar', e.name_ar, 'en', e.name_en))
              FROM event e WHERE e.id = g.event_id),
    'cityId', g.city_id,
    'interests', to_jsonb(g.interests),
    'title', jsonb_build_object('ar', g.title_ar, 'en', g.title_en),
    'body', jsonb_build_object('ar', g.body_ar, 'en', g.body_en),
    'state', g.state,
    'reach', g.reach,
    'notices', g.notices,
    'capped', g.capped,
    'createdAt', g.created_at,
    'finishedAt', g.finished_at)
$$;
REVOKE ALL ON FUNCTION group_push_json(group_push) FROM PUBLIC;

-- The notice's params: the frozen title and text, each {ar, en}, and for an event push the event's names.
CREATE FUNCTION group_push_params(g group_push) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('title', jsonb_build_object('ar', g.title_ar, 'en', g.title_en),
                            'body', jsonb_build_object('ar', g.body_ar, 'en', g.body_en))
         || coalesce((SELECT jsonb_build_object('event', push_names(e.name_ar, e.name_en))
                      FROM event e WHERE e.id = g.event_id), '{}'::jsonb)
$$;
REVOKE ALL ON FUNCTION group_push_params(group_push) FROM PUBLIC;

-- ================================================================ the admin doors (ADR-531)
-- The preview: what the send would reach and, for an event, which event it is. Read only.
CREATE FUNCTION admin_group_push_preview(draft jsonb) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  g     group_push;
  n     integer;
BEGIN
  PERFORM console_admin();
  g := group_push_draft(draft);
  n := group_push_reach(g);
  RETURN jsonb_build_object(
    'audience', g.audience,
    'event', (SELECT jsonb_build_object('id', e.id, 'joinCode', e.join_code,
                                        'name', jsonb_build_object('ar', e.name_ar, 'en', e.name_en),
                                        'status', event_status_now(e.status, e.starts_at, e.ends_at))
              FROM event e WHERE e.id = g.event_id),
    'cityId', g.city_id,
    'interests', to_jsonb(g.interests),
    'reach', n,
    'capped', g.audience = 'promo' AND n > 100000);
END $$;
REVOKE ALL ON FUNCTION admin_group_push_preview(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_group_push_preview(jsonb) TO questify_app;

-- Sends: checks the draft again, refuses an audience of nobody (GP204) and the 21st send in an hour (GP429; one lock
-- serializes the count), writes the row and audits it. An event push also writes its one notice now (the store's event
-- fan-out reaches the players); a promotional push waits for the fan door, one page of 500 players at a time.
CREATE FUNCTION admin_group_push_send(draft jsonb, request uuid) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  admin uuid := console_admin();
  g     group_push;
  n     integer;
  made  bigint;
BEGIN
  g := group_push_draft(draft);
  PERFORM pg_advisory_xact_lock(hashtextextended('group_push_send', 0));
  IF (SELECT count(*) FROM group_push x WHERE x.created_at > now() - interval '1 hour') >= 20 THEN
    RAISE EXCEPTION 'too many group pushes this hour' USING ERRCODE = 'GP429';
  END IF;
  n := group_push_reach(g);
  IF n = 0 THEN
    RAISE EXCEPTION 'nobody to send this to' USING ERRCODE = 'GP204';
  END IF;
  INSERT INTO group_push (audience, organizer_id, event_id, city_id, interests, title_ar, title_en, body_ar, body_en,
                          state, reach, created_by)
  VALUES (g.audience, g.organizer_id, g.event_id, g.city_id, g.interests, g.title_ar, g.title_en, g.body_ar, g.body_en,
          'sending', n, admin)
  RETURNING * INTO g;
  IF g.audience = 'event' THEN
    made := notice_create('group_push_event', g.organizer_id, g.event_id, NULL, '{}', group_push_params(g),
                          'gpush:' || g.id, NULL);
    IF made IS NULL THEN
      RAISE EXCEPTION 'the push could not be written; check the group_push_event kind' USING ERRCODE = 'GP500';
    END IF;
    UPDATE group_push x SET state = 'done', finished_at = now(), notices = 1 WHERE x.id = g.id RETURNING * INTO g;
  END IF;
  PERFORM catalog_audit('group_push.send', 'group_push', g.id::text, NULL,
                        jsonb_build_object('audience', g.audience, 'eventId', g.event_id, 'cityId', g.city_id,
                                           'interests', to_jsonb(g.interests), 'reach', n),
                        request);
  RETURN group_push_json(g);
END $$;
REVOKE ALL ON FUNCTION admin_group_push_send(jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_group_push_send(jsonb, uuid) TO questify_app;

-- The last 50 sends, newest first.
CREATE FUNCTION admin_group_push_list() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM console_admin();
  RETURN coalesce((SELECT jsonb_agg(group_push_json(t.pushed) ORDER BY t.created_at DESC, t.id DESC)
                   FROM (SELECT g AS pushed, g.created_at, g.id FROM group_push g
                         ORDER BY g.created_at DESC, g.id DESC LIMIT 50) t),
                  '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION admin_group_push_list() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_group_push_list() TO questify_app;

-- ================================================================ the fan door (system context only; ADR-531)
-- One page of the oldest promotional send still running: up to 500 players after its cursor, read through
-- `marketing_audience` (push channel, the send's city and interests), each told by one `group_push_promo` notice unless the
-- weekly cap says no (counted in `capped`). The marker `gpush:{send}:{player}` makes a repeat write nothing. The send is
-- done once a page comes back short. Locks: first `pg_try_advisory_xact_lock(hashtext('invitation_fill'))`, the key the
-- invitation fill (`invitation_start_due`) takes, so the weekly cap is read and written by one fill at a time: a second
-- fan or an invitation fill that holds it makes this call answer `{0, false}` and the next tick tries again; then the
-- send row `FOR UPDATE SKIP LOCKED`, then the notices (insert). The push store checks the consent again at the fan-out
-- and at the claim. `{rows, more}`.
CREATE FUNCTION group_push_fan() RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  g      group_push;
  ids    uuid[];
  who    uuid;
  fresh  integer := 0;
  held   integer := 0;
  width  constant integer := 500;
BEGIN
  PERFORM push_system_only();
  IF NOT pg_try_advisory_xact_lock(hashtext('invitation_fill')) THEN
    RETURN jsonb_build_object('rows', 0, 'more', false);
  END IF;
  SELECT x.* INTO g FROM group_push x WHERE x.state = 'sending' ORDER BY x.created_at, x.id LIMIT 1
    FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('rows', 0, 'more', false);
  END IF;
  ids := ARRAY(SELECT a.player_id FROM marketing_audience('push', g.city_id, g.interests, g.cursor_player, width) a);
  FOREACH who IN ARRAY ids LOOP
    IF NOT promo_push_free(who) THEN
      held := held + 1;
    ELSIF notice_create('group_push_promo', NULL, NULL, who, '{}', group_push_params(g), 'gpush:' || g.id || ':' || who,
                        NULL) IS NOT NULL THEN
      fresh := fresh + 1;
    END IF;
  END LOOP;
  UPDATE group_push x
  SET cursor_player = coalesce(ids[cardinality(ids)], x.cursor_player), notices = x.notices + fresh,
      capped = x.capped + held, state = CASE WHEN cardinality(ids) < width THEN 'done' ELSE 'sending' END,
      finished_at = CASE WHEN cardinality(ids) < width THEN now() END
  WHERE x.id = g.id;
  RETURN jsonb_build_object('rows', cardinality(ids), 'more', cardinality(ids) >= width);
END $$;
REVOKE ALL ON FUNCTION group_push_fan() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION group_push_fan() TO questify_app;
