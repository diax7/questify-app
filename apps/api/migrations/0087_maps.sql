-- T-506: event maps (FR-820 to FR-827 without the uploaded picture; plan docs/plans/2026-10-30-t-506-maps.md; ADR-374).
-- An owner or editor adds any number of named maps to an event and places pins on them: sections, booths, amenities and
-- quests. A player reads the maps with their own state: a quest pin carries the quest and "you are here" marks the quest
-- the player last scanned at a station. A map is a reference only (FR-825): no route, no position of the phone. The
-- picture behind a map is T-506b (it needs a storage bucket, Q-149); until then a map is a plain board and a pin's place
-- is a fraction of the board (0 to 1000 across and down), which stays right when a picture is added. Deny by default: the
-- two new tables keep row-level security forced and no grant; every function is closed to PUBLIC in the group that
-- creates it and only the doors are granted to the API role. No EXCEPTION block. Migrations 0086 and earlier untouched.
SET LOCAL lock_timeout = '10s';
-- The event and the quest are foreign-key targets of the new tables.
LOCK TABLE event IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE quest IN SHARE ROW EXCLUSIVE MODE;

-- ================================================================ the tables (ADR-374 (2))
-- A map. A name in one language is enough (the other shows in its place), as a session's title is. `position` is the order
-- the app lists maps in: dense from 1, kept so by delete and by the order door. At most 50 per event (the door counts).
CREATE TABLE event_map (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id uuid NOT NULL,
  event_id     uuid NOT NULL,
  name_ar      text CHECK (char_length(name_ar) BETWEEN 1 AND 60 AND name_ar !~ '[[:cntrl:]]'),
  name_en      text CHECK (char_length(name_en) BETWEEN 1 AND 60 AND name_en !~ '[[:cntrl:]]'),
  position     integer NOT NULL CHECK (position BETWEEN 1 AND 50),
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE CASCADE,
  UNIQUE (id, event_id),
  CONSTRAINT event_map_name CHECK (name_ar IS NOT NULL OR name_en IS NOT NULL)
);
CREATE INDEX event_map_event ON event_map (event_id, position, created_at, id);
ALTER TABLE event_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_map FORCE ROW LEVEL SECURITY;
REVOKE ALL ON event_map FROM PUBLIC, questify_app;

-- A pin: a named section or booth, an amenity (a prayer room, toilets, food, the info desk, first aid) with an optional
-- name, or a quest (named by the quest itself, so it carries no name or details). `x` and `y` are thousandths of the
-- board's width and height from its top left, so a pin keeps its place whatever the picture's size. At most 300 per map.
-- A quest has one pin in an event (the unique index): "you are here" must point at one place. Deleting the quest or the
-- map deletes the pin.
CREATE TABLE map_pin (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id uuid NOT NULL,
  event_id     uuid NOT NULL,
  map_id       uuid NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('section', 'booth', 'quest', 'amenity')),
  amenity      text CHECK (amenity IN ('prayer', 'toilets', 'food', 'info', 'first_aid')),
  name_ar      text CHECK (char_length(name_ar) BETWEEN 1 AND 60 AND name_ar !~ '[[:cntrl:]]'),
  name_en      text CHECK (char_length(name_en) BETWEEN 1 AND 60 AND name_en !~ '[[:cntrl:]]'),
  details_ar   text CHECK (char_length(details_ar) BETWEEN 1 AND 500),
  details_en   text CHECK (char_length(details_en) BETWEEN 1 AND 500),
  x            smallint NOT NULL CHECK (x BETWEEN 0 AND 1000),
  y            smallint NOT NULL CHECK (y BETWEEN 0 AND 1000),
  quest_id     uuid,
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (map_id, event_id) REFERENCES event_map (id, event_id) ON DELETE CASCADE,
  FOREIGN KEY (quest_id, event_id) REFERENCES quest (id, event_id) ON DELETE CASCADE,
  CONSTRAINT map_pin_shape CHECK (
    (kind = 'quest' AND quest_id IS NOT NULL AND amenity IS NULL AND name_ar IS NULL AND name_en IS NULL
       AND details_ar IS NULL AND details_en IS NULL)
    OR (kind IN ('section', 'booth') AND quest_id IS NULL AND amenity IS NULL
        AND (name_ar IS NOT NULL OR name_en IS NOT NULL))
    OR (kind = 'amenity' AND quest_id IS NULL AND amenity IS NOT NULL))
);
CREATE INDEX map_pin_map ON map_pin (map_id, created_at, id);
CREATE UNIQUE INDEX map_pin_quest ON map_pin (quest_id) WHERE quest_id IS NOT NULL;
ALTER TABLE map_pin ENABLE ROW LEVEL SECURITY;
ALTER TABLE map_pin FORCE ROW LEVEL SECURITY;
REVOKE ALL ON map_pin FROM PUBLIC, questify_app;

