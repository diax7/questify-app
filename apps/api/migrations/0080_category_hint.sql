-- T-501g: the hidden-category hint push (FR-238; plan docs/plans/2026-10-28-t-501g-hint-push.md on the T-501 plan's
-- "Owed pushes" row 17; ADR-357). The organizer's "Send a hint" on a hidden category writes one notice through
-- notice_create (kind category_hint, refs the category's id, params the event's name); the fan-out then reveals the
-- category (category_reveal) to each member it writes a center row for, in the same statement, so the recipients and the
-- players who see the category are one set by construction. The reveal never waits on a device, a permission, a mute,
-- the platform switch or a delivery. A recipient is an active real member (a rehearsal account on a draft or scheduled
-- event) who joined at or before the press, is in the category's audience and was not told by an earlier hint of the
-- category since joining. Nothing here widens any grant: category_reveal keeps no grant and is written only by the
-- fan-out's definer-called function; the two doors check the caller's right to edit the event. No EXCEPTION block.
-- Migrations 0079 and earlier untouched.
SET LOCAL lock_timeout = '10s';

-- ================================================================ the kind (ADR-357)
-- Event class (priority 1), topic announcements (mutable: a muted topic still gets the center row and the reveal),
-- 2 hours like an opening. Not a `before_start` kind: it reaches real members of a live event, and rehearsal accounts
-- of a draft or scheduled one.
INSERT INTO notice_kind (kind, class, topic, membership, before_start, priority, ttl) VALUES
  ('category_hint', 'event', 'announcements', 'active', false, 1, interval '2 hours');

-- ================================================================ who is told (internal: no grant)
-- Whether a member is a recipient of a hint notice beyond the membership and status rules (which the notice's kind row
-- and event decide): joined at or before the press (`notice.created_at` is the press transaction's start; a player who
-- joins or re-joins later is not told); the category is this event's, still hidden, and the member is in its audience
-- (in_audience: no rule, or an answer or tag match; a rehearsal account always); and no earlier hint of the category has
-- given the member a center row since they joined (a second press reaches only members not yet told; the "since they
-- joined" keeps a rehearsal-era row of a team player from silencing their real hint). PL/pgSQL, with in_audience in a
-- plain expression, so a fan-out of 50,000 keeps its plans (docs/rules.md).
CREATE FUNCTION push_hint_ok(nt notice, member enrollment) RETURNS boolean
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  cat category;
BEGIN
  IF member.joined_at > nt.created_at THEN
    RETURN false;
  END IF;
  SELECT x.* INTO cat FROM category x WHERE x.id = push_ref(nt.refs, 'category') AND x.event_id = nt.event_id AND x.hidden;
  IF NOT FOUND THEN
    RETURN false;
  ELSIF NOT in_audience(member.id, cat.audience_kind, cat.audience_field_id, cat.audience_values) THEN
    RETURN false;
  END IF;
  RETURN NOT EXISTS (SELECT 1 FROM notice earlier JOIN notification told ON told.notice_id = earlier.id
                     WHERE earlier.event_id = nt.event_id AND earlier.kind = 'category_hint'
                       AND earlier.audience = 'event' AND earlier.refs ->> 'category' = cat.id::text
                       AND earlier.id < nt.id AND told.player_id = member.player_id
                       AND told.created_at >= member.joined_at);
END $$;
REVOKE ALL ON FUNCTION push_hint_ok(notice, enrollment) FROM PUBLIC;

-- As 0078, with one change: a hint notice is the grant of the category it names, so the member's not yet seeing it
-- (sees_category) does not hide it; the category must still be one of the event's (a missing or malformed reference
-- hides the notice) and push_hint_ok decides who is a recipient. Every other kind is checked as before.
CREATE OR REPLACE FUNCTION notice_visible(nt notice, member enrollment) RETURNS boolean
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  target uuid;
  cat    category;
BEGIN
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
REVOKE ALL ON FUNCTION notice_visible(notice, enrollment) FROM PUBLIC;

