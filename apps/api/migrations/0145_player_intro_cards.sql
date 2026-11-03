-- T-802b: the console orders and hides the player intro's cards (FR-1803; plan docs/plans/2026-11-03-t-802b-intro-card-layout.md;
-- ADR-610 to ADR-613). A platform admin chooses the order of the four story cards the app plays on a first launch and from
-- Settings, and hides some of them (at least one stays shown). The cards' words stay in the translation matrix. The layout is one
-- platform setting, `playerIntro` = {order, hidden}, read by `GET /v1/config` like the other keys and written only by the door
-- below: the generic settings writer's policies already name `features` and `tuning` alone (0122), so the key cannot be written
-- any other way.
--
-- The door follows Questify home's (0137) and the catalog editors (0119): `console_admin()` first (QE403 for anyone else), the
-- row ensured and locked, the document checked again here (the API checks it first with the shared schema), one
-- `catalog.player_intro.update` or `.revert` audit entry holding the layout before and after, and a save that changes nothing
-- writes nothing. A revert is the same save given the id of the latest audit entry; the door reads that entry's `before` under
-- the row lock and refuses (CA409) when another change landed since. Nothing here touches points, XP, gems, sign-in or any
-- tenant's data, and no table or column is added.
--
-- Deny by default: PUBLIC holds EXECUTE on nothing, the helpers are internal, the two doors go to questify_app only. Earlier
-- migrations untouched.
SET LOCAL lock_timeout = '10s';

-- ================================================================ the cards (internal)
-- The cards in the order the intro has always played them: how to join, quests, points and the ranking, prizes and the profile.
-- The shared package names the same list (PLAYER_INTRO_CARDS); test/db/console-player-intro compares the two. A card added later
-- is added here by a migration.
CREATE FUNCTION player_intro_cards() RETURNS jsonb
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT '["join", "quests", "points", "prizes"]'::jsonb
$$;
REVOKE ALL ON FUNCTION player_intro_cards() FROM PUBLIC;

-- The intro the app had before it could be edited: every card shown in the shipped order.
CREATE FUNCTION player_intro_default() RETURNS jsonb
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object('order', player_intro_cards(), 'hidden', '[]'::jsonb)
$$;
REVOKE ALL ON FUNCTION player_intro_default() FROM PUBLIC;

-- A stored or earlier layout made whole: names that are not cards are dropped, a card listed twice counts once, a card that is
-- missing joins the end (a card added by a later migration), the hidden list is in the cards' own order, and a layout that
-- hides every card shows them all.
CREATE FUNCTION player_intro_repaired(stored jsonb) RETURNS jsonb
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  WITH known AS (
    SELECT c.card, c.ord
    FROM jsonb_array_elements_text(player_intro_cards()) WITH ORDINALITY AS c(card, ord)),
  listed AS (
    SELECT x.card, min(x.pos) AS pos
    FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(stored -> 'order') = 'array' THEN stored -> 'order' ELSE '[]'::jsonb END)
         WITH ORDINALITY AS x(card, pos)
    JOIN known k ON k.card = x.card
    GROUP BY x.card),
  hidden AS (
    SELECT DISTINCT h.card
    FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(stored -> 'hidden') = 'array' THEN stored -> 'hidden' ELSE '[]'::jsonb END)
         AS h(card)
    JOIN known k ON k.card = h.card),
  hidden_cards AS (
    SELECT CASE WHEN (SELECT count(*) FROM hidden) >= (SELECT count(*) FROM known) THEN '[]'::jsonb
                ELSE coalesce((SELECT jsonb_agg(k.card ORDER BY k.ord) FROM known k JOIN hidden h ON h.card = k.card), '[]'::jsonb)
           END AS cards)
  SELECT jsonb_build_object(
    'order', (SELECT jsonb_agg(k.card ORDER BY l.pos NULLS LAST, k.ord) FROM known k LEFT JOIN listed l ON l.card = k.card),
    'hidden', (SELECT cards FROM hidden_cards))
$$;
REVOKE ALL ON FUNCTION player_intro_repaired(jsonb) FROM PUBLIC;

-- The layout in force: the stored one made whole, or the default while none is stored.
CREATE FUNCTION player_intro_in_force() RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT player_intro_repaired(coalesce((SELECT s.value FROM platform_setting s WHERE s.key = 'playerIntro'),
                                        player_intro_default()))
$$;
REVOKE ALL ON FUNCTION player_intro_in_force() FROM PUBLIC;