-- ================================================================ helpers (internal: no grant)
-- A map as the dashboard lists it, its pins in the order they were placed.
CREATE FUNCTION map_team_item(m event_map) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', m.id, 'nameAr', m.name_ar, 'nameEn', m.name_en, 'position', m.position,
    'pins', coalesce((SELECT jsonb_agg(jsonb_build_object(
                'id', p.id, 'kind', p.kind, 'amenity', p.amenity, 'nameAr', p.name_ar, 'nameEn', p.name_en,
                'detailsAr', p.details_ar, 'detailsEn', p.details_en, 'x', p.x, 'y', p.y, 'questId', p.quest_id)
              ORDER BY p.created_at, p.id)
              FROM map_pin p WHERE p.map_id = m.id), '[]'::jsonb))
$$;
REVOKE ALL ON FUNCTION map_team_item(event_map) FROM PUBLIC;

-- Whether a member may be shown a pin: every pin but a quest's, and a quest's only when the quest is one the member may
-- list (the quest visible and shown, its category seen by that member: the Quests tab's own rule, before its window and
-- its switched-off types, which the API applies to the quests it lists).
CREATE FUNCTION map_pin_shown(p map_pin, member uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT p.kind <> 'quest'
         OR EXISTS (SELECT 1 FROM quest q JOIN category c ON c.id = q.category_id
                    WHERE q.id = p.quest_id AND q.event_id = p.event_id AND q.visible AND flash_shown(q)
                      AND sees_category(member, c))
$$;
REVOKE ALL ON FUNCTION map_pin_shown(map_pin, uuid) FROM PUBLIC;

-- The event's map writes take turns: one advisory lock per event, so the caps, the order and "a quest has one pin" are
-- checked on a state nobody else is changing. It is the only lock a map door takes before its own rows.
CREATE FUNCTION map_lock(target_event uuid) RETURNS void
  LANGUAGE sql SET search_path = public, pg_temp AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('event-maps:' || target_event::text, 0))
$$;
REVOKE ALL ON FUNCTION map_lock(uuid) FROM PUBLIC;

-- The caller's event for a write: AN404 when it is not theirs, MP409 `event_closed` when it is archived.
CREATE FUNCTION map_event_for_write(target_event uuid) RETURNS event
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  IF ev.status = 'archived' THEN
    RAISE EXCEPTION 'the event is archived' USING ERRCODE = 'MP409', DETAIL = 'event_closed';
  END IF;
  PERFORM map_lock(ev.id);
  RETURN ev;
END $$;
REVOKE ALL ON FUNCTION map_event_for_write(uuid) FROM PUBLIC;