-- As 0079, plus the hint: a member who may not play is not told (as every event kind), then push_hint_ok. Asked at the
-- fan-out and again at the claim (push_skip_reason, 0079), so a category made visible, a player who left or a hint
-- already received is skipped before sending.
CREATE OR REPLACE FUNCTION notice_audience_ok(nt notice, member enrollment) RETURNS boolean
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  ev     event;
  target uuid;
BEGIN
  IF nt.id IS NULL THEN
    RETURN false;
  ELSIF nt.kind = 'streak_reminder' THEN
    RETURN push_streak_open(nt);
  ELSIF nt.kind = 'invitation' THEN
    SELECT e.* INTO ev FROM event e WHERE e.id = nt.event_id;
    RETURN member.id IS NULL AND invitation_event_ok(ev, true) IS NULL;
  ELSIF nt.kind NOT IN ('flash_quest', 'boost_start', 'poll_sent', 'community_step', 'category_open', 'event_soon',
                        'shop_closing', 'category_hint') THEN
    RETURN true;
  ELSIF member.id IS NULL THEN
    RETURN false;
  END IF;
  SELECT e.* INTO ev FROM event e
  WHERE e.id = nt.event_id
    AND NOT EXISTS (SELECT 1 FROM staff_assignment sa
                    WHERE sa.event_id = e.id AND sa.player_id = member.player_id AND NOT sa.can_play);
  IF NOT FOUND THEN
    RETURN false;
  ELSIF nt.kind = 'category_hint' THEN
    RETURN push_hint_ok(nt, member);
  ELSIF nt.kind = 'shop_closing' THEN
    RETURN push_shop_open(nt, ev, member);
  ELSIF nt.kind IN ('flash_quest', 'boost_start', 'category_open') AND NOT push_category_opened(nt) THEN
    RETURN false;
  ELSIF nt.kind IN ('flash_quest', 'category_open') THEN
    RETURN true;
  ELSIF nt.kind = 'poll_sent' THEN
    IF NOT polls_shown(ev) THEN
      RETURN false;
    END IF;
    target := push_ref(nt.refs, 'quest');
    RETURN NOT EXISTS (SELECT 1 FROM quest_completion qc WHERE qc.enrollment_id = member.id AND qc.quest_id = target);
  ELSIF nt.kind = 'boost_start' THEN
    IF NOT boosts_on(ev) THEN
      RETURN false;
    END IF;
    target := push_ref(nt.refs, 'boost');
    RETURN EXISTS (SELECT 1 FROM boost b
                   WHERE b.id = target AND b.event_id = ev.id AND b.ends_at > now()
                     AND b.rehearsal = (member.joined_via IS NOT DISTINCT FROM 'rehearsal'));
  ELSIF nt.kind = 'event_soon' THEN
    RETURN nt.dedupe = 'event_soon:' || ev.id || ':' || push_instant(ev.starts_at);
  END IF;
  RETURN community_on(ev);  -- community_step, the last kind left
END $$;
REVOKE ALL ON FUNCTION notice_audience_ok(notice, enrollment) FROM PUBLIC;

-- ================================================================ the reveal, in the fan-out (ADR-357 (2))
-- As 0078 (1,000 enrollments a call; 500 for a hint, whose reveals and per-member rules cost about a third more a
-- member, so a call stays under half a second), plus: for a hint notice, a category_reveal row for every member of the batch who
-- passes the batch's checks, written by the same statement as their center row (ON CONFLICT: a member who found the
-- category by its code already has theirs). A data-modifying CTE always runs, whether or not the final SELECT reads it,
-- and it adds no row for any other kind. If the batch fails it is undone whole, reveals included, and tried again after
-- the notice's back-off.
CREATE OR REPLACE FUNCTION push_fan_out_batch(nt notice) RETURNS jsonb
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  made  bigint[];
  last  uuid;
  seen  integer;
  width integer := CASE WHEN nt.kind = 'category_hint' THEN 500 ELSE 1000 END;
