-- T-601: duplicate an event (FR-1016; plan docs/plans/2026-10-31-t-601-duplicate-event.md; ADR-380).
-- One door, event_copy_setup(source, target, request), copies an event's SETUP into a new draft the caller just made:
-- the event's own settings and switches, its default notification topics, join form, quest items, categories, quests,
-- first-bonus rules, passport steps, rewards, rank prizes, streak settings, agenda, maps with pins, sponsors with tags and
-- big-screen scenes. Every copied row gets a new id (copy_id), and every reference between copied rows points at the
-- copies. Times of the old event move by the distance between the two start times.
-- It never copies a person, a play row or a secret: no enrollment, guest, completion, ledger or XP row, no redemption,
-- reward code, submission, vote, rating, ticket or message; no QR or NFC tag, paired device, operator, speaker link or
-- invitation; no activation, entitlement or result. A quest that asks for a typed entry code gets a NEW random code. A
-- digital reward starts with no stock (its stock is its codes). Removed rewards, items and rank prizes are left behind.
-- Deny by default: no new table. The helpers are closed to PUBLIC and granted to nobody; only the door is granted to the
-- API role, and it works only between two events of the caller's own organizer (award_event_of; AN404 otherwise), so a
-- scoped editor, who cannot create an event, cannot reach it either. No EXCEPTION block; earlier migrations untouched.

-- ================================================================ helpers (internal)
-- The id a source row's copy gets inside one target event. Stable, so a reference to a copied row can be rebuilt in plain
-- SQL without a mapping table. It reveals nothing a session does not already need: every read and write still checks the
-- caller's organizer.
CREATE FUNCTION copy_id(source_id uuid, target_event uuid) RETURNS uuid
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT md5('copy:' || source_id::text || ':' || target_event::text)::uuid
$$;
REVOKE ALL ON FUNCTION copy_id(uuid, uuid) FROM PUBLIC;

-- A new typed entry code for a copied quest: ten characters of a random id, letters and digits only (the quest builder's
-- rule), never the source quest's code.
CREATE FUNCTION fresh_entry_code() RETURNS text
  LANGUAGE sql VOLATILE SET search_path = public, pg_temp AS $$
  SELECT upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))
$$;
REVOKE ALL ON FUNCTION fresh_entry_code() FROM PUBLIC;