-- ================================================================ the team's doors (ADR-374 (3))
-- Whether the caller may write this event's maps: AN404 otherwise. The API asks before it replays a stored answer to a
-- retried write, so a team member whose access ended gets nothing back.
CREATE FUNCTION map_authorize(target_event uuid) RETURNS void
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM award_event_of(target_event);
END $$;
REVOKE ALL ON FUNCTION map_authorize(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION map_authorize(uuid) TO questify_app;

-- The event's maps in order, each with its pins. AN404 for an event that is not the caller's.
CREATE FUNCTION map_list(target_event uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN coalesce((SELECT jsonb_agg(map_team_item(m) ORDER BY m.position, m.created_at, m.id)
                   FROM event_map m WHERE m.event_id = ev.id), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION map_list(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION map_list(uuid) TO questify_app;

-- Adds a map (`target_map` NULL) or renames one. The draft holds nameAr and nameEn (one is enough), already checked by
-- the API. AN404, MP404 (no such map in the event), PS422 (a field, as the detail), MP409 (`event_closed`, `limit`: 50
-- maps). A new map goes last. Audited `map.save`.
CREATE FUNCTION map_save(target_event uuid, draft jsonb, target_map uuid, request uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev    event := map_event_for_write(target_event);
  n_ar  text;
  n_en  text;
  item  event_map;
BEGIN
  IF jsonb_typeof(draft) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'check the map' USING ERRCODE = 'PS422', DETAIL = 'map';
  END IF;
  n_ar := session_text(draft, 'nameAr', 60, false);
  n_en := session_text(draft, 'nameEn', 60, false);
  IF n_ar IS NULL AND n_en IS NULL THEN
    RAISE EXCEPTION 'a map needs a name' USING ERRCODE = 'PS422', DETAIL = 'name';
  END IF;
  IF target_map IS NULL THEN
    IF (SELECT count(*) FROM event_map m WHERE m.event_id = ev.id) >= 50 THEN
      RAISE EXCEPTION 'an event holds 50 maps at most' USING ERRCODE = 'MP409', DETAIL = 'limit';
    END IF;
    INSERT INTO event_map (organizer_id, event_id, name_ar, name_en, position, created_by)
    VALUES (ev.organizer_id, ev.id, n_ar, n_en,
            (SELECT count(*)::integer + 1 FROM event_map m WHERE m.event_id = ev.id), app_staff_user_id())
    RETURNING * INTO item;
  ELSE
    UPDATE event_map m SET name_ar = n_ar, name_en = n_en, updated_at = now()
    WHERE m.id = target_map AND m.event_id = ev.id RETURNING m.* INTO item;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'no such map in this event' USING ERRCODE = 'MP404';
    END IF;
  END IF;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after, request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'map.save', 'event_map', item.id::text,
          jsonb_build_object('created', target_map IS NULL), request);
  RETURN map_team_item(item);
END $$;
REVOKE ALL ON FUNCTION map_save(uuid, jsonb, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION map_save(uuid, jsonb, uuid, uuid) TO questify_app;

-- Deletes a map with its pins and closes the gap in the order. Answers how many pins went with it. AN404, MP404.
-- Audited `map.delete`.
CREATE FUNCTION map_delete(target_event uuid, target_map uuid, request uuid) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev   event := map_event_for_write(target_event);
  lost integer;
BEGIN
  SELECT count(*)::integer INTO lost FROM map_pin p WHERE p.map_id = target_map AND p.event_id = ev.id;
  DELETE FROM event_map m WHERE m.id = target_map AND m.event_id = ev.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such map in this event' USING ERRCODE = 'MP404';
  END IF;
  UPDATE event_map m SET position = r.slot
  FROM (SELECT x.id, (row_number() OVER (ORDER BY x.position, x.created_at, x.id))::integer AS slot
        FROM event_map x WHERE x.event_id = ev.id) r
  WHERE m.id = r.id AND m.position <> r.slot;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after, request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'map.delete', 'event_map', target_map::text,
          jsonb_build_object('pins', lost), request);
  RETURN lost;
END $$;
REVOKE ALL ON FUNCTION map_delete(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION map_delete(uuid, uuid, uuid) TO questify_app;

-- Sets the order of the event's maps: `ids` must list every map of the event once (PS422 `order` otherwise). Audited
-- `map.order`.
CREATE FUNCTION map_order(target_event uuid, ids uuid[], request uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := map_event_for_write(target_event);
BEGIN
  IF ids IS NULL
     OR cardinality(ids) <> (SELECT count(*) FROM event_map m WHERE m.event_id = ev.id)
     OR cardinality(ids) <> (SELECT count(DISTINCT i) FROM unnest(ids) AS i)
     OR EXISTS (SELECT 1 FROM unnest(ids) AS i WHERE NOT EXISTS (SELECT 1 FROM event_map m WHERE m.id = i AND m.event_id = ev.id))
  THEN
    RAISE EXCEPTION 'list every map once' USING ERRCODE = 'PS422', DETAIL = 'order';
  END IF;
  UPDATE event_map m SET position = o.slot::integer, updated_at = now()
  FROM unnest(ids) WITH ORDINALITY AS o(id, slot)
  WHERE m.id = o.id AND m.event_id = ev.id AND m.position <> o.slot;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after, request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'map.order', 'event', ev.id::text,
          jsonb_build_object('count', cardinality(ids)), request);
  RETURN coalesce((SELECT jsonb_agg(map_team_item(m) ORDER BY m.position, m.created_at, m.id)
                   FROM event_map m WHERE m.event_id = ev.id), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION map_order(uuid, uuid[], uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION map_order(uuid, uuid[], uuid) TO questify_app;

-- The pin fields of a draft, checked: the kind with the fields it needs and none it must not have (PS422 with the
-- field's name), the place as thousandths 0 to 1000, and a quest pin's quest being one of this event (PS422 `questId`)
-- that has no pin yet (MP409 `quest_pinned`; `except_pin` is the pin being edited). Answers the row to write.
CREATE FUNCTION map_pin_draft(ev event, target_map uuid, draft jsonb, except_pin uuid) RETURNS map_pin
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  row_out map_pin;
  quest   uuid;
BEGIN
  IF jsonb_typeof(draft) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'check the pin' USING ERRCODE = 'PS422', DETAIL = 'pin';
  END IF;
  row_out.organizer_id := ev.organizer_id;
  row_out.event_id := ev.id;
  row_out.map_id := target_map;
  row_out.kind := CASE WHEN jsonb_typeof(draft -> 'kind') = 'string' THEN draft ->> 'kind' END;
  IF row_out.kind IS NULL OR row_out.kind NOT IN ('section', 'booth', 'quest', 'amenity') THEN
    RAISE EXCEPTION 'check the pin''s kind' USING ERRCODE = 'PS422', DETAIL = 'kind';
  END IF;
  row_out.x := session_int(draft, 'x', 0, 1000);
  row_out.y := session_int(draft, 'y', 0, 1000);
  IF row_out.x IS NULL OR row_out.y IS NULL THEN
    RAISE EXCEPTION 'place the pin on the map' USING ERRCODE = 'PS422', DETAIL = 'place';
  END IF;
  IF row_out.kind = 'quest' THEN
    quest := CASE WHEN jsonb_typeof(draft -> 'questId') = 'string' AND draft ->> 'questId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                  THEN (draft ->> 'questId')::uuid END;
    IF quest IS NULL OR NOT EXISTS (SELECT 1 FROM quest q WHERE q.id = quest AND q.event_id = ev.id) THEN
      RAISE EXCEPTION 'choose a quest of this event' USING ERRCODE = 'PS422', DETAIL = 'questId';
    ELSIF EXISTS (SELECT 1 FROM map_pin p WHERE p.quest_id = quest AND p.id IS DISTINCT FROM except_pin) THEN
      RAISE EXCEPTION 'this quest already has a pin' USING ERRCODE = 'MP409', DETAIL = 'quest_pinned';
    END IF;
    row_out.quest_id := quest;
    RETURN row_out;
  END IF;
  row_out.name_ar := session_text(draft, 'nameAr', 60, false);
  row_out.name_en := session_text(draft, 'nameEn', 60, false);
  row_out.details_ar := session_text(draft, 'detailsAr', 500, true);
  row_out.details_en := session_text(draft, 'detailsEn', 500, true);
  IF row_out.kind = 'amenity' THEN
    row_out.amenity := CASE WHEN jsonb_typeof(draft -> 'amenity') = 'string' THEN draft ->> 'amenity' END;
    IF row_out.amenity IS NULL OR row_out.amenity NOT IN ('prayer', 'toilets', 'food', 'info', 'first_aid') THEN
      RAISE EXCEPTION 'choose the amenity' USING ERRCODE = 'PS422', DETAIL = 'amenity';
    END IF;
  ELSIF row_out.name_ar IS NULL AND row_out.name_en IS NULL THEN
    RAISE EXCEPTION 'a pin needs a name' USING ERRCODE = 'PS422', DETAIL = 'name';
  END IF;
  RETURN row_out;
END $$;
REVOKE ALL ON FUNCTION map_pin_draft(event, uuid, jsonb, uuid) FROM PUBLIC;

-- Places a pin (`target_pin` NULL) or replaces one: the draft is the whole pin (kind, amenity, nameAr, nameEn, detailsAr,
-- detailsEn, x, y, questId). Answers the pin's map. AN404, MP404 (no such map or pin in the event), PS422 (a field),
-- MP409 (`event_closed`, `pin_limit`: 300 pins on a map, `quest_pinned`). Audited `map.pin_save`.
CREATE FUNCTION map_pin_save(target_event uuid, target_map uuid, draft jsonb, target_pin uuid, request uuid)
  RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev      event := map_event_for_write(target_event);
  holder  event_map;
  pin     map_pin;
  made    uuid;
BEGIN
  SELECT m.* INTO holder FROM event_map m WHERE m.id = target_map AND m.event_id = ev.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such map in this event' USING ERRCODE = 'MP404';
  END IF;
  pin := map_pin_draft(ev, holder.id, draft, target_pin);
  IF target_pin IS NULL THEN
    IF (SELECT count(*) FROM map_pin p WHERE p.map_id = holder.id) >= 300 THEN
      RAISE EXCEPTION 'a map holds 300 pins at most' USING ERRCODE = 'MP409', DETAIL = 'pin_limit';
    END IF;
    INSERT INTO map_pin (organizer_id, event_id, map_id, kind, amenity, name_ar, name_en, details_ar, details_en, x, y,
                         quest_id, created_by)
    VALUES (pin.organizer_id, pin.event_id, pin.map_id, pin.kind, pin.amenity, pin.name_ar, pin.name_en, pin.details_ar,
            pin.details_en, pin.x, pin.y, pin.quest_id, app_staff_user_id())
    RETURNING id INTO made;
  ELSE
    UPDATE map_pin p SET kind = pin.kind, amenity = pin.amenity, name_ar = pin.name_ar, name_en = pin.name_en,
                         details_ar = pin.details_ar, details_en = pin.details_en, x = pin.x, y = pin.y,
                         quest_id = pin.quest_id, updated_at = now()
    WHERE p.id = target_pin AND p.map_id = holder.id RETURNING p.id INTO made;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'no such pin on this map' USING ERRCODE = 'MP404';
    END IF;
  END IF;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after, request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'map.pin_save', 'map_pin', made::text,
          jsonb_build_object('created', target_pin IS NULL, 'kind', pin.kind, 'map', holder.id), request);
  RETURN map_team_item(holder);
END $$;
REVOKE ALL ON FUNCTION map_pin_save(uuid, uuid, jsonb, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION map_pin_save(uuid, uuid, jsonb, uuid, uuid) TO questify_app;

-- Removes a pin and answers its map. AN404, MP404. Audited `map.pin_delete`.
CREATE FUNCTION map_pin_delete(target_event uuid, target_map uuid, target_pin uuid, request uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev     event := map_event_for_write(target_event);
  holder event_map;
BEGIN
  SELECT m.* INTO holder FROM event_map m WHERE m.id = target_map AND m.event_id = ev.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such map in this event' USING ERRCODE = 'MP404';
  END IF;
  DELETE FROM map_pin p WHERE p.id = target_pin AND p.map_id = holder.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such pin on this map' USING ERRCODE = 'MP404';
  END IF;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after, request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'map.pin_delete', 'map_pin', target_pin::text,
          jsonb_build_object('map', holder.id), request);
  RETURN map_team_item(holder);
END $$;
REVOKE ALL ON FUNCTION map_pin_delete(uuid, uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION map_pin_delete(uuid, uuid, uuid, uuid) TO questify_app;

-- ================================================================ the player's door (ADR-374 (4))
-- The event's maps for an active member, in order, each with its pins. A quest pin is listed only while the member may
-- list its quest (`map_pin_shown`) and carries only the quest's id: the API adds the title, points and the member's state
-- from the same quest read the Quests tab uses. `here` is the pin of the quest the member last completed at a station (a
-- scanned QR code, an operator's scan of their My QR, an NFC tap or a location check-in) and when; null when that last
-- scan has no pin or the member has scanned nothing. It is the caller's own record and nothing of anyone else's. AM403
-- for anyone who is not an active member of a non-archived event.
CREATE FUNCTION member_maps(target_event uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  member     enrollment := session_member(target_event);
  last_quest uuid;
  last_at    timestamptz;
BEGIN
  SELECT c.quest_id, c.created_at INTO last_quest, last_at
  FROM quest_completion c
  WHERE c.enrollment_id = member.id AND c.method IN ('qr', 'my_qr', 'nfc', 'location')
  ORDER BY c.created_at DESC, c.id DESC
  LIMIT 1;
  RETURN jsonb_build_object(
    'maps', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', m.id,
               'name', jsonb_build_object('ar', coalesce(m.name_ar, m.name_en), 'en', coalesce(m.name_en, m.name_ar)),
               'pins', coalesce((
                 SELECT jsonb_agg(jsonb_build_object(
                          'id', p.id, 'kind', p.kind, 'amenity', p.amenity, 'x', p.x, 'y', p.y, 'questId', p.quest_id,
                          'name', CASE WHEN p.name_ar IS NULL AND p.name_en IS NULL THEN NULL
                                       ELSE jsonb_build_object('ar', coalesce(p.name_ar, p.name_en),
                                                               'en', coalesce(p.name_en, p.name_ar)) END,
                          'details', CASE WHEN p.details_ar IS NULL AND p.details_en IS NULL THEN NULL
                                          ELSE jsonb_build_object('ar', coalesce(p.details_ar, p.details_en),
                                                                  'en', coalesce(p.details_en, p.details_ar)) END)
                        ORDER BY p.created_at, p.id)
                 FROM map_pin p WHERE p.map_id = m.id AND map_pin_shown(p, member.id)), '[]'::jsonb))
             ORDER BY m.position, m.created_at, m.id)
      FROM event_map m WHERE m.event_id = target_event), '[]'::jsonb),
    'here', (SELECT jsonb_build_object('pinId', p.id, 'at', last_at)
             FROM map_pin p
             WHERE last_quest IS NOT NULL AND p.quest_id = last_quest AND map_pin_shown(p, member.id)));
END $$;
REVOKE ALL ON FUNCTION member_maps(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION member_maps(uuid) TO questify_app;
