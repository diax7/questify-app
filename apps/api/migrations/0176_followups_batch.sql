-- A batch of review follow-ups (docs/FOLLOWUPS.md, batch 20). Four functions restated with the same arguments, so their
-- owner and grants stay: push_fan_out_personal_ids, home_slide_checked, own_level_items, admin_unpublish. No new table,
-- column or function. Nothing here writes points or XP, changes what a sign-in does, a tenant rule or how a redemption is
-- locked. Deployed migrations untouched.
SET LOCAL lock_timeout = '10s';

-- ================================================================ the personal fan-out (T-501f review)
-- As 0076, with one change: a notice's own audience rule (notice_audience_ok, 0141) is checked at fan-out as the event pass
-- does, so a streak reminder for a player who has played since the scan, or an invitation for a player who has joined
-- since, writes no center row. The claim checked it already, so no push changes.
CREATE OR REPLACE FUNCTION push_fan_out_personal_ids(due bigint[]) RETURNS jsonb
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  made bigint[];
BEGIN
  WITH inserted AS (
    INSERT INTO notification (notice_id, player_id, event_id)
    SELECT nt.id, nt.player_id, nt.event_id
    FROM notice nt
    JOIN notice_kind k ON k.kind = nt.kind
    JOIN player p ON p.id = nt.player_id AND p.status = 'active'
    LEFT JOIN enrollment n ON n.event_id = nt.event_id AND n.player_id = nt.player_id
    WHERE nt.id = ANY (due) AND notice_member_ok(nt, n) AND notice_audience_ok(nt, n)
      AND (k.class <> 'promo' OR push_consented(nt.player_id))
    ORDER BY nt.id
    ON CONFLICT (notice_id, player_id) DO NOTHING
    RETURNING id)
  SELECT coalesce(array_agg(i.id), '{}') INTO made FROM inserted i;
  UPDATE notice nt SET fanned_at = now(), fan_failures = 0, retry_after = NULL WHERE nt.id = ANY (due);
  PERFORM push_plan(made);
  RETURN jsonb_build_object('rows', cardinality(made), 'more', true);
END $$;
REVOKE ALL ON FUNCTION push_fan_out_personal_ids(bigint[]) FROM PUBLIC;

-- ================================================================ a banner slide's link port (T-713 review)
-- As 0137, with one change: a port, when the link names one, is a real one (1 to 65535), as the shared `isAllowedLink`
-- already says; the pattern alone let five digits through.
CREATE OR REPLACE FUNCTION home_slide_checked(slide jsonb, place integer) RETURNS jsonb
  LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE
  field  text := 'banner.' || place;
  tap    jsonb := coalesce(slide -> 'action', '{"type": "none"}'::jsonb);
  kind   text;
  url    text;
  port   text;
  action jsonb;
BEGIN
  IF NOT home_only_keys(slide, ARRAY['title', 'subtitle', 'action']) OR NOT home_only_keys(tap, ARRAY['type', 'url']) THEN
    RAISE EXCEPTION 'a banner slide holds a title, a subtitle and a tap' USING ERRCODE = 'CA400', DETAIL = field;
  END IF;
  kind := tap ->> 'type';
  IF kind = 'none' AND NOT tap ? 'url' THEN
    action := '{"type": "none"}'::jsonb;
  ELSIF kind = 'link' AND jsonb_typeof(tap -> 'url') = 'string' THEN
    url := tap ->> 'url';
    port := substring(lower(url) FROM '^https://[^/?#:]+:([0-9]{1,5})');
    IF char_length(url) > 300 OR url ~ '[\x01-\x1F\x7F-\x9F]'
       OR url !~* '^https://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(:[0-9]{1,5})?([/?#][^[:space:]\\]*)?$'
       OR port::integer NOT BETWEEN 1 AND 65535 THEN
      RAISE EXCEPTION 'a slide link must be a full https address of at most 300 characters'
        USING ERRCODE = 'CA400', DETAIL = field || '.url';
    END IF;
    action := jsonb_build_object('type', 'link', 'url', url);
  ELSE
    RAISE EXCEPTION 'a slide opens nothing or a web link' USING ERRCODE = 'CA400', DETAIL = field || '.action';
  END IF;
  RETURN jsonb_build_object(
    'title', home_text_checked(slide -> 'title', field || '.title', 60, true),
    'subtitle', home_text_checked(coalesce(slide -> 'subtitle', '{}'::jsonb), field || '.subtitle', 100, false),
    'action', action);
END $$;
REVOKE ALL ON FUNCTION home_slide_checked(jsonb, integer) FROM PUBLIC;

-- ================================================================ a scan's level items (FOLLOWUPS batch 14 review)
-- As 0063, with the match own_level got in 0168: a level counts for the scan only when it was written in the scan's own
-- transaction (`reached_at` equals the XP entry's `created_at`), so a level a catch-up later filed on the same entry does
-- not list its item on a replay. Read only.
CREATE OR REPLACE FUNCTION own_level_items(completion bigint) RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(jsonb_agg(item_json(o.item_id) ORDER BY r.level), '[]'::jsonb)
  FROM level_reached r JOIN xp_entry x ON x.id = r.xp_entry_id JOIN ledger_entry l ON l.id = x.ledger_entry_id
  JOIN player_item o ON o.player_id = r.player_id AND o.source_level = r.level
  WHERE r.player_id = profile_player() AND l.completion_id = completion AND l.kind = 'quest'
    AND r.reached_at = x.created_at
$$;
REVOKE ALL ON FUNCTION own_level_items(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION own_level_items(bigint) TO questify_app;

-- ================================================================ unpublish takes the target's lock first (T-701b review)
-- As 0130, with one change: the target's report lock is taken before the target row (hold_target's FOR UPDATE) and before
-- any write, the order admin_report_resolve keeps, so the two never wait on each other in opposite orders.
CREATE OR REPLACE FUNCTION admin_unpublish(hold_kind text, target uuid, reason_code text, note text, request uuid)
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
  PERFORM report_target_lock(hold_kind, target);
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
