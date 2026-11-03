-- T-713: the console edits Questify home (FR-1838; plan docs/plans/2026-11-03-t-713-questify-home-layout.md; ADR-510 to
-- ADR-514). A platform admin reorders and hides the blocks of the home screen the app shows outside an event, and writes the
-- text slides of its banner. The layout is one platform setting, `questifyHome` = {order, hidden, banner}, read by
-- `GET /v1/config` like the other two keys and written only by the door below: the generic settings writer's policies already
-- name `features` and `tuning` alone (0122), so the key cannot be written any other way.
--
-- The door follows the catalog editors (0119): `console_admin()` first (QE403 for anyone else), the row ensured and locked, the
-- document checked again here (the API checks it first with the shared schema), one `catalog.home_layout.update` or `.revert`
-- audit entry holding the layout before and after, and a save that changes nothing writes nothing. A revert is the same save
-- given the id of the latest audit entry; the door reads that entry's `before` under the row lock and refuses (CA409) when
-- another change landed since. Nothing here touches points, XP, gems, sign-in or any tenant's data.
--
-- Deny by default: PUBLIC holds EXECUTE on nothing, the helpers are internal, the two doors go to questify_app only. Earlier
-- migrations untouched.
SET LOCAL lock_timeout = '10s';

-- ================================================================ the blocks (internal)
-- The blocks of Questify home in the order the app draws them by default, and the ones no layout can hide: what Questify says
-- about a switched-off feature, the typed code, the recovery email, the staff's way to their event, invitations and the
-- player's own events (ADR-511). The shared package names the same list (QUESTIFY_HOME_BLOCKS);
-- test/db/console-home-layout compares the two. A block added later is added here by a migration.
CREATE FUNCTION questify_home_blocks() RETURNS jsonb
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT '[{"block": "banner", "protected": false},
           {"block": "notices", "protected": true},
           {"block": "code", "protected": true},
           {"block": "account", "protected": true},
           {"block": "operator", "protected": true},
           {"block": "invitations", "protected": true},
           {"block": "streak", "protected": false},
           {"block": "dailyChallenge", "protected": false},
           {"block": "dailyWord", "protected": false},
           {"block": "events", "protected": true},
           {"block": "quests", "protected": false}]'::jsonb
$$;
REVOKE ALL ON FUNCTION questify_home_blocks() FROM PUBLIC;

-- The layout the app had before it could be edited: every block shown in the default order, no slides.
CREATE FUNCTION questify_home_default() RETURNS jsonb
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'order', (SELECT jsonb_agg(b.block ->> 'block' ORDER BY b.ord)
              FROM jsonb_array_elements(questify_home_blocks()) WITH ORDINALITY AS b(block, ord)),
    'hidden', '[]'::jsonb,
    'banner', '[]'::jsonb)
$$;
REVOKE ALL ON FUNCTION questify_home_default() FROM PUBLIC;

-- A stored or earlier layout made whole: names that are not blocks are dropped, a block listed twice counts once, a block that
-- is missing joins the end (a block added by a later migration), a protected block is never hidden, and the hidden list is in
-- the blocks' own order. The slides are kept as they are.
CREATE FUNCTION questify_home_repaired(stored jsonb) RETURNS jsonb
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  WITH known AS (
    SELECT b.block ->> 'block' AS block, (b.block ->> 'protected')::boolean AS locked, b.ord
    FROM jsonb_array_elements(questify_home_blocks()) WITH ORDINALITY AS b(block, ord)),
  listed AS (
    SELECT x.block, min(x.pos) AS pos
    FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(stored -> 'order') = 'array' THEN stored -> 'order' ELSE '[]'::jsonb END)
         WITH ORDINALITY AS x(block, pos)
    JOIN known k ON k.block = x.block
    GROUP BY x.block),
  hidden AS (
    SELECT DISTINCT h.block
    FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(stored -> 'hidden') = 'array' THEN stored -> 'hidden' ELSE '[]'::jsonb END)
         AS h(block))
  SELECT jsonb_build_object(
    'order', (SELECT jsonb_agg(k.block ORDER BY l.pos NULLS LAST, k.ord) FROM known k LEFT JOIN listed l ON l.block = k.block),
    'hidden', coalesce((SELECT jsonb_agg(k.block ORDER BY k.ord) FROM known k JOIN hidden h ON h.block = k.block WHERE NOT k.locked),
                       '[]'::jsonb),
    'banner', CASE WHEN jsonb_typeof(stored -> 'banner') = 'array' THEN stored -> 'banner' ELSE '[]'::jsonb END)
