-- T-610 review fix: duplicating an event keeps the Home content pointing at the copies (FR-1016, FR-1828; follows 0092).
-- 0092 copies `event.config` verbatim, so a copy's Home content (config.layout.content) still named the SOURCE event's quest and
-- reward ids: a banner slide or quick link that opens a quest, and the featured card. Those ids belong to another event, so
-- the card drew nothing and a tap went nowhere. The copy now points them at the copied quests and rewards. Where the copy does
-- not exist (a removed reward is not copied, a stale or foreign id never was one of the source's) a quest action becomes
-- {"type": "none"} and the featured card becomes null. Content that is damaged in any other way is left as it is.
-- 0092 is deployed and untouched: `event_copy_setup` is restated with one added call, and three internal helpers are new.
-- Deny by default: the helpers are closed to PUBLIC and granted to nobody; the door keeps its one grant to the API role.

-- The id a source quest or reward has in the target event, or NULL when it holds no such copy. `ref_id` is text from
-- stored JSON, so it is checked before it is cast.
CREATE FUNCTION home_ref_copy(ref_kind text, ref_id text, in_event uuid) RETURNS uuid
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN ref_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    CASE ref_kind
      WHEN 'quest' THEN (SELECT q.id FROM quest q WHERE q.event_id = in_event AND q.id = copy_id(ref_id::uuid, in_event))
      WHEN 'reward' THEN (SELECT r.id FROM reward r WHERE r.event_id = in_event AND r.id = copy_id(ref_id::uuid, in_event))
    END
  END
$$;
REVOKE ALL ON FUNCTION home_ref_copy(text, text, uuid) FROM PUBLIC;

-- A list of banner slides or quick links with each quest action pointed at the copied quest, else turned into "none". An
-- action of another kind, an item that is not an object and a value that is not a list stay as they are.
CREATE FUNCTION home_items_copy(items jsonb, in_event uuid) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN jsonb_typeof(items) = 'array' THEN coalesce((
    SELECT jsonb_agg(
      CASE WHEN jsonb_typeof(i.item) = 'object' AND i.item #>> '{action,type}' = 'quest' THEN
        jsonb_set(i.item, '{action}',
          CASE WHEN c.copied IS NULL THEN '{"type": "none"}'::jsonb
               ELSE jsonb_build_object('type', 'quest', 'questId', c.copied) END)
      ELSE i.item END ORDER BY i.pos)
    FROM jsonb_array_elements(items) WITH ORDINALITY AS i(item, pos)
    CROSS JOIN LATERAL (SELECT home_ref_copy('quest', i.item #>> '{action,questId}', in_event) AS copied) c
  ), '[]'::jsonb) ELSE items END
$$;
REVOKE ALL ON FUNCTION home_items_copy(jsonb, uuid) FROM PUBLIC;

-- Points the target event's Home content at its own quests and rewards. Runs after the quests and rewards are copied.
CREATE FUNCTION event_copy_home_content(in_event uuid) RETURNS void
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  content  jsonb := (SELECT e.config #> '{layout,content}' FROM event e WHERE e.id = in_event);
  featured jsonb;
  copied   uuid;
BEGIN
  IF jsonb_typeof(content) IS DISTINCT FROM 'object' THEN
    RETURN;
  END IF;
  IF content ? 'banner' THEN
    content := jsonb_set(content, '{banner}', home_items_copy(content -> 'banner', in_event));
  END IF;
  IF content ? 'quickLinks' THEN
    content := jsonb_set(content, '{quickLinks}', home_items_copy(content -> 'quickLinks', in_event));
  END IF;
  featured := content -> 'featured';
  IF jsonb_typeof(featured) = 'object' THEN
    copied := home_ref_copy(featured ->> 'kind', featured ->> 'id', in_event);
    content := jsonb_set(content, '{featured}',
      CASE WHEN copied IS NULL THEN 'null'::jsonb
           ELSE jsonb_build_object('kind', featured ->> 'kind', 'id', copied) END);
  END IF;
  UPDATE event e SET config = jsonb_set(e.config, '{layout,content}', content) WHERE e.id = in_event;
END $$;
REVOKE ALL ON FUNCTION event_copy_home_content(uuid) FROM PUBLIC;

-- ================================================================ the door (restated from 0092 with one added call)
CREATE OR REPLACE FUNCTION event_copy_setup(source_event uuid, target_event uuid, request uuid) RETURNS jsonb
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
  PERFORM event_copy_home_content(tgt.id);
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after, request_id)
  VALUES ('staff', app_staff_user_id(), tgt.organizer_id, tgt.id, 'event.duplicate', 'event', tgt.id::text,
          jsonb_build_object('source', src.id) || counts, request);
  RETURN counts;
END $$;
REVOKE ALL ON FUNCTION event_copy_setup(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION event_copy_setup(uuid, uuid, uuid) TO questify_app;
