-- Two review follow-ups (FOLLOWUPS, 2026-10-31). No table, column or grant changes: both functions keep their
-- signatures, so CREATE OR REPLACE keeps their grants (owner-only doors for the API's role, nothing for PUBLIC).
SET LOCAL lock_timeout = '10s';

-- A cheers moment no longer outlasts the finale (T-509 review, Q-344). While a finale is pending the moment ends when
-- the finale starts, and once the finale has started no moment starts: CH409 `finale_started`. As 0090 otherwise.
CREATE OR REPLACE FUNCTION start_cheers_moment(target_event uuid, minutes integer, request uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev        event := award_event_of(target_event);
  ending    timestamptz;
  finale_at timestamptz;
BEGIN
  IF NOT app_is_owner(ev.organizer_id) THEN
    RAISE EXCEPTION 'only the owner starts a cheers moment' USING ERRCODE = 'CH403';
  END IF;
  IF NOT big_screen_on(ev) THEN
    RAISE EXCEPTION 'the big screen is not active for this event' USING ERRCODE = 'BS403';
  END IF;
  IF NOT feature_enabled(ev, 'cheers') THEN
    RAISE EXCEPTION 'cheers are off for this event' USING ERRCODE = 'CH409', DETAIL = 'cheers_off';
  END IF;
  IF event_status_now(ev.status, ev.starts_at, ev.ends_at) <> 'live' THEN
    RAISE EXCEPTION 'the event is not live' USING ERRCODE = 'CH409', DETAIL = 'not_live';
  END IF;
  IF minutes IS NULL OR minutes < 1 OR minutes > 30 THEN
    RAISE EXCEPTION 'a moment lasts 1 to 30 minutes' USING ERRCODE = 'CH422', DETAIL = 'minutes';
  END IF;
  SELECT f.starts_at INTO finale_at FROM finale f WHERE f.event_id = ev.id;
  IF finale_at IS NOT NULL AND finale_at <= now() THEN
    RAISE EXCEPTION 'the finale has started' USING ERRCODE = 'CH409', DETAIL = 'finale_started';
  END IF;
  ending := least(now() + minutes * interval '1 minute', coalesce(finale_at, 'infinity'::timestamptz));
  DELETE FROM cheer c WHERE c.event_id = ev.id;
  INSERT INTO cheers_moment (event_id, organizer_id, started_at, ends_at, started_by)
  VALUES (ev.id, ev.organizer_id, now(), ending, app_staff_user_id())
  ON CONFLICT (event_id) DO UPDATE
  SET started_at = excluded.started_at, ends_at = excluded.ends_at, started_by = excluded.started_by;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after, request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'cheers.start', 'event', ev.id::text,
          jsonb_build_object('minutes', minutes, 'endsAt', ending), request);
  RETURN cheers_json(ev);
END $$;

-- A tag whose sponsor or item was deleted between the existence check and the insert (the foreign key then refuses it)
-- is the same "no such item or sponsor" SO404 as one deleted before the check, not a server fault (T-507 review).
-- As 0088 otherwise.
CREATE OR REPLACE FUNCTION sponsor_tag_set(target_event uuid, tag_kind text, target_item uuid, target_sponsor uuid, request uuid)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := sponsor_event_for_write(target_event);
BEGIN
  IF tag_kind IS NULL OR tag_kind NOT IN ('quest', 'category', 'reward') THEN
    RAISE EXCEPTION 'check the tag''s kind' USING ERRCODE = 'PS422', DETAIL = 'kind';
  END IF;
  IF (tag_kind = 'quest' AND NOT EXISTS (SELECT 1 FROM quest q WHERE q.id = target_item AND q.event_id = ev.id))
     OR (tag_kind = 'category' AND NOT EXISTS (SELECT 1 FROM category c WHERE c.id = target_item AND c.event_id = ev.id))
     OR (tag_kind = 'reward' AND NOT EXISTS (SELECT 1 FROM reward r
                                             WHERE r.id = target_item AND r.event_id = ev.id AND r.status = 'active'))
     OR (target_sponsor IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM sponsor s WHERE s.id = target_sponsor AND s.event_id = ev.id)) THEN
    RAISE EXCEPTION 'no such item or sponsor in this event' USING ERRCODE = 'SO404';
  END IF;
  DELETE FROM sponsor_tag t
  WHERE t.event_id = ev.id AND t.kind = tag_kind AND sponsor_tag_target(t) = target_item;
  IF target_sponsor IS NOT NULL THEN
    BEGIN
      INSERT INTO sponsor_tag (organizer_id, event_id, sponsor_id, kind, quest_id, category_id, reward_id, created_by)
      VALUES (ev.organizer_id, ev.id, target_sponsor, tag_kind,
              CASE WHEN tag_kind = 'quest' THEN target_item END,
              CASE WHEN tag_kind = 'category' THEN target_item END,
              CASE WHEN tag_kind = 'reward' THEN target_item END,
              app_staff_user_id());
    EXCEPTION WHEN foreign_key_violation THEN
      RAISE EXCEPTION 'no such item or sponsor in this event' USING ERRCODE = 'SO404';
    END;
  END IF;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after, request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'sponsor.tag', tag_kind, target_item::text,
          jsonb_build_object('sponsor', target_sponsor), request);
  RETURN sponsor_team_list(ev.id);
END $$;