$$;
REVOKE ALL ON FUNCTION questify_home_repaired(jsonb) FROM PUBLIC;

-- The layout in force: the stored one made whole, or the default while none is stored.
CREATE FUNCTION questify_home_in_force() RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT questify_home_repaired(coalesce((SELECT s.value FROM platform_setting s WHERE s.key = 'questifyHome'),
                                         questify_home_default()))
$$;
REVOKE ALL ON FUNCTION questify_home_in_force() FROM PUBLIC;

-- ================================================================ the checks (internal)
-- Whether a value is an object that holds no field outside `allowed` (a scalar or a list is not).
CREATE FUNCTION home_only_keys(value jsonb, allowed text[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce(jsonb_typeof(value) = 'object'
                  AND NOT EXISTS (SELECT 1 FROM jsonb_object_keys(value) AS k WHERE k <> ALL (allowed)), false)
$$;
REVOKE ALL ON FUNCTION home_only_keys(jsonb, text[]) FROM PUBLIC;

-- Text in both languages: only `ar` and `en`, each a string of at most max_length characters with no control or direction
-- character; with `required`, at least one of them not empty. CA400 otherwise, the detail names the field.
CREATE FUNCTION home_text_checked(value jsonb, field text, max_length integer, required boolean) RETURNS jsonb
  LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE
  ar text;
  en text;
BEGIN
  IF NOT home_only_keys(value, ARRAY['ar', 'en'])
     OR jsonb_typeof(coalesce(value -> 'ar', '""'::jsonb)) <> 'string'
     OR jsonb_typeof(coalesce(value -> 'en', '""'::jsonb)) <> 'string' THEN
    RAISE EXCEPTION '% must hold Arabic and English text', field USING ERRCODE = 'CA400', DETAIL = field;
  END IF;
  ar := coalesce(value ->> 'ar', '');
  en := coalesce(value ->> 'en', '');
  IF char_length(ar) > max_length OR char_length(en) > max_length
     OR (ar || en) ~ '[\x01-\x1F\x7F-\x9F  ‪-‮⁦-⁩]'
     OR (required AND ar = '' AND en = '') THEN
    RAISE EXCEPTION '% must have at most % characters, none of them control or direction characters', field, max_length
      USING ERRCODE = 'CA400', DETAIL = field;
  END IF;
  RETURN jsonb_build_object('ar', ar, 'en', en);
END $$;
REVOKE ALL ON FUNCTION home_text_checked(jsonb, text, integer, boolean) FROM PUBLIC;

-- One banner slide: a title (60 characters, at least one language), a subtitle (100), and a tap that opens nothing or an https
-- link to a named host (300 characters). Any other field or tap is refused. Answers the slide in its stored shape.
CREATE FUNCTION home_slide_checked(slide jsonb, place integer) RETURNS jsonb
  LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
DECLARE
  field  text := 'banner.' || place;
  tap    jsonb := coalesce(slide -> 'action', '{"type": "none"}'::jsonb);
  kind   text;
  url    text;
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
    IF char_length(url) > 300 OR url ~ '[\x01-\x1F\x7F-\x9F]'
       OR url !~* '^https://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(:[0-9]{1,5})?([/?#][^[:space:]\\]*)?$' THEN
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

-- The whole layout an admin saves: only order, hidden and banner; every block exactly once in the order; the hidden list known
-- blocks, each once and none protected; at most five slides, each checked. Answers it in its stored shape (CA400 otherwise).
CREATE FUNCTION questify_home_checked(doc jsonb) RETURNS jsonb
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  known  text[] := ARRAY(SELECT b ->> 'block' FROM jsonb_array_elements(questify_home_blocks()) AS b);
  locked text[] := ARRAY(SELECT b ->> 'block' FROM jsonb_array_elements(questify_home_blocks()) AS b
                         WHERE (b ->> 'protected')::boolean);
  listed text[];
  hid    text[];
  slides jsonb;
BEGIN
  IF NOT home_only_keys(doc, ARRAY['order', 'hidden', 'banner'])
     OR jsonb_typeof(doc -> 'order') IS DISTINCT FROM 'array'
     OR jsonb_typeof(doc -> 'hidden') IS DISTINCT FROM 'array'
     OR jsonb_typeof(doc -> 'banner') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'give the order, the hidden blocks and the banner' USING ERRCODE = 'CA400', DETAIL = 'layout';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(doc -> 'order') AS e WHERE jsonb_typeof(e) <> 'string') THEN
    RAISE EXCEPTION 'the order lists block names' USING ERRCODE = 'CA400', DETAIL = 'order';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(doc -> 'hidden') AS e WHERE jsonb_typeof(e) <> 'string') THEN
    RAISE EXCEPTION 'the hidden list holds block names' USING ERRCODE = 'CA400', DETAIL = 'hidden';
  END IF;
  listed := ARRAY(SELECT jsonb_array_elements_text(doc -> 'order'));
  hid := ARRAY(SELECT jsonb_array_elements_text(doc -> 'hidden'));
  IF cardinality(listed) <> cardinality(known) OR NOT listed @> known OR NOT known @> listed THEN
    RAISE EXCEPTION 'the order lists every block once' USING ERRCODE = 'CA400', DETAIL = 'order';
  END IF;
  IF NOT known @> hid OR hid && locked OR cardinality(hid) <> (SELECT count(DISTINCT h) FROM unnest(hid) AS h) THEN
    RAISE EXCEPTION 'hide known blocks, each once, and not a block that is always shown'
      USING ERRCODE = 'CA400', DETAIL = 'hidden';
  END IF;
  IF jsonb_array_length(doc -> 'banner') > 5 THEN
    RAISE EXCEPTION 'the banner holds at most 5 slides' USING ERRCODE = 'CA400', DETAIL = 'banner';
  END IF;
  slides := coalesce((SELECT jsonb_agg(home_slide_checked(s.slide, s.n::integer - 1) ORDER BY s.n)
                      FROM jsonb_array_elements(doc -> 'banner') WITH ORDINALITY AS s(slide, n)), '[]'::jsonb);
  RETURN questify_home_repaired(jsonb_build_object('order', doc -> 'order', 'hidden', doc -> 'hidden', 'banner', slides));