BEGIN
  WITH batch AS MATERIALIZED (
    SELECT n.id, n.player_id,
           p.status = 'active' AND notice_member_ok(nt, n) AND notice_audience_ok(nt, n) AS ok
    FROM enrollment n JOIN player p ON p.id = n.player_id
    WHERE n.event_id = nt.event_id AND (nt.fan_cursor IS NULL OR n.id > nt.fan_cursor)
    ORDER BY n.id LIMIT width),
  revealed AS (
    INSERT INTO category_reveal (organizer_id, event_id, enrollment_id, category_id)
    SELECT nt.organizer_id, nt.event_id, b.id, push_ref(nt.refs, 'category')
    FROM batch b WHERE nt.kind = 'category_hint' AND b.ok ORDER BY b.id
    ON CONFLICT DO NOTHING
    RETURNING 1),
  inserted AS (
    INSERT INTO notification (notice_id, player_id, event_id)
    SELECT nt.id, b.player_id, nt.event_id FROM batch b WHERE b.ok ORDER BY b.id
    ON CONFLICT (notice_id, player_id) DO NOTHING
    RETURNING id)
  SELECT (SELECT coalesce(array_agg(i.id), '{}') FROM inserted i),
         (SELECT b.id FROM batch b ORDER BY b.id DESC LIMIT 1),
         (SELECT count(*)::integer FROM batch)
  INTO made, last, seen;
  UPDATE notice x
  SET fan_cursor = coalesce(last, x.fan_cursor), fanned_at = CASE WHEN seen < width THEN now() END, fan_failures = 0,
      retry_after = NULL
  WHERE x.id = nt.id;
  PERFORM push_plan(made);
  RETURN jsonb_build_object('rows', cardinality(made), 'more', true);
END $$;
REVOKE ALL ON FUNCTION push_fan_out_batch(notice) FROM PUBLIC;

-- ================================================================ the button's doors (ADR-357 (1), (4))
-- What a hint may be sent in: a live event (the go-live wipe has run: see send_category_hint), or a draft or scheduled
-- one while its rehearsal is open (a test hint that reaches the rehearsal accounts and is wiped with them), as Send poll
-- (0052). NULL for anything else (an ended or archived event, a draft with no rehearsal). Reads only.
CREATE FUNCTION hint_phase(ev event) RETURNS text
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  phase text := event_status_now(ev.status, ev.starts_at, ev.ends_at);
BEGIN
  IF phase = 'live' THEN
    RETURN 'live';
  ELSIF phase IN ('draft', 'scheduled')
        AND EXISTS (SELECT 1 FROM event_rehearsal r WHERE r.event_id = ev.id AND r.live_wiped_at IS NULL) THEN
    RETURN 'rehearsal';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION hint_phase(event) FROM PUBLIC;

-- Whether a hint of the category is still being delivered: a notice of the last 10 minutes whose fan-out is not done.
-- An older one that never finished is a fault for the operator (push.notice_parked), not a reason to block the button.
CREATE FUNCTION hint_pending(target_event uuid, target_category uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM notice nt
                 WHERE nt.event_id = target_event AND nt.kind = 'category_hint' AND nt.audience = 'event'
                   AND nt.refs ->> 'category' = target_category::text AND nt.fanned_at IS NULL
                   AND nt.created_at > now() - interval '10 minutes')
$$;
REVOKE ALL ON FUNCTION hint_pending(uuid, uuid) FROM PUBLIC;

