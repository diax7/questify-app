-- Photo storage, phase 2 part A: organizer images (T-602b, T-610b, T-613b, T-506b, T-507b, T-305b, vote option images;
-- plan docs/plans/2026-11-12-organizer-images.md sections 2 and 3, ADR-829).
-- An owner or editor uploads an image of one kind (logo, icon, banner, picture, map) for one event; the bucket's key is
-- built by the database from the row's own tenant, event, kind and id, as for player photos (0192). Holders name an image
-- by id only: the map and sponsor columns with a composite foreign key to `media_object (id, event_id)`, so an image of
-- another event can never be named there; the JSON holders (branding, layout, game art, vote options) through
-- `media_images_use`, which every save calls inside its own transaction and which refuses an id that is not a stored image
-- of this event and kind (MI422, DETAIL the field). An image nothing names for 24 hours is deleted by
-- `media_sweep_images` (its key queued by 0192's delete trigger).
-- Deny by default: no table grant; every function is closed to PUBLIC and only the doors are granted to the API role.
--
-- Lock order: a save takes its holder's own lock (the event row for the JSON holders, the map or sponsor advisory lock),
-- then `media_object` rows (media_images_use's UPDATE), then writes the holder; `media_delete` last (the delete trigger).
-- The sweep takes `media_object` rows FOR UPDATE SKIP LOCKED and never waits, so a save in flight keeps its image, and a
-- save that waits on a row the sweep deleted is refused with MI422 instead of naming a missing image.
SET LOCAL lock_timeout = '10s';
LOCK TABLE media_object IN ACCESS EXCLUSIVE MODE;
LOCK TABLE event_map IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE sponsor IN SHARE ROW EXCLUSIVE MODE;

-- ================================================================ the objects (ADR-829 (1))
ALTER TABLE media_object DROP CONSTRAINT media_object_purpose_check;
ALTER TABLE media_object ADD CONSTRAINT media_object_purpose_check
  CHECK (purpose IN ('submission', 'ticket', 'logo', 'icon', 'banner', 'picture', 'map'));
-- Logos and icons keep their transparency as PNG; every other kind is a JPEG.
ALTER TABLE media_object ADD COLUMN format text NOT NULL DEFAULT 'jpeg' CHECK (format IN ('jpeg', 'png'));
ALTER TABLE media_object ADD CONSTRAINT media_object_format_kind
  CHECK ((format = 'png') = (purpose IN ('logo', 'icon')));
ALTER TABLE media_object DROP CONSTRAINT media_object_key_prefix;
ALTER TABLE media_object ADD CONSTRAINT media_object_key_prefix
  CHECK (key = 'o/' || organizer_id || '/e/' || event_id || '/' || purpose || '/' || id
               || CASE WHEN format = 'png' THEN '.png' ELSE '.jpg' END);
ALTER TABLE media_object ALTER COLUMN uploaded_by_player DROP NOT NULL;
-- The staff member who uploaded an organizer image; kept as null when that account is deleted, so the image stays.
ALTER TABLE media_object ADD COLUMN uploaded_by_staff uuid REFERENCES staff_user (id) ON DELETE SET NULL;
-- When a save last named the image (media_images_use) or the sweep last found it named; null before its first use.
ALTER TABLE media_object ADD COLUMN used_at timestamptz;
ALTER TABLE media_object ADD CONSTRAINT media_object_uploader
  CHECK ((purpose IN ('submission', 'ticket')) = (uploaded_by_player IS NOT NULL)
         AND (uploaded_by_player IS NULL OR uploaded_by_staff IS NULL));
ALTER TABLE media_object ADD CONSTRAINT media_object_id_event UNIQUE (id, event_id);
CREATE UNIQUE INDEX media_object_staff_key ON media_object (uploaded_by_staff, request_key)
  WHERE uploaded_by_staff IS NOT NULL;
CREATE INDEX media_object_image_idx ON media_object (event_id, created_at)
  WHERE purpose NOT IN ('submission', 'ticket');
CREATE INDEX media_object_staff_recent ON media_object (uploaded_by_staff, created_at)
  WHERE uploaded_by_staff IS NOT NULL;

-- ================================================================ the holders with a column (T-506b, T-507b)
-- The map's picture and the sponsor's logo and banner: an image of the holder's own event (the composite key), set to
-- null when the image row goes (the 365-day purge, the event's deletion).
ALTER TABLE event_map ADD COLUMN image uuid;
ALTER TABLE event_map ADD CONSTRAINT event_map_image_fk
  FOREIGN KEY (image, event_id) REFERENCES media_object (id, event_id) ON DELETE SET NULL (image);
CREATE INDEX event_map_image ON event_map (image) WHERE image IS NOT NULL;
ALTER TABLE sponsor ADD COLUMN logo uuid, ADD COLUMN banner uuid;
ALTER TABLE sponsor ADD CONSTRAINT sponsor_logo_fk
  FOREIGN KEY (logo, event_id) REFERENCES media_object (id, event_id) ON DELETE SET NULL (logo);
ALTER TABLE sponsor ADD CONSTRAINT sponsor_banner_fk
  FOREIGN KEY (banner, event_id) REFERENCES media_object (id, event_id) ON DELETE SET NULL (banner);
CREATE INDEX sponsor_logo ON sponsor (logo) WHERE logo IS NOT NULL;
CREATE INDEX sponsor_banner ON sponsor (banner) WHERE banner IS NOT NULL;

-- ================================================================ game art and vote option images (T-305b, ADR-190)
-- `type_config.images` on a game quest: memory match card faces (1 to 10), the slide puzzle's picture, catch's falling
-- items (1 to 5); tap rush takes none. Each is an image id (a uuid); whether it is a stored image of this event is the
-- save's check (media_images_use), not this shape's.
CREATE FUNCTION quest_image_id(value jsonb) RETURNS boolean
  LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
BEGIN
  RETURN coalesce(jsonb_typeof(value) = 'string'
                  AND (value #>> '{}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$', false);
END $$;
REVOKE ALL ON FUNCTION quest_image_id(jsonb) FROM PUBLIC;

CREATE FUNCTION quest_image_list(value jsonb, most integer) RETURNS boolean
  LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'array' OR jsonb_array_length(value) NOT BETWEEN 1 AND most THEN
    RETURN false;
  END IF;
  RETURN NOT EXISTS (SELECT 1 FROM jsonb_array_elements(value) AS e(v) WHERE NOT quest_image_id(e.v));
END $$;
REVOKE ALL ON FUNCTION quest_image_list(jsonb, integer) FROM PUBLIC;

CREATE FUNCTION quest_images_ok(quest_type text, config jsonb) RETURNS boolean
  LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE
  images jsonb := CASE WHEN jsonb_typeof(config) = 'object' THEN config -> 'images' END;
BEGIN
  IF quest_type = 'vote' AND jsonb_typeof(config -> 'options') = 'array' AND EXISTS (
       SELECT 1 FROM jsonb_array_elements(config -> 'options') AS o(v)
       WHERE jsonb_typeof(o.v) = 'object' AND o.v ? 'image' AND NOT quest_image_id(o.v -> 'image')) THEN
    RETURN false;
  END IF;
  IF images IS NULL THEN
    RETURN true;
  END IF;
  IF quest_type <> 'game' OR jsonb_typeof(images) <> 'object' THEN
    RETURN false;
  END IF;
  RETURN CASE config ->> 'game'
    WHEN 'memory_match' THEN (SELECT array_agg(k) FROM jsonb_object_keys(images) k) = ARRAY['faces']
                             AND quest_image_list(images -> 'faces', 10)
    WHEN 'slide_puzzle' THEN (SELECT array_agg(k) FROM jsonb_object_keys(images) k) = ARRAY['picture']
                             AND quest_image_id(images -> 'picture')
    WHEN 'catch' THEN (SELECT array_agg(k) FROM jsonb_object_keys(images) k) = ARRAY['items']
                      AND quest_image_list(images -> 'items', 5)
    ELSE false END;
END $$;
REVOKE ALL ON FUNCTION quest_images_ok(text, jsonb) FROM PUBLIC;
ALTER TABLE quest ADD CONSTRAINT quest_images_shape CHECK (quest_images_ok(type, type_config));

-- ================================================================ helpers (internal: no grant)
CREATE FUNCTION media_image_kind(kind text) RETURNS boolean
  LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
BEGIN
  RETURN coalesce(kind IN ('logo', 'icon', 'banner', 'picture', 'map'), false);
END $$;
REVOKE ALL ON FUNCTION media_image_kind(text) FROM PUBLIC;

-- The calling staff member's id, or a refusal: the organizer image doors are the team's only.
CREATE FUNCTION media_staff() RETURNS uuid
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  me uuid := app_staff_user_id();
BEGIN
  IF me IS NULL OR app_player_id() IS NOT NULL OR app_device_id() IS NOT NULL THEN
    RAISE EXCEPTION 'the event''s team only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN me;
END $$;
REVOKE ALL ON FUNCTION media_staff() FROM PUBLIC;

-- Every image id the event names anywhere: each uuid-shaped string in its config, its quests' type_config and the bodies
-- of pending items of its open change sets, and the map and sponsor columns. Listing too much only keeps an image longer.
CREATE FUNCTION event_image_refs(target_event uuid) RETURNS uuid[]
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  shape constant text := '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
  found uuid[];
BEGIN
  SELECT coalesce(array_agg(DISTINCT r.id), '{}') INTO found FROM (
    SELECT lower(m[1])::uuid AS id FROM event e, regexp_matches(e.config::text, shape, 'g') AS m
    WHERE e.id = target_event
    UNION ALL
    SELECT lower(m[1])::uuid FROM quest q, regexp_matches(q.type_config::text, shape, 'g') AS m
    WHERE q.event_id = target_event
    UNION ALL
    SELECT lower(m[1])::uuid FROM change_set s JOIN change_set_item i ON i.change_set_id = s.id,
           regexp_matches(i.body::text, shape, 'g') AS m
    WHERE s.event_id = target_event AND s.status = 'open' AND i.status = 'pending'
    UNION ALL
    SELECT x.image FROM event_map x WHERE x.event_id = target_event AND x.image IS NOT NULL
    UNION ALL
    SELECT s.logo FROM sponsor s WHERE s.event_id = target_event AND s.logo IS NOT NULL
    UNION ALL
    SELECT s.banner FROM sponsor s WHERE s.event_id = target_event AND s.banner IS NOT NULL) AS r;
  RETURN found;
END $$;
REVOKE ALL ON FUNCTION event_image_refs(uuid) FROM PUBLIC;

-- A Home content block without its images: slides, cards and the featured item lose `image`; image parts of the page go.
CREATE FUNCTION media_strip_content(content jsonb) RETURNS jsonb
  LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE
  doc jsonb := content;
BEGIN
  IF jsonb_typeof(doc) IS DISTINCT FROM 'object' THEN
    RETURN content;
  END IF;
  IF jsonb_typeof(doc -> 'banner') = 'array' THEN
    doc := jsonb_set(doc, '{banner}', coalesce((
      SELECT jsonb_agg(CASE WHEN jsonb_typeof(b.v) = 'object' THEN b.v - 'image' ELSE b.v END ORDER BY b.i)
      FROM jsonb_array_elements(doc -> 'banner') WITH ORDINALITY AS b(v, i)), '[]'::jsonb));
  END IF;
  IF jsonb_typeof(doc -> 'cards') = 'array' THEN
    doc := jsonb_set(doc, '{cards}', coalesce((
      SELECT jsonb_agg(CASE WHEN jsonb_typeof(c.v) = 'object' THEN c.v - 'image' ELSE c.v END ORDER BY c.i)
      FROM jsonb_array_elements(doc -> 'cards') WITH ORDINALITY AS c(v, i)), '[]'::jsonb));
  END IF;
  IF jsonb_typeof(doc -> 'featured') = 'object' THEN
    doc := jsonb_set(doc, '{featured}', (doc -> 'featured') - 'image');
  END IF;
  IF jsonb_typeof(doc #> '{page,blocks}') = 'array' THEN
    doc := jsonb_set(doc, '{page,blocks}', coalesce((
      SELECT jsonb_agg(p.v ORDER BY p.i)
      FROM jsonb_array_elements(doc #> '{page,blocks}') WITH ORDINALITY AS p(v, i)
      WHERE NOT (jsonb_typeof(p.v) = 'object' AND p.v ->> 'kind' = 'image')), '[]'::jsonb));
  END IF;
  RETURN doc;
END $$;
REVOKE ALL ON FUNCTION media_strip_content(jsonb) FROM PUBLIC;

-- A duplicated event names none of its source's images (ADR-829 (4)): the branding, the layout and the quests lose their
-- image ids, so the copy shows the default art. The map and sponsor columns are never copied (0092's column lists).
CREATE FUNCTION media_refs_strip_event(target_event uuid) RETURNS void
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE event e
  SET config = CASE WHEN jsonb_typeof(e.config #> '{layout,content}') = 'object'
                    THEN jsonb_set(e.config #- '{branding,logo}' #- '{branding,banner}', '{layout,content}',
                                   media_strip_content(e.config #> '{layout,content}'))
                    ELSE e.config #- '{branding,logo}' #- '{branding,banner}' END
  WHERE e.id = target_event;
  UPDATE quest q SET type_config = q.type_config - 'images'
  WHERE q.event_id = target_event AND q.type_config ? 'images';
  UPDATE quest q
  SET type_config = jsonb_set(q.type_config, '{options}', (
        SELECT jsonb_agg(CASE WHEN jsonb_typeof(o.v) = 'object' THEN o.v - 'image' ELSE o.v END ORDER BY o.i)
        FROM jsonb_array_elements(q.type_config -> 'options') WITH ORDINALITY AS o(v, i)))
  WHERE q.event_id = target_event AND q.type = 'vote'
    AND jsonb_path_exists(q.type_config, '$.options[*] ? (exists(@.image))');
END $$;
REVOKE ALL ON FUNCTION media_refs_strip_event(uuid) FROM PUBLIC;

-- The caller's event for an image upload: AN404 when it is not theirs (award_event_of: the organizer, the event scope),
-- MI409 `event_closed` when it is archived or suspended.
CREATE FUNCTION media_image_event(target_event uuid) RETURNS event
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  IF ev.status = 'archived' OR event_suspended(ev.id) THEN
    RAISE EXCEPTION 'the event takes no images now' USING ERRCODE = 'MI409', DETAIL = 'event_closed';
  END IF;
  RETURN ev;
END $$;
REVOKE ALL ON FUNCTION media_image_event(uuid) FROM PUBLIC;

-- ================================================================ the upload doors (ADR-829 (2))
-- A slot for one organizer image of `image_kind` in the caller's event. The same key answers the same slot (a retry PUTs
-- the same object again, or finds it stored); a key used for another event or kind is QK422. A slot still reserved after
-- 20 minutes is given up and a fresh one handed out. Caps (MD429, DETAIL the seconds to wait): 30 uploads a staff member
-- in 10 minutes, and 200 images of the event that no save has named yet.
CREATE FUNCTION media_image_reserve(target_event uuid, image_kind text, request_key text)
  RETURNS TABLE (id uuid, key text, stored boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  me      uuid := media_staff();
  ev      event;
  earlier media_object%ROWTYPE;
  made    media_object%ROWTYPE;
  oldest  timestamptz;
  new_id  uuid := gen_random_uuid();
  ext     text;
BEGIN
  IF NOT media_image_kind(image_kind) THEN
    RAISE EXCEPTION 'an image kind' USING ERRCODE = 'MD422';
  END IF;
  IF request_key IS NULL OR length(request_key) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'a usable idempotency key is required' USING ERRCODE = 'QK422';
  END IF;
  ev := media_image_event(target_event);
  PERFORM pg_advisory_xact_lock(hashtextextended('event-images:' || ev.id::text, 0));
  SELECT * INTO earlier FROM media_object m
  WHERE m.uploaded_by_staff = me AND m.request_key = media_image_reserve.request_key;
  IF FOUND THEN
    IF earlier.event_id <> ev.id OR earlier.purpose <> image_kind THEN
      RAISE EXCEPTION 'this key was used for another upload' USING ERRCODE = 'QK422';
    END IF;
    IF earlier.state <> 'reserved' OR earlier.created_at > now() - interval '20 minutes' THEN
      RETURN QUERY SELECT earlier.id, earlier.key, earlier.state <> 'reserved';
      RETURN;
    END IF;
    DELETE FROM media_object m WHERE m.id = earlier.id;
  END IF;
  SELECT m.created_at INTO oldest FROM media_object m
  WHERE m.uploaded_by_staff = me AND m.created_at > now() - interval '10 minutes'
  ORDER BY m.created_at DESC OFFSET 29 LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'thirty images in ten minutes' USING ERRCODE = 'MD429',
      DETAIL = greatest(1, ceil(extract(epoch FROM oldest + interval '10 minutes' - now())))::bigint::text;
  END IF;
  IF (SELECT count(*) FROM media_object m
      WHERE m.event_id = ev.id AND m.purpose NOT IN ('submission', 'ticket') AND m.used_at IS NULL) >= 200 THEN
    RAISE EXCEPTION 'two hundred images wait to be used' USING ERRCODE = 'MD429', DETAIL = '3600';
  END IF;
  ext := CASE WHEN image_kind IN ('logo', 'icon') THEN '.png' ELSE '.jpg' END;
  INSERT INTO media_object (id, organizer_id, event_id, purpose, format, key, uploaded_by_staff, request_key)
  VALUES (new_id, ev.organizer_id, ev.id, image_kind,
          CASE WHEN ext = '.png' THEN 'png' ELSE 'jpeg' END,
          'o/' || ev.organizer_id || '/e/' || ev.id || '/' || image_kind || '/' || new_id || ext,
          me, media_image_reserve.request_key)
  RETURNING * INTO made;
  RETURN QUERY SELECT made.id, made.key, false;
END $$;
REVOKE ALL ON FUNCTION media_image_reserve(uuid, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION media_image_reserve(uuid, text, text) TO questify_app;

-- The caller's slot now holds its re-encoded image. True when stored (or stored already); false when the slot is gone
-- (swept after 30 minutes while the upload ran): the object just written is then queued for deletion by the key the API
-- was given, which must be this slot's organizer-image key shape, so nothing else can be queued.
CREATE FUNCTION media_image_stored(target uuid, object_key text, size integer, w integer, h integer) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me   uuid := media_staff();
  slot media_object%ROWTYPE;
BEGIN
  SELECT * INTO slot FROM media_object m WHERE m.id = target FOR UPDATE;
  IF FOUND THEN
    IF slot.uploaded_by_staff IS DISTINCT FROM me OR slot.key <> object_key THEN
      RAISE EXCEPTION 'not this staff member''s upload' USING ERRCODE = 'SM404';
    END IF;
    IF slot.state = 'reserved' THEN
      UPDATE media_object m SET state = 'stored', bytes = size, width = w, height = h, stored_at = now()
      WHERE m.id = target;
    END IF;
    RETURN true;
  END IF;
  IF object_key !~ ('^o/[0-9a-f-]{36}/e/[0-9a-f-]{36}/(logo|icon|banner|picture|map)/' || target || '\.(jpg|png)$') THEN
    RAISE EXCEPTION 'not an upload key' USING ERRCODE = 'MD422';
  END IF;
  INSERT INTO media_delete (key, organizer_id)
  VALUES (object_key, substr(object_key, 3, 36)::uuid)
  ON CONFLICT (key) DO UPDATE SET due_at = now(), lease_until = NULL, claim = NULL;
  RETURN false;
END $$;
REVOKE ALL ON FUNCTION media_image_stored(uuid, text, integer, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION media_image_stored(uuid, text, integer, integer, integer) TO questify_app;

-- Gives back the caller's own slot that no save has named (the image was refused as 415 or 422).
CREATE FUNCTION media_image_release(target uuid) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me uuid := media_staff();
BEGIN
  DELETE FROM media_object m
  WHERE m.id = target AND m.uploaded_by_staff = me AND m.used_at IS NULL AND m.state <> 'attached';
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION media_image_release(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION media_image_release(uuid) TO questify_app;

-- ================================================================ naming an image (ADR-829 (3))
-- A save names these images: each must be a stored organizer image of the caller's event, of the kind its field takes
-- (`kinds[i]` for `ids[i]`), else MI422 with the field (`fields[i]`) as the detail. Marks them used now. The UPDATE locks
-- each row, so a sweep running now skips it (SKIP LOCKED), and a save that waits on a row the sweep is deleting finds it
-- gone and is refused. Called inside the save's own transaction; null or empty lists name nothing.
CREATE FUNCTION media_images_use(target_event uuid, ids uuid[], kinds text[], fields text[]) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev      event := award_event_of(target_event);
  missing text;
  marked  text[];
BEGIN
  IF coalesce(cardinality(ids), 0) = 0 THEN
    RETURN;
  END IF;
  IF cardinality(ids) <> coalesce(cardinality(kinds), 0) OR cardinality(ids) <> coalesce(cardinality(fields), 0)
     OR cardinality(ids) > 100 THEN
    RAISE EXCEPTION 'one kind and one field for each image' USING ERRCODE = 'MD422';
  END IF;
  WITH touched AS (
    UPDATE media_object m SET used_at = now()
    WHERE m.id IN (SELECT w.id FROM unnest(ids, kinds) AS w(id, kind)
                   WHERE w.id IS NOT NULL)
      AND m.event_id = ev.id AND m.state = 'stored' AND media_image_kind(m.purpose)
    RETURNING m.id, m.purpose)
  SELECT array_agg(t.id || ':' || t.purpose) INTO marked FROM touched t;
  SELECT w.field INTO missing FROM unnest(ids, kinds, fields) WITH ORDINALITY AS w(id, kind, field, n)
  WHERE w.id IS NULL OR NOT ((w.id || ':' || w.kind) = ANY (coalesce(marked, '{}')))
  ORDER BY w.n LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'no such image of this event' USING ERRCODE = 'MI422', DETAIL = coalesce(missing, 'image');
  END IF;
END $$;
REVOKE ALL ON FUNCTION media_images_use(uuid, uuid[], text[], text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION media_images_use(uuid, uuid[], text[], text[]) TO questify_app;

-- ================================================================ the read doors (ADR-829 (2))
-- The key of an organizer image for an active member of its event (session_member: an active player and enrollment, an
-- event that is not archived, never a device), while the event is not suspended. NULL for anything else: another event's
-- image, a player photo, a slot not stored. The API answers every refusal as one 404.
CREATE FUNCTION event_image_key(target_event uuid, target uuid) RETURNS text
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  member enrollment := session_member(target_event);
  found  text;
BEGIN
  IF event_suspended(member.event_id) THEN
    RETURN NULL;
  END IF;
  SELECT m.key INTO found FROM media_object m
  WHERE m.id = target AND m.event_id = member.event_id AND media_image_kind(m.purpose) AND m.state = 'stored';
  RETURN found;
END $$;
REVOKE ALL ON FUNCTION event_image_key(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION event_image_key(uuid, uuid) TO questify_app;

-- The same key for the event's owners and editors inside their event limit (award_event_of), for the dashboard's previews.
CREATE FUNCTION team_image_key(target_event uuid, target uuid) RETURNS text
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev    event := award_event_of(target_event);
  found text;
BEGIN
  SELECT m.key INTO found FROM media_object m
  WHERE m.id = target AND m.event_id = ev.id AND media_image_kind(m.purpose) AND m.state = 'stored';
  RETURN found;
END $$;
REVOKE ALL ON FUNCTION team_image_key(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION team_image_key(uuid, uuid) TO questify_app;

-- ================================================================ the player doors, now IS DISTINCT FROM
-- As 0192, with one change: an organizer image's row has no player, and `<>` with a null reads as not refused.
CREATE OR REPLACE FUNCTION media_stored(target uuid, object_key text, size integer, w integer, h integer) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me   uuid := app_player_id();
  slot media_object%ROWTYPE;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO slot FROM media_object m WHERE m.id = target FOR UPDATE;
  IF FOUND THEN
    IF slot.uploaded_by_player IS DISTINCT FROM me OR slot.key <> object_key THEN
      RAISE EXCEPTION 'not this player''s upload' USING ERRCODE = 'SM404';
    END IF;
    IF slot.state = 'reserved' THEN
      UPDATE media_object m SET state = 'stored', bytes = size, width = w, height = h, stored_at = now()
      WHERE m.id = target;
    END IF;
    RETURN true;
  END IF;
  IF object_key !~ ('^o/[0-9a-f-]{36}/e/[0-9a-f-]{36}/(submission|ticket)/' || target || '\.jpg$') THEN
    RAISE EXCEPTION 'not an upload key' USING ERRCODE = 'MD422';
  END IF;
  INSERT INTO media_delete (key, organizer_id)
  VALUES (object_key, substr(object_key, 3, 36)::uuid)
  ON CONFLICT (key) DO UPDATE SET due_at = now(), lease_until = NULL, claim = NULL;
  RETURN false;
END $$;

-- As 0193, with the same change.
CREATE OR REPLACE FUNCTION photo_to_attach(target uuid, me uuid, target_event uuid, wanted_purpose text)
  RETURNS media_object
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  pic media_object%ROWTYPE;
BEGIN
  SELECT * INTO pic FROM media_object m WHERE m.id = target FOR UPDATE;
  IF NOT FOUND OR pic.uploaded_by_player IS DISTINCT FROM me OR pic.event_id <> target_event
     OR pic.purpose <> wanted_purpose OR pic.state <> 'stored' OR pic.created_at <= now() - interval '30 minutes' THEN
    RAISE EXCEPTION 'no such photo' USING ERRCODE = 'SM404';
  END IF;
  UPDATE media_object m SET state = 'attached', attached_at = now() WHERE m.id = target;
  RETURN pic;
END $$;

-- ================================================================ the sweeps (the system seat only)
-- As 0192, with one change: player uploads only (submission and ticket). Organizer images have their own sweep.
CREATE OR REPLACE FUNCTION media_sweep_uploads() RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  gone integer;
BEGIN
  PERFORM media_system();
  DELETE FROM media_object m WHERE m.id IN (
    SELECT o.id FROM media_object o
    WHERE o.state <> 'attached' AND o.purpose IN ('submission', 'ticket')
      AND o.created_at < now() - interval '30 minutes'
    ORDER BY o.created_at LIMIT 500
    FOR UPDATE SKIP LOCKED);
  GET DIAGNOSTICS gone = ROW_COUNT;
  RETURN gone;
END $$;

-- Organizer images: a slot never stored within 30 minutes goes; a stored image last named (or stored) more than 24 hours
-- ago goes when its event names it nowhere (event_image_refs), and is marked used now when it is still named, so it is
-- looked at again a day later. Rows are taken FOR UPDATE SKIP LOCKED: a save naming one now keeps it. At most `batch`
-- images a call, from at most 50 events.
CREATE FUNCTION media_sweep_images(batch integer) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  most   integer := least(greatest(coalesce(batch, 500), 1), 1000);
  gone   integer;
  more   integer;
  ev     uuid;
  named  uuid[];
  due    uuid[];
BEGIN
  PERFORM media_system();
  DELETE FROM media_object m WHERE m.id IN (
    SELECT o.id FROM media_object o
    WHERE o.purpose NOT IN ('submission', 'ticket') AND o.state = 'reserved'
      AND o.created_at < now() - interval '30 minutes'
    ORDER BY o.created_at LIMIT most
    FOR UPDATE SKIP LOCKED);
  GET DIAGNOSTICS gone = ROW_COUNT;
  FOR ev IN
    SELECT o.event_id FROM media_object o
    WHERE o.purpose NOT IN ('submission', 'ticket') AND o.state = 'stored'
      AND coalesce(o.used_at, o.stored_at) < now() - interval '24 hours'
    GROUP BY o.event_id ORDER BY min(coalesce(o.used_at, o.stored_at)) LIMIT 50
  LOOP
    EXIT WHEN gone >= most;
    named := event_image_refs(ev);
    due := ARRAY(
      SELECT o.id FROM media_object o
      WHERE o.event_id = ev AND o.purpose NOT IN ('submission', 'ticket') AND o.state = 'stored'
        AND coalesce(o.used_at, o.stored_at) < now() - interval '24 hours'
      ORDER BY o.id LIMIT most - gone
      FOR UPDATE SKIP LOCKED);
    UPDATE media_object m SET used_at = now() WHERE m.id = ANY (due) AND m.id = ANY (named);
    DELETE FROM media_object m WHERE m.id = ANY (due) AND NOT (m.id = ANY (named));
    GET DIAGNOSTICS more = ROW_COUNT;
    gone := gone + more;
  END LOOP;
  RETURN gone;
END $$;
REVOKE ALL ON FUNCTION media_sweep_images(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION media_sweep_images(integer) TO questify_app;

-- ================================================================ maps (T-506b)
-- As 0087, with the picture: `{id, width, height}` or null.
CREATE FUNCTION map_image_view(target uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  found jsonb;
BEGIN
  IF target IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT jsonb_build_object('id', m.id, 'width', m.width, 'height', m.height) INTO found
  FROM media_object m WHERE m.id = target AND m.state = 'stored';
  RETURN found;
END $$;
REVOKE ALL ON FUNCTION map_image_view(uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION map_team_item(m event_map) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', m.id, 'nameAr', m.name_ar, 'nameEn', m.name_en, 'position', m.position, 'image', map_image_view(m.image),
    'pins', coalesce((SELECT jsonb_agg(jsonb_build_object(
                'id', p.id, 'kind', p.kind, 'amenity', p.amenity, 'nameAr', p.name_ar, 'nameEn', p.name_en,
                'detailsAr', p.details_ar, 'detailsEn', p.details_en, 'x', p.x, 'y', p.y, 'questId', p.quest_id)
              ORDER BY p.created_at, p.id)
              FROM map_pin p WHERE p.map_id = m.id), '[]'::jsonb))
$$;

-- An image field of a draft: absent keeps `current`, null clears it, an image id sets it (PS422 with the field name for
-- anything else). Internal.
CREATE FUNCTION media_draft_image(draft jsonb, field text, current uuid) RETURNS uuid
  LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT draft ? field THEN
    RETURN current;
  END IF;
  IF jsonb_typeof(draft -> field) = 'null' THEN
    RETURN NULL;
  END IF;
  IF quest_image_id(to_jsonb(lower(draft ->> field))) AND jsonb_typeof(draft -> field) = 'string' THEN
    RETURN lower(draft ->> field)::uuid;
  END IF;
  RAISE EXCEPTION 'check the image' USING ERRCODE = 'PS422', DETAIL = field;
END $$;
REVOKE ALL ON FUNCTION media_draft_image(jsonb, text, uuid) FROM PUBLIC;

-- As 0087, with `image`: absent keeps the picture, null removes it, an id sets it to a stored map image of this event
-- (MI422 `image` otherwise; media_images_use, before the row is written).
CREATE OR REPLACE FUNCTION map_save(target_event uuid, draft jsonb, target_map uuid, request uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev    event := map_event_for_write(target_event);
  n_ar  text;
  n_en  text;
  pic   uuid;
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
  IF target_map IS NOT NULL THEN
    SELECT m.image INTO pic FROM event_map m WHERE m.id = target_map AND m.event_id = ev.id;
  END IF;
  pic := media_draft_image(draft, 'image', pic);
  IF pic IS NOT NULL THEN
    PERFORM media_images_use(ev.id, ARRAY[pic], ARRAY['map'], ARRAY['image']);
  END IF;
  IF target_map IS NULL THEN
    IF (SELECT count(*) FROM event_map m WHERE m.event_id = ev.id) >= 50 THEN
      RAISE EXCEPTION 'an event holds 50 maps at most' USING ERRCODE = 'MP409', DETAIL = 'limit';
    END IF;
    INSERT INTO event_map (organizer_id, event_id, name_ar, name_en, position, created_by, image)
    VALUES (ev.organizer_id, ev.id, n_ar, n_en,
            (SELECT count(*)::integer + 1 FROM event_map m WHERE m.event_id = ev.id), app_staff_user_id(), pic)
    RETURNING * INTO item;
  ELSE
    UPDATE event_map m SET name_ar = n_ar, name_en = n_en, image = pic, updated_at = now()
    WHERE m.id = target_map AND m.event_id = ev.id RETURNING m.* INTO item;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'no such map in this event' USING ERRCODE = 'MP404';
    END IF;
  END IF;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after, request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'map.save', 'event_map', item.id::text,
          jsonb_build_object('created', target_map IS NULL, 'image', item.image), request);
  RETURN map_team_item(item);
END $$;

-- As 0087, with each map's picture `{id, width, height}` (null when it has none).
CREATE OR REPLACE FUNCTION member_maps(target_event uuid) RETURNS jsonb
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
               'image', map_image_view(m.image),
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

-- ================================================================ sponsors (T-507b)
-- As 0088, with the logo and the banner ids (null when there are none).
CREATE OR REPLACE FUNCTION sponsor_team_item(s sponsor) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'id', s.id, 'nameAr', s.name_ar, 'nameEn', s.name_en, 'tier', s.tier, 'booth', s.booth,
    'logo', s.logo, 'banner', s.banner,
    'tags', coalesce((SELECT jsonb_agg(jsonb_build_object('kind', t.kind, 'targetId', sponsor_tag_target(t))
                                       ORDER BY t.created_at, t.id)
                      FROM sponsor_tag t
                      WHERE t.sponsor_id = s.id
                        AND (t.kind <> 'reward'
                             OR EXISTS (SELECT 1 FROM reward r WHERE r.id = t.reward_id AND r.status = 'active'))),
                     '[]'::jsonb))
$$;

-- As 0088, with `logo` and `banner`: absent keeps, null removes, an id sets a stored image of this event of that kind
-- (MI422 with the field otherwise).
CREATE OR REPLACE FUNCTION sponsor_save(target_event uuid, draft jsonb, target_sponsor uuid, request uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev      event := sponsor_event_for_write(target_event);
  n_ar    text;
  n_en    text;
  level   text;
  stand   text;
  mark    uuid;
  strip   uuid;
  item    sponsor;
BEGIN
  IF jsonb_typeof(draft) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'check the sponsor' USING ERRCODE = 'PS422', DETAIL = 'sponsor';
  END IF;
  n_ar := session_text(draft, 'nameAr', 60, false);
  n_en := session_text(draft, 'nameEn', 60, false);
  IF n_ar IS NULL AND n_en IS NULL THEN
    RAISE EXCEPTION 'a sponsor needs a name' USING ERRCODE = 'PS422', DETAIL = 'name';
  END IF;
  level := CASE WHEN jsonb_typeof(draft -> 'tier') = 'string' THEN draft ->> 'tier' END;
  IF level IS NULL OR sponsor_tier_rank(level) = 99 THEN
    RAISE EXCEPTION 'choose the sponsor''s tier' USING ERRCODE = 'PS422', DETAIL = 'tier';
  END IF;
  stand := session_text(draft, 'booth', 40, false);
  IF target_sponsor IS NOT NULL THEN
    SELECT s.logo, s.banner INTO mark, strip FROM sponsor s WHERE s.id = target_sponsor AND s.event_id = ev.id;
  END IF;
  mark := media_draft_image(draft, 'logo', mark);
  strip := media_draft_image(draft, 'banner', strip);
  IF mark IS NOT NULL THEN
    PERFORM media_images_use(ev.id, ARRAY[mark], ARRAY['logo'], ARRAY['logo']);
  END IF;
  IF strip IS NOT NULL THEN
    PERFORM media_images_use(ev.id, ARRAY[strip], ARRAY['banner'], ARRAY['banner']);
  END IF;
  IF target_sponsor IS NULL THEN
    IF (SELECT count(*) FROM sponsor s WHERE s.event_id = ev.id) >= 100 THEN
      RAISE EXCEPTION 'an event holds 100 sponsors at most' USING ERRCODE = 'SO409', DETAIL = 'limit';
    END IF;
    INSERT INTO sponsor (organizer_id, event_id, name_ar, name_en, tier, booth, created_by, logo, banner)
    VALUES (ev.organizer_id, ev.id, n_ar, n_en, level, stand, app_staff_user_id(), mark, strip)
    RETURNING * INTO item;
  ELSE
    UPDATE sponsor s SET name_ar = n_ar, name_en = n_en, tier = level, booth = stand, logo = mark, banner = strip,
                         updated_at = now()
    WHERE s.id = target_sponsor AND s.event_id = ev.id RETURNING s.* INTO item;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'no such sponsor in this event' USING ERRCODE = 'SO404';
    END IF;
  END IF;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after, request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'sponsor.save', 'sponsor', item.id::text,
          jsonb_build_object('created', target_sponsor IS NULL, 'tier', item.tier, 'logo', item.logo,
                             'banner', item.banner), request);
  RETURN sponsor_team_item(item);
END $$;

-- As 0088, with each sponsor's `logo` and `banner` ids (null when there are none).
CREATE OR REPLACE FUNCTION member_sponsors(target_event uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  member enrollment := session_member(target_event);
BEGIN
  RETURN jsonb_build_object(
    'sponsors', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', s.id,
               'name', jsonb_build_object('ar', coalesce(s.name_ar, s.name_en), 'en', coalesce(s.name_en, s.name_ar)),
               'tier', s.tier, 'booth', s.booth, 'logo', s.logo, 'banner', s.banner)
             ORDER BY sponsor_tier_rank(s.tier), s.created_at, s.id)
      FROM sponsor s WHERE s.event_id = target_event), '[]'::jsonb),
    'tags', coalesce((
      SELECT jsonb_agg(jsonb_build_object('kind', t.kind, 'targetId', sponsor_tag_target(t), 'sponsorId', t.sponsor_id)
                       ORDER BY t.created_at, t.id)
      FROM sponsor_tag t WHERE t.event_id = target_event AND sponsor_tag_shown(t, member.id)), '[]'::jsonb));
END $$;

-- As 0143, with the sponsor's logo and its event, so the owner's locker can draw the logo through that event's door.
CREATE OR REPLACE FUNCTION souvenir_presented_by(rule uuid) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'name', jsonb_build_object('ar', coalesce(s.name_ar, s.name_en), 'en', coalesce(s.name_en, s.name_ar)),
    'tier', s.tier, 'logo', s.logo, 'eventId', s.event_id)
  FROM sponsor_tag t JOIN sponsor s ON s.id = t.sponsor_id AND s.event_id = t.event_id
  WHERE t.souvenir_id = rule
$$;

-- ================================================================ game art and vote images for the player (T-305b)
-- The images of a game or vote quest the caller may play now (the vote door's own rule: an active member and player, the
-- quest visible and shown, its category seen, not locked by a community goal): `{images}` for a game, `{options: {id:
-- image}}` for a vote. NULL for anything else. The ids are read through the event's image door, never a key.
CREATE FUNCTION member_quest_images(target uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  quest_row quest%ROWTYPE;
BEGIN
  SELECT q.* INTO quest_row FROM quest q
  JOIN category c ON c.id = q.category_id
  JOIN enrollment n ON n.event_id = q.event_id AND n.player_id = app_player_id() AND n.status = 'active'
  JOIN player p ON p.id = n.player_id AND p.status = 'active'
  WHERE q.id = target AND q.type IN ('game', 'vote') AND q.visible AND sees_category(n.id, c)
    AND quest_community_lock(q) IS NULL AND flash_shown(q) AND app_device_id() IS NULL;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF quest_row.type = 'game' THEN
    RETURN jsonb_build_object('images', coalesce(quest_row.type_config -> 'images', '{}'::jsonb));
  END IF;
  RETURN jsonb_build_object('options', coalesce((
    SELECT jsonb_object_agg(o.v ->> 'id', o.v ->> 'image')
    FROM jsonb_array_elements(quest_row.type_config -> 'options') AS o(v)
    WHERE quest_image_id(o.v -> 'image')), '{}'::jsonb));
END $$;
REVOKE ALL ON FUNCTION member_quest_images(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION member_quest_images(uuid) TO questify_app;

-- ================================================================ duplicating an event (ADR-829 (4))
-- As 0160, with one change: the copy names none of the source's images (media_refs_strip_event, last).
CREATE OR REPLACE FUNCTION event_copy_setup(source_event uuid, target_event uuid, request uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  src    event := award_event_of(source_event);
  tgt    event := award_event_of(target_event);
  shift  interval;
  counts jsonb;
BEGIN
  IF current_setting('transaction_isolation') NOT IN ('repeatable read', 'serializable') THEN
    RAISE EXCEPTION 'an event is copied in one snapshot' USING ERRCODE = 'ED500', DETAIL = 'needs_repeatable_read';
  END IF;
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
  PERFORM event_copy_home_content(tgt.id);
  PERFORM media_refs_strip_event(tgt.id);
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after, request_id)
  VALUES ('staff', app_staff_user_id(), tgt.organizer_id, tgt.id, 'event.duplicate', 'event', tgt.id::text,
          jsonb_build_object('source', src.id) || counts, request);
  RETURN counts;
END $$;
