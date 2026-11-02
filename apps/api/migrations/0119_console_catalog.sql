-- T-709b: the console's catalog editors (FR-1403; plan docs/plans/2026-11-02-t-709b-catalog-editors.md; ADR-425 to ADR-428).
-- An admin edits four sets of configuration the platform already reads: event templates, achievement names, level titles,
-- and the gem shop (price, sale status, place). Achievement thresholds are not edited here: questify_sync pays gems for a
-- tier the moment a threshold falls under a player's count, and a revert cannot take those gems back (T-709c, tier A).
-- Every table stays closed; each editor is two doors (a list and a save) that start with console_admin() (QE403 for anyone
-- else), lock the row, change only that row, and write one audit entry holding the edited fields before and after. A revert
-- is the same save door given the id of the latest audit entry; the door reads that entry's `before` under the row's lock and
-- refuses (CA409) when another change landed since, so it passes the same checks as a save. Nothing here touches points, XP,
-- gems already earned, sign-in or any tenant's data.
-- Deny by default: PUBLIC holds EXECUTE on nothing, the helpers are internal, the doors go to questify_app only. Earlier
-- migrations untouched.
SET LOCAL lock_timeout = '10s';

-- The last catalog entry of a row is found by its target; the index holds only these few entries.
CREATE INDEX audit_log_catalog_idx ON audit_log (target_type, target_id, id DESC) WHERE action LIKE 'catalog.%';

-- ================================================================ helpers (internal)
-- A name an admin typed: trimmed, 1 to max_length characters, no control or direction character (CA400 otherwise; the
-- detail names the field). The API checks the same rule first; this is the database's own.
CREATE FUNCTION catalog_text(value text, field text, max_length integer) RETURNS text
  LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE
  clean text := btrim(value);
BEGIN
  IF clean IS NULL OR char_length(clean) NOT BETWEEN 1 AND max_length
     OR clean ~ '[\x01-\x1F\x7F-\x9F  ‪-‮⁦-⁩]' THEN
    RAISE EXCEPTION '% must have 1 to % characters, without control or direction characters', field, max_length
      USING ERRCODE = 'CA400', DETAIL = field;
  END IF;
  RETURN clean;
END $$;
REVOKE ALL ON FUNCTION catalog_text(text, text, integer) FROM PUBLIC;

-- The audit entry of one change, in the admin's name: the action is `catalog.<kind>.update` or `.revert`.
CREATE FUNCTION catalog_audit(action text, target_type text, target text, before_doc jsonb, after_doc jsonb,
                              request uuid) RETURNS void
  LANGUAGE sql VOLATILE SET search_path = public, pg_temp AS $$
  INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, before, after, request_id)
  VALUES ('admin', console_admin(), action, target_type, target, before_doc, after_doc, request)
$$;
REVOKE ALL ON FUNCTION catalog_audit(text, text, text, jsonb, jsonb, uuid) FROM PUBLIC;

-- The fields a revert puts back: the `before` of audit entry `entry_id`, which must still be the latest catalog entry of the
-- target (CA409 otherwise: someone changed the row after the revert was asked for). Every door calls it after it locked the
-- row, so no change can land between this read and the door's write.
CREATE FUNCTION catalog_revert_doc(kind text, target text, entry_id bigint) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SET search_path = public, pg_temp AS $$
DECLARE
  latest audit_log;
BEGIN
  SELECT * INTO latest FROM audit_log a
  WHERE a.target_type = kind AND a.target_id = target AND a.action LIKE 'catalog.%'
  ORDER BY a.id DESC LIMIT 1;
  IF NOT FOUND OR latest.id <> entry_id OR latest.before IS NULL THEN
    RAISE EXCEPTION 'the % changed after the revert was asked for', kind USING ERRCODE = 'CA409';
  END IF;
  RETURN latest.before;
END $$;
REVOKE ALL ON FUNCTION catalog_revert_doc(text, text, bigint) FROM PUBLIC;

-- ================================================================ event templates
-- The fields an admin edits, as the audit entry and a revert hold them.
CREATE FUNCTION admin_template_doc(t event_template) RETURNS jsonb
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'name', jsonb_build_object('ar', t.name_ar, 'en', t.name_en),
    'description', jsonb_build_object('ar', t.description_ar, 'en', t.description_en),
    'body', t.body, 'enabled', t.enabled)
$$;
REVOKE ALL ON FUNCTION admin_template_doc(event_template) FROM PUBLIC;