-- A hidden category of the event, locked FOR NO KEY UPDATE when asked so that two presses and a category save take turns
-- without blocking the players' reveal (a foreign key's KEY SHARE does not conflict with it). AN404 for a category of
-- another event, QH422 for one that is not hidden.
CREATE FUNCTION hint_category(ev event, target_category uuid, lock_it boolean) RETURNS category
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  cat category;
BEGIN
  IF lock_it THEN
    SELECT c.* INTO cat FROM category c WHERE c.id = target_category AND c.event_id = ev.id FOR NO KEY UPDATE;
  ELSE
    SELECT c.* INTO cat FROM category c WHERE c.id = target_category AND c.event_id = ev.id;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such category in this event' USING ERRCODE = 'AN404';
  ELSIF NOT cat.hidden THEN
    RAISE EXCEPTION 'this category is not hidden' USING ERRCODE = 'QH422';
  END IF;
  RETURN cat;
END $$;
REVOKE ALL ON FUNCTION hint_category(event, uuid, boolean) FROM PUBLIC;

-- How many members a hint would tell now, and whether the last one is still being delivered: one set-based statement
-- over the rules push_hint_ok and the membership and status rules state per member (a database test requires the two to
-- agree on a crowd with every excluded kind and on each audience rule), so a 50,000-member event stays under the API's
-- statement limit. Two rules are set-based on purpose, because their per-member forms cost 0.05 to 0.25 ms a member:
-- the event's exclusion list is an anti-join with excluded_from_event's own test written out (that SQL function holds a
-- sub-select, so it is never inlined and costs 0.05 ms a member: 2.4 s at 50,000 as soon as the event has one entry),
-- and a tag audience is found from the guest list's side (in_audience, 0037, stays the per-member rule); an audience
-- kind this function does not know falls back to in_audience per member, so a new kind can be slow but never wrong. A
-- read: it never wipes a rehearsal. PE409 when a hint cannot be sent in this phase.
CREATE FUNCTION category_hint_preview(target_event uuid, target_category uuid)
  RETURNS TABLE (members integer, pending boolean)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev    event := award_event_of(target_event);
  phase text := hint_phase(ev);
  cat   category;
BEGIN
  IF phase IS NULL THEN
    RAISE EXCEPTION 'the event is not live' USING ERRCODE = 'PE409', DETAIL = 'event_not_live';
  END IF;
  cat := hint_category(ev, target_category, false);
  RETURN QUERY
  WITH tagged AS (
    SELECT pc.player_id FROM event_guest g JOIN player_contact pc ON pc.phone_e164 = g.value
    WHERE cat.audience_kind = 'tag' AND g.event_id = ev.id AND g.kind = 'phone' AND g.tag IS NOT NULL
      AND lower(g.tag) IN (SELECT lower(v) FROM unnest(cat.audience_values) v)
    UNION
    SELECT pc.player_id FROM event_guest g JOIN player_contact pc ON pc.email = g.value
    WHERE cat.audience_kind = 'tag' AND g.event_id = ev.id AND g.kind = 'email' AND g.tag IS NOT NULL
      AND lower(g.tag) IN (SELECT lower(v) FROM unnest(cat.audience_values) v))
  SELECT count(*)::integer, hint_pending(ev.id, cat.id)
  FROM enrollment n JOIN player p ON p.id = n.player_id AND p.status = 'active'
  WHERE n.event_id = ev.id AND n.status = 'active'
    AND (n.joined_via IS NOT DISTINCT FROM 'rehearsal') = (phase = 'rehearsal')
    AND NOT EXISTS (SELECT 1 FROM player_contact pc JOIN event_exclusion x ON x.event_id = n.event_id
                    WHERE pc.player_id = n.player_id
                      AND ((x.kind = 'phone' AND x.value = pc.phone_e164)
                           OR (x.kind = 'email_domain' AND x.value = split_part(pc.email, '@', 2))))
    AND NOT EXISTS (SELECT 1 FROM staff_assignment sa
                    WHERE sa.event_id = ev.id AND sa.player_id = n.player_id AND NOT sa.can_play)
    AND (cat.audience_kind IS NULL OR n.joined_via = 'rehearsal'
         OR (cat.audience_kind = 'answer'
             AND EXISTS (SELECT 1 FROM join_answer a
                         WHERE a.enrollment_id = n.id AND a.field_id = cat.audience_field_id
                           AND a.value = ANY (cat.audience_values)))
         OR (cat.audience_kind = 'tag' AND n.player_id IN (SELECT t.player_id FROM tagged t))
         OR (cat.audience_kind NOT IN ('answer', 'tag')
             AND in_audience(n.id, cat.audience_kind, cat.audience_field_id, cat.audience_values)))
    AND NOT EXISTS (SELECT 1 FROM notice earlier JOIN notification told ON told.notice_id = earlier.id
                    WHERE earlier.event_id = ev.id AND earlier.kind = 'category_hint' AND earlier.audience = 'event'
                      AND earlier.refs ->> 'category' = cat.id::text AND told.player_id = n.player_id
                      AND told.created_at >= n.joined_at);