-- ================================================================ the check (internal)
-- The whole layout an admin saves: only order and hidden; every card exactly once in the order; the hidden list known cards,
-- each once, and at least one card left shown. Answers it in its stored shape (CA400 otherwise, the detail names the field).
CREATE FUNCTION player_intro_checked(doc jsonb) RETURNS jsonb
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  known  text[] := ARRAY(SELECT jsonb_array_elements_text(player_intro_cards()));
  listed text[];
  hid    text[];
BEGIN
  IF NOT home_only_keys(doc, ARRAY['order', 'hidden'])
     OR jsonb_typeof(doc -> 'order') IS DISTINCT FROM 'array'
     OR jsonb_typeof(doc -> 'hidden') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'give the order and the hidden cards' USING ERRCODE = 'CA400', DETAIL = 'layout';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(doc -> 'order') AS e WHERE jsonb_typeof(e) <> 'string') THEN
    RAISE EXCEPTION 'the order lists card names' USING ERRCODE = 'CA400', DETAIL = 'order';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(doc -> 'hidden') AS e WHERE jsonb_typeof(e) <> 'string') THEN
    RAISE EXCEPTION 'the hidden list holds card names' USING ERRCODE = 'CA400', DETAIL = 'hidden';
  END IF;
  listed := ARRAY(SELECT jsonb_array_elements_text(doc -> 'order'));
  hid := ARRAY(SELECT jsonb_array_elements_text(doc -> 'hidden'));
  IF cardinality(listed) <> cardinality(known) OR NOT listed @> known OR NOT known @> listed THEN
    RAISE EXCEPTION 'the order lists every card once' USING ERRCODE = 'CA400', DETAIL = 'order';
  END IF;
  IF NOT known @> hid OR cardinality(hid) <> (SELECT count(DISTINCT h) FROM unnest(hid) AS h) THEN
    RAISE EXCEPTION 'hide known cards, each once' USING ERRCODE = 'CA400', DETAIL = 'hidden';
  END IF;
  IF cardinality(hid) >= cardinality(known) THEN
    RAISE EXCEPTION 'at least one card must be shown' USING ERRCODE = 'CA400', DETAIL = 'hidden';
  END IF;
  RETURN player_intro_repaired(jsonb_build_object('order', doc -> 'order', 'hidden', doc -> 'hidden'));
END $$;
REVOKE ALL ON FUNCTION player_intro_checked(jsonb) FROM PUBLIC;

-- ================================================================ the doors
-- The layout in force: the order and the hidden cards.
CREATE FUNCTION admin_player_intro() RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM console_admin();
  RETURN player_intro_in_force();
END $$;
REVOKE ALL ON FUNCTION admin_player_intro() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_player_intro() TO questify_app;

-- Saves the layout. From the save on, every app that reads its configuration plays the intro this way; nothing a player earned
-- changes. The row is ensured first so it can be locked; two saves queue on it. A save that changes nothing writes nothing.
-- `revert_of` is the audit entry a revert undoes (NULL for a save); the door reads its `before` under the lock.
CREATE FUNCTION admin_player_intro_save(doc jsonb, revert_of bigint, request uuid) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me     uuid := console_admin();
  old    jsonb;
  edited jsonb;
BEGIN
  INSERT INTO platform_setting (key, value, updated_by) VALUES ('playerIntro', player_intro_default(), me)
  ON CONFLICT (key) DO NOTHING;
  PERFORM 1 FROM platform_setting s WHERE s.key = 'playerIntro' FOR UPDATE;
  IF revert_of IS NOT NULL THEN
    doc := player_intro_repaired(catalog_revert_doc('platform_setting', 'player_intro', revert_of));
  END IF;
  edited := player_intro_checked(doc);
  old := player_intro_in_force();
  IF old <> edited THEN
    UPDATE platform_setting s SET value = edited, updated_at = now(), updated_by = me WHERE s.key = 'playerIntro';
    PERFORM catalog_audit(CASE WHEN revert_of IS NOT NULL THEN 'catalog.player_intro.revert' ELSE 'catalog.player_intro.update' END,
                          'platform_setting', 'player_intro', old, edited, request);
  END IF;
  RETURN player_intro_in_force();
END $$;
REVOKE ALL ON FUNCTION admin_player_intro_save(jsonb, bigint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_player_intro_save(jsonb, bigint, uuid) TO questify_app;