END $$;
REVOKE ALL ON FUNCTION questify_home_checked(jsonb) FROM PUBLIC;

-- ================================================================ the doors
-- The layout in force: the order, the hidden blocks and the slides.
CREATE FUNCTION admin_home_layout() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM console_admin();
  RETURN questify_home_in_force();
END $$;
REVOKE ALL ON FUNCTION admin_home_layout() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_home_layout() TO questify_app;

-- Saves the layout. From the save on, every app that reads its configuration draws Questify home this way; nothing a player
-- earned changes. The row is ensured first so it can be locked; two saves queue on it. A save that changes nothing writes
-- nothing. `revert_of` is the audit entry a revert undoes (NULL for a save); the door reads its `before` under the lock.
CREATE FUNCTION admin_home_layout_save(doc jsonb, revert_of bigint, request uuid) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me     uuid := console_admin();
  old    jsonb;
  edited jsonb;
BEGIN
  INSERT INTO platform_setting (key, value, updated_by) VALUES ('questifyHome', questify_home_default(), me)
  ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM platform_setting s WHERE s.key = 'questifyHome' FOR UPDATE;
  IF revert_of IS NOT NULL THEN
    doc := questify_home_repaired(catalog_revert_doc('platform_setting', 'questify_home', revert_of));
  END IF;
  edited := questify_home_checked(doc);
  old := questify_home_in_force();
  IF old <> edited THEN
    UPDATE platform_setting s SET value = edited, updated_at = now(), updated_by = me WHERE s.key = 'questifyHome';
    PERFORM catalog_audit(CASE WHEN revert_of IS NOT NULL THEN 'catalog.home_layout.revert' ELSE 'catalog.home_layout.update' END,
                          'platform_setting', 'questify_home', old, edited, request);
  END IF;
  RETURN questify_home_in_force();
END $$;
REVOKE ALL ON FUNCTION admin_home_layout_save(jsonb, bigint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_home_layout_save(jsonb, bigint, uuid) TO questify_app;