-- The target must be the empty draft just made: nothing but the General category every event starts with.
CREATE FUNCTION event_copy_target_ok(target uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT (SELECT count(*) FROM category c WHERE c.event_id = target) <= 1
     AND NOT EXISTS (SELECT 1 FROM quest q WHERE q.event_id = target)
     AND NOT EXISTS (SELECT 1 FROM reward r WHERE r.event_id = target)
     AND NOT EXISTS (SELECT 1 FROM quest_item i WHERE i.event_id = target)
     AND NOT EXISTS (SELECT 1 FROM event_join_field f WHERE f.event_id = target)
     AND NOT EXISTS (SELECT 1 FROM enrollment n WHERE n.event_id = target)
$$;
REVOKE ALL ON FUNCTION event_copy_target_ok(uuid) FROM PUBLIC;

-- ================================================================ the event's own settings (internal)
-- The settings the event builder does not write (the shop, the desk, limits, caps, rules, switches and words). The
-- desk hours are absolute times, so they move with the dates. Not copied: the join code, the status, the activation,
-- the times (the new draft has its own) and the player limit (Questify sets it at activation, as a billing term).
CREATE FUNCTION event_copy_settings(src event, tgt event, shift interval) RETURNS void
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE event e SET
    pickup_minutes = src.pickup_minutes, shop_days_after = src.shop_days_after,
    shop_rules_ar = src.shop_rules_ar, shop_rules_en = src.shop_rules_en,
    spend_lowers_rank = src.spend_lowers_rank, join_fields_version = src.join_fields_version,
    guest_list_only = src.guest_list_only, email_domains = src.email_domains, welcome_points = src.welcome_points,
    desk_location_ar = src.desk_location_ar, desk_location_en = src.desk_location_en,
    desk_lat = src.desk_lat, desk_lng = src.desk_lng,
    desk_hours = (SELECT range_agg(tstzrange(lower(h) + shift, upper(h) + shift)) FROM unnest(src.desk_hours) AS h),
    handover_confirm = src.handover_confirm, award_cap_each = src.award_cap_each, award_cap_day = src.award_cap_day,
    flag_hold = src.flag_hold, rank_prizes = src.rank_prizes, rules_ar = src.rules_ar, rules_en = src.rules_en,
    config = src.config
  WHERE e.id = tgt.id;
  INSERT INTO event_topic_off (event_id, organizer_id, topic)
  SELECT tgt.id, tgt.organizer_id, d.topic FROM event_topic_off d WHERE d.event_id = src.id;
END $$;
REVOKE ALL ON FUNCTION event_copy_settings(event, event, interval) FROM PUBLIC;

-- ================================================================ the quest side (internal)
-- Items, the join form and categories, in the order their references need. Answers how many of each were copied.
CREATE FUNCTION event_copy_structure(src event, tgt event, shift interval) RETURNS jsonb
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  counts jsonb := '{}'::jsonb;
  n     integer;
BEGIN
  INSERT INTO quest_item (id, organizer_id, event_id, name_ar, name_en, description_ar, description_en, stock_total, status)
  SELECT copy_id(i.id, tgt.id), tgt.organizer_id, tgt.id, i.name_ar, i.name_en, i.description_ar, i.description_en,
         i.stock_total, 'active'
  FROM quest_item i WHERE i.event_id = src.id AND i.status = 'active';
  GET DIAGNOSTICS n = ROW_COUNT;
  counts := counts || jsonb_build_object('items', n);

  INSERT INTO event_join_field (id, organizer_id, event_id, kind, label_ar, label_en, required, position, options)
  SELECT copy_id(f.id, tgt.id), tgt.organizer_id, tgt.id, f.kind, f.label_ar, f.label_en, f.required, f.position, f.options
  FROM event_join_field f WHERE f.event_id = src.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  counts := counts || jsonb_build_object('joinFields', n);

  -- The unlock order is set after every category exists.
  INSERT INTO category (id, organizer_id, event_id, name_ar, name_en, position, audience_kind, audience_field_id,
                        audience_values, order_mode, opens_at, completion_bonus, refresh, hidden, item_id)
  SELECT copy_id(c.id, tgt.id), tgt.organizer_id, tgt.id, c.name_ar, c.name_en, c.position, c.audience_kind,
         copy_id(c.audience_field_id, tgt.id), c.audience_values, c.order_mode, c.opens_at + shift,
         c.completion_bonus, c.refresh, c.hidden, copy_id(c.item_id, tgt.id)
  FROM category c WHERE c.event_id = src.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  counts := counts || jsonb_build_object('categories', n);
  UPDATE category c SET unlock_after = copy_id(s.unlock_after, tgt.id)
  FROM category s WHERE s.event_id = src.id AND c.id = copy_id(s.id, tgt.id) AND s.unlock_after IS NOT NULL;
  RETURN counts;
END $$;
REVOKE ALL ON FUNCTION event_copy_structure(event, event, interval) FROM PUBLIC;

-- Quests with their first-bonus rule and passport steps. A launched flash quest and a sent poll start unsent; a typed
-- entry code is replaced. Answers how many quests were copied.
CREATE FUNCTION event_copy_quests(src event, tgt event, shift interval) RETURNS integer
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
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
  FROM quest q WHERE q.event_id = src.id;
  GET DIAGNOSTICS n = ROW_COUNT;
  INSERT INTO quest_first_bonus (quest_id, organizer_id, event_id, points, slots)
  SELECT copy_id(b.quest_id, tgt.id), tgt.organizer_id, tgt.id, b.points, b.slots
  FROM quest_first_bonus b WHERE b.event_id = src.id;
  INSERT INTO passport_step (id, organizer_id, event_id, quest_id, name_ar, name_en, position)
  SELECT copy_id(p.id, tgt.id), tgt.organizer_id, tgt.id, copy_id(p.quest_id, tgt.id), p.name_ar, p.name_en, p.position
  FROM passport_step p WHERE p.event_id = src.id;
  UPDATE event e SET focus_quest_id = copy_id(src.focus_quest_id, tgt.id)
  WHERE e.id = tgt.id AND src.focus_quest_id IS NOT NULL;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION event_copy_quests(event, event, interval) FROM PUBLIC;

-- Rewards and rank prizes still on offer. A digital reward's stock is its codes, which are not copied, so it starts at 0.
-- Answers how many of each were copied.
CREATE FUNCTION event_copy_prizes(src event, tgt event, shift interval) RETURNS jsonb
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
  FROM reward r WHERE r.event_id = src.id AND r.status = 'active';
  GET DIAGNOSTICS rewards = ROW_COUNT;
  INSERT INTO rank_prize (id, organizer_id, event_id, rank_from, rank_to, kind, name_ar, name_en, description_ar,
                          description_en)
  SELECT copy_id(p.id, tgt.id), tgt.organizer_id, tgt.id, p.rank_from, p.rank_to, p.kind, p.name_ar, p.name_en,
         p.description_ar, p.description_en
  FROM rank_prize p WHERE p.event_id = src.id AND p.status = 'active';
  GET DIAGNOSTICS prizes = ROW_COUNT;
  RETURN jsonb_build_object('rewards', rewards, 'rankPrizes', prizes);
END $$;
REVOKE ALL ON FUNCTION event_copy_prizes(event, event, interval) FROM PUBLIC;

-- ================================================================ the rest of the setup (internal)
-- Streak settings, agenda, maps with pins, sponsors with tags and the big screen's scenes. Answers the counts.
CREATE FUNCTION event_copy_extras(src event, tgt event, shift interval) RETURNS jsonb
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  day_shift integer := coalesce(event_day(tgt.starts_at, tgt) - event_day(src.starts_at, src), 0);
  who       uuid := app_staff_user_id();
  sessions  integer;
  maps      integer;
  pins      integer;
  sponsors  integer;
  tags      integer;
BEGIN
  INSERT INTO event_streak (event_id, organizer_id, enabled, bonus_points, closed_weekdays, closed_days)
  SELECT tgt.id, tgt.organizer_id, s.enabled, s.bonus_points, s.closed_weekdays,
         ARRAY(SELECT d + day_shift FROM unnest(s.closed_days) AS d ORDER BY d)
  FROM event_streak s WHERE s.event_id = src.id;

  INSERT INTO event_session (id, organizer_id, event_id, kind, title_ar, title_en, description_ar, description_en,
                             place_ar, place_en, speakers, starts_at, ends_at, access, seats, closes_at,
                             registration_open, walk_ins, reminder_minutes, quest_id, created_by)
  SELECT copy_id(s.id, tgt.id), tgt.organizer_id, tgt.id, s.kind, s.title_ar, s.title_en, s.description_ar,
         s.description_en, s.place_ar, s.place_en, s.speakers, s.starts_at + shift, s.ends_at + shift, s.access,
         s.seats, s.closes_at + shift, s.registration_open, s.walk_ins, s.reminder_minutes,
         copy_id(s.quest_id, tgt.id), who
  FROM event_session s WHERE s.event_id = src.id;
  GET DIAGNOSTICS sessions = ROW_COUNT;

  INSERT INTO event_map (id, organizer_id, event_id, name_ar, name_en, position, created_by)
  SELECT copy_id(m.id, tgt.id), tgt.organizer_id, tgt.id, m.name_ar, m.name_en, m.position, who
  FROM event_map m WHERE m.event_id = src.id;
  GET DIAGNOSTICS maps = ROW_COUNT;
  INSERT INTO map_pin (id, organizer_id, event_id, map_id, kind, amenity, name_ar, name_en, details_ar, details_en, x, y,
                       quest_id, created_by)
  SELECT copy_id(p.id, tgt.id), tgt.organizer_id, tgt.id, copy_id(p.map_id, tgt.id), p.kind, p.amenity, p.name_ar,
         p.name_en, p.details_ar, p.details_en, p.x, p.y, copy_id(p.quest_id, tgt.id), who
  FROM map_pin p WHERE p.event_id = src.id;
  GET DIAGNOSTICS pins = ROW_COUNT;

  INSERT INTO sponsor (id, organizer_id, event_id, name_ar, name_en, tier, booth, created_by)
  SELECT copy_id(s.id, tgt.id), tgt.organizer_id, tgt.id, s.name_ar, s.name_en, s.tier, s.booth, who
  FROM sponsor s WHERE s.event_id = src.id;
  GET DIAGNOSTICS sponsors = ROW_COUNT;
  -- A tag on a reward that was removed has nothing to point at.
  INSERT INTO sponsor_tag (id, organizer_id, event_id, sponsor_id, kind, quest_id, category_id, reward_id, created_by)
  SELECT copy_id(t.id, tgt.id), tgt.organizer_id, tgt.id, copy_id(t.sponsor_id, tgt.id), t.kind,
         copy_id(t.quest_id, tgt.id), copy_id(t.category_id, tgt.id), copy_id(t.reward_id, tgt.id), who
  FROM sponsor_tag t
  WHERE t.event_id = src.id
    AND (t.reward_id IS NULL OR EXISTS (SELECT 1 FROM reward r WHERE r.id = t.reward_id AND r.status = 'active'));
  GET DIAGNOSTICS tags = ROW_COUNT;

  INSERT INTO big_screen (event_id, organizer_id, scenes, updated_by)
  SELECT tgt.id, tgt.organizer_id, b.scenes, who FROM big_screen b WHERE b.event_id = src.id;

  RETURN jsonb_build_object('sessions', sessions, 'maps', maps, 'pins', pins, 'sponsors', sponsors,
                            'sponsorTags', tags);
END $$;
REVOKE ALL ON FUNCTION event_copy_extras(event, event, interval) FROM PUBLIC;

-- ================================================================ the door
-- Copies the setup of `source_event` into `target_event`, the empty draft the caller just made (the API makes it, with
-- the new name and dates, in the same transaction). Owner or editor of both events (award_event_of; AN404 for an event of
-- another organizer or outside an editor's limit); ED422 when both are one event; ED409 when the target is not an empty
-- draft. Audited `event.duplicate` with what was copied. Answers the counts.
CREATE FUNCTION event_copy_setup(source_event uuid, target_event uuid, request uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  src    event := award_event_of(source_event);
  tgt    event := award_event_of(target_event);
  shift  interval;
  counts jsonb;
BEGIN
  IF src.id = tgt.id THEN
    RAISE EXCEPTION 'an event cannot be copied onto itself' USING ERRCODE = 'ED422', DETAIL = 'same_event';
  END IF;
  PERFORM 1 FROM event e WHERE e.id = src.id FOR SHARE;
  PERFORM 1 FROM event e WHERE e.id = tgt.id FOR NO KEY UPDATE;
  IF tgt.status <> 'draft' OR NOT event_copy_target_ok(tgt.id) THEN
    RAISE EXCEPTION 'the new event must be an empty draft' USING ERRCODE = 'ED409', DETAIL = 'target_not_empty';
  END IF;
  DELETE FROM category c WHERE c.event_id = tgt.id;
  shift := coalesce(tgt.starts_at - src.starts_at, interval '0');
  PERFORM event_copy_settings(src, tgt, shift);
  counts := event_copy_structure(src, tgt, shift);
  counts := counts || jsonb_build_object('quests', event_copy_quests(src, tgt, shift));
  counts := counts || event_copy_prizes(src, tgt, shift) || event_copy_extras(src, tgt, shift);
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after, request_id)
  VALUES ('staff', app_staff_user_id(), tgt.organizer_id, tgt.id, 'event.duplicate', 'event', tgt.id::text,
          jsonb_build_object('source', src.id) || counts, request);
  RETURN counts;
END $$;
REVOKE ALL ON FUNCTION event_copy_setup(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION event_copy_setup(uuid, uuid, uuid) TO questify_app;