END $$;
REVOKE ALL ON FUNCTION category_hint_preview(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION category_hint_preview(uuid, uuid) TO questify_app;

-- Sends the hint of a hidden category: one notice, once per press. `press` is the Idempotency-Key of the dashboard's
-- request (any text up to 255 characters), hashed into the notice's marker, so a replayed or raced press writes nothing
-- more and answers `replayed`; a different press while the last hint is still being delivered is refused (PH409
-- hint_in_progress), and so is a press when the count (category_hint_preview) is 0, because it would tell nobody (PT409
-- hint_nobody; checked after the replay, which still answers `replayed`). In a live event the go-live wipe runs first (as
-- Send poll). The reveal and the center rows are the fan-out's work, a second or so later. A missing kind row (a broken
-- deploy) writes nothing and raises nothing: the door answers `sent` false and the API reports it. Audited
-- `category.hint_send` (no recipients: they are not known until the fan-out ends). The notice is the last write, after
-- the category lock (docs/rules.md, the push store's lock order).
CREATE FUNCTION send_category_hint(target_event uuid, target_category uuid, press text, request uuid)
  RETURNS TABLE (sent boolean, replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev     event := award_event_of(target_event);
  phase  text := hint_phase(ev);
  cat    category;
  marker text;
  made   bigint;
BEGIN
  IF press IS NULL OR char_length(press) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'a press key of 1 to 255 characters is required' USING ERRCODE = 'PK400';
  ELSIF phase IS NULL THEN
    RAISE EXCEPTION 'the event is not live' USING ERRCODE = 'PE409', DETAIL = 'event_not_live';
  ELSIF phase = 'live' THEN
    PERFORM ensure_rehearsal_wiped(ev.id);
  END IF;
  cat := hint_category(ev, target_category, true);
  marker := 'hint:' || cat.id || ':' || encode(sha256(convert_to(press, 'UTF8')), 'hex');
  IF EXISTS (SELECT 1 FROM notice nt WHERE nt.dedupe = marker) THEN
    RETURN QUERY SELECT true, true;
    RETURN;
  ELSIF hint_pending(ev.id, cat.id) THEN
    RAISE EXCEPTION 'a hint of this category is still being delivered' USING ERRCODE = 'PH409', DETAIL = 'hint_in_progress';
  ELSIF (SELECT p.members FROM category_hint_preview(ev.id, cat.id) p) = 0 THEN
    RAISE EXCEPTION 'no member is left to tell' USING ERRCODE = 'PT409', DETAIL = 'hint_nobody';
  END IF;
  made := notice_create('category_hint', ev.organizer_id, ev.id, NULL, jsonb_build_object('category', cat.id),
                        jsonb_build_object('event', push_names(ev.name_ar, ev.name_en)), marker, NULL);
  IF made IS NULL THEN
    RETURN QUERY SELECT false, false;
    RETURN;
  END IF;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after, request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'category.hint_send', 'category', cat.id::text,
          jsonb_build_object('rehearsal', phase <> 'live'), request);
  RETURN QUERY SELECT true, false;
END $$;
REVOKE ALL ON FUNCTION send_category_hint(uuid, uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION send_category_hint(uuid, uuid, text, uuid) TO questify_app;