-- Every template in order, the switched-off ones too, with its stored body whatever it holds.
CREATE FUNCTION admin_templates() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM console_admin();
  RETURN coalesce((
    SELECT jsonb_agg(admin_template_doc(t) || jsonb_build_object('key', t.key, 'position', t.position,
                                                                'updatedAt', t.updated_at) ORDER BY t.position)
    FROM event_template t), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION admin_templates() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_templates() TO questify_app;

-- Saves one template, making it (last in order) when the key is new (CA409 when someone made that key a moment ago). Only
-- this row changes: an event that already started from the template keeps what it got. A save that changes nothing writes
-- nothing. `revert_of` is the audit entry a revert undoes (NULL for a save); the door reads its `before` under the row's lock.
-- The body is at most 60,000 bytes stored: the audit entry holds it twice, and an audit column must stay under 64 KB; the
-- API's own limit (TEMPLATE_BODY_MAX_BYTES) sits well inside. Answers the saved template.
CREATE FUNCTION admin_template_save(template_key text, doc jsonb, revert_of bigint, request uuid) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  old    event_template;
  made   event_template;
  n_ar   text;
  n_en   text;
  d_ar   text;
  d_en   text;
  shown  boolean;
  edited jsonb;
  existed boolean;
BEGIN
  PERFORM console_admin();
  SELECT * INTO old FROM event_template t WHERE t.key = template_key FOR UPDATE;
  existed := FOUND;
  IF revert_of IS NOT NULL THEN
    IF NOT existed THEN
      RAISE EXCEPTION 'no such template' USING ERRCODE = 'CA404';
    END IF;
    doc := catalog_revert_doc('event_template', template_key, revert_of);
  END IF;
  n_ar := catalog_text(doc #>> '{name,ar}', 'name.ar', 120);
  n_en := catalog_text(doc #>> '{name,en}', 'name.en', 120);
  d_ar := catalog_text(doc #>> '{description,ar}', 'description.ar', 300);
  d_en := catalog_text(doc #>> '{description,en}', 'description.en', 300);
  shown := (doc ->> 'enabled')::boolean;
  IF pg_column_size(doc -> 'body') > 60000 THEN
    RAISE EXCEPTION 'the template body is too long' USING ERRCODE = 'CA400', DETAIL = 'body';
  END IF;
  edited := jsonb_build_object('name', jsonb_build_object('ar', n_ar, 'en', n_en),
                               'description', jsonb_build_object('ar', d_ar, 'en', d_en),
                               'body', doc -> 'body', 'enabled', shown);
  IF existed THEN
    IF admin_template_doc(old) = edited THEN
      RETURN edited || jsonb_build_object('key', old.key, 'position', old.position, 'updatedAt', old.updated_at);
    END IF;
    UPDATE event_template t SET name_ar = n_ar, name_en = n_en, description_ar = d_ar, description_en = d_en,
           body = doc -> 'body', enabled = shown, updated_at = now()
    WHERE t.key = template_key
    RETURNING * INTO made;
  ELSE
    LOCK TABLE event_template IN SHARE ROW EXCLUSIVE MODE;
    IF EXISTS (SELECT 1 FROM event_template t WHERE t.key = template_key) THEN
      RAISE EXCEPTION 'a template with that key was just made' USING ERRCODE = 'CA409';
    END IF;
    INSERT INTO event_template (key, position, name_ar, name_en, description_ar, description_en, body, enabled)
    VALUES (template_key, (SELECT coalesce(max(position), 0) + 1 FROM event_template), n_ar, n_en, d_ar, d_en,
            doc -> 'body', shown)
    RETURNING * INTO made;
  END IF;
  PERFORM catalog_audit(CASE WHEN revert_of IS NOT NULL THEN 'catalog.template.revert' ELSE 'catalog.template.update' END,
                        'event_template', template_key, CASE WHEN old.key IS NOT NULL THEN admin_template_doc(old) END,
                        edited, request);
  RETURN edited || jsonb_build_object('key', made.key, 'position', made.position, 'updatedAt', made.updated_at);
END $$;
REVOKE ALL ON FUNCTION admin_template_save(text, jsonb, bigint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_template_save(text, jsonb, bigint, uuid) TO questify_app;

-- ================================================================ achievements
-- The name is all an admin edits of an achievement. The thresholds are shown, not edited (see the header).
CREATE FUNCTION admin_achievement_doc(a achievement) RETURNS jsonb
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('name', jsonb_build_object('ar', a.name_ar, 'en', a.name_en))
$$;
REVOKE ALL ON FUNCTION admin_achievement_doc(achievement) FROM PUBLIC;

CREATE FUNCTION admin_achievements() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM console_admin();
  RETURN coalesce((
    SELECT jsonb_agg(admin_achievement_doc(a) || jsonb_build_object(
             'id', a.id, 'metric', a.metric, 'bronze', a.bronze, 'silver', a.silver, 'gold', a.gold,
             'visualKey', a.visual_key, 'position', a.position)
           ORDER BY a.position)
    FROM achievement a), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION admin_achievements() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_achievements() TO questify_app;

-- Changes the name of one achievement (CA404 for an unknown id). A document with anything else in it, thresholds above all,
-- is refused (CA400, detail `thresholds`): questify_sync pays gems for a tier at the next sync of every player who now
-- reaches it, and those gems are append-only. A save that changes nothing writes nothing.
CREATE FUNCTION admin_achievement_save(achievement_id text, doc jsonb, revert_of bigint, request uuid) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  old    achievement;
  made   achievement;
  edited jsonb;
BEGIN
  PERFORM console_admin();
  SELECT * INTO old FROM achievement a WHERE a.id = achievement_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such achievement' USING ERRCODE = 'CA404';
  END IF;
  IF revert_of IS NOT NULL THEN
    doc := catalog_revert_doc('achievement', achievement_id, revert_of);
  END IF;
  IF jsonb_typeof(doc) = 'object' AND doc - 'name' <> '{}'::jsonb THEN
    RAISE EXCEPTION 'only the name of an achievement is edited here, not its thresholds'
      USING ERRCODE = 'CA400', DETAIL = 'thresholds';
  END IF;
  edited := jsonb_build_object('name', jsonb_build_object('ar', catalog_text(doc #>> '{name,ar}', 'name.ar', 60),
                                                          'en', catalog_text(doc #>> '{name,en}', 'name.en', 60)));
  IF admin_achievement_doc(old) = edited THEN
    RETURN edited || jsonb_build_object('id', old.id, 'metric', old.metric, 'bronze', old.bronze, 'silver', old.silver,
                                        'gold', old.gold, 'visualKey', old.visual_key, 'position', old.position);
  END IF;
  UPDATE achievement a SET name_ar = edited #>> '{name,ar}', name_en = edited #>> '{name,en}'
  WHERE a.id = achievement_id
  RETURNING * INTO made;
  PERFORM catalog_audit(CASE WHEN revert_of IS NOT NULL THEN 'catalog.achievement.revert' ELSE 'catalog.achievement.update' END,
                        'achievement', achievement_id, admin_achievement_doc(old), edited, request);
  RETURN edited || jsonb_build_object('id', made.id, 'metric', made.metric, 'bronze', made.bronze, 'silver', made.silver,
                                      'gold', made.gold, 'visualKey', made.visual_key, 'position', made.position);
END $$;
REVOKE ALL ON FUNCTION admin_achievement_save(text, jsonb, bigint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_achievement_save(text, jsonb, bigint, uuid) TO questify_app;

-- ================================================================ level titles
-- The whole set is one document: a title covers the levels from its own up to the next title's.
CREATE FUNCTION admin_level_titles_doc() RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('titles', coalesce(jsonb_agg(
    jsonb_build_object('levelFrom', l.level_from, 'name', jsonb_build_object('ar', l.name_ar, 'en', l.name_en))
    ORDER BY l.level_from), '[]'::jsonb))
  FROM level_title l
$$;
REVOKE ALL ON FUNCTION admin_level_titles_doc() FROM PUBLIC;

CREATE FUNCTION admin_level_titles() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM console_admin();
  RETURN admin_level_titles_doc();
END $$;
REVOKE ALL ON FUNCTION admin_level_titles() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_level_titles() TO questify_app;

-- Replaces the set: 1 to 100 titles, level 1 among them, no level twice (CA400). The writers queue on the table so two saves
-- cannot interleave; readers are never blocked. `revert_of` is the audit entry a revert undoes (NULL for a save).
CREATE FUNCTION admin_level_titles_save(doc jsonb, revert_of bigint, request uuid) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  old    jsonb;
  made   jsonb;
  levels integer[];
BEGIN
  PERFORM console_admin();
  LOCK TABLE level_title IN EXCLUSIVE MODE;
  IF revert_of IS NOT NULL THEN
    doc := catalog_revert_doc('level_title', 'all', revert_of);
  END IF;
  IF jsonb_typeof(doc -> 'titles') IS DISTINCT FROM 'array'
     OR jsonb_array_length(doc -> 'titles') NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'give 1 to 100 titles' USING ERRCODE = 'CA400', DETAIL = 'titles';
  END IF;
  old := admin_level_titles_doc();
  SELECT array_agg((t ->> 'levelFrom')::integer) INTO levels FROM jsonb_array_elements(doc -> 'titles') AS t;
  IF NOT 1 = ANY (levels) OR (SELECT count(DISTINCT x) FROM unnest(levels) AS x) <> cardinality(levels) THEN
    RAISE EXCEPTION 'level 1 needs a title and no level may have two' USING ERRCODE = 'CA400', DETAIL = 'titles';
  END IF;
  DELETE FROM level_title;
  INSERT INTO level_title (level_from, name_ar, name_en)
  SELECT (t ->> 'levelFrom')::smallint, catalog_text(t #>> '{name,ar}', 'name.ar', 40),
         catalog_text(t #>> '{name,en}', 'name.en', 40)
  FROM jsonb_array_elements(doc -> 'titles') AS t;
  made := admin_level_titles_doc();
  IF made <> old THEN
    PERFORM catalog_audit(CASE WHEN revert_of IS NOT NULL THEN 'catalog.level_titles.revert' ELSE 'catalog.level_titles.update' END,
                          'level_title', 'all', old, made, request);
  END IF;
  RETURN made;
END $$;
REVOKE ALL ON FUNCTION admin_level_titles_save(jsonb, bigint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_level_titles_save(jsonb, bigint, uuid) TO questify_app;

-- ================================================================ the gem shop
CREATE FUNCTION admin_shop_item_doc(s gem_shop_item) RETURNS jsonb
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('price', s.price, 'status', s.status, 'position', s.position)
$$;
REVOKE ALL ON FUNCTION admin_shop_item_doc(gem_shop_item) FROM PUBLIC;

CREATE FUNCTION admin_shop_items() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM console_admin();
  RETURN coalesce((
    SELECT jsonb_agg(admin_shop_item_doc(s) || jsonb_build_object(
             'itemId', s.item_id, 'kind', i.kind, 'visualKey', i.visual_key,
             'name', jsonb_build_object('ar', i.name_ar, 'en', i.name_en))
           ORDER BY s.position, s.item_id)
    FROM gem_shop_item s JOIN item i ON i.id = s.item_id), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION admin_shop_items() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_shop_items() TO questify_app;

-- Changes the price, the sale status and the place of one shop item (CA404 for an item not in the shop). A player who bought
-- it keeps it and its price (`gem_purchase.price`); a buy that saw the old price is refused with the new one (gem_buy).
-- New items and their names are not edited here (kind and id are fixed; T-709c).
CREATE FUNCTION admin_shop_item_save(shop_item text, doc jsonb, revert_of bigint, request uuid) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  old    gem_shop_item;
  edited jsonb;
BEGIN
  PERFORM console_admin();
  SELECT * INTO old FROM gem_shop_item s WHERE s.item_id = shop_item FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such shop item' USING ERRCODE = 'CA404';
  END IF;
  IF revert_of IS NOT NULL THEN
    doc := catalog_revert_doc('gem_shop_item', shop_item, revert_of);
  END IF;
  edited := jsonb_build_object('price', (doc ->> 'price')::integer, 'status', doc ->> 'status',
                               'position', (doc ->> 'position')::integer);
  IF admin_shop_item_doc(old) <> edited THEN
    UPDATE gem_shop_item s SET price = (edited ->> 'price')::integer, status = edited ->> 'status',
           position = (edited ->> 'position')::smallint
    WHERE s.item_id = shop_item;
    PERFORM catalog_audit(CASE WHEN revert_of IS NOT NULL THEN 'catalog.gem_shop.revert' ELSE 'catalog.gem_shop.update' END,
                          'gem_shop_item', shop_item, admin_shop_item_doc(old), edited, request);
  END IF;
  RETURN (SELECT e FROM jsonb_array_elements(admin_shop_items()) AS e WHERE e ->> 'itemId' = shop_item);
END $$;
REVOKE ALL ON FUNCTION admin_shop_item_save(text, jsonb, bigint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_shop_item_save(text, jsonb, bigint, uuid) TO questify_app;
