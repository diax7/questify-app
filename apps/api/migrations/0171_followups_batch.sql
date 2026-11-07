-- A batch of review follow-ups (docs/FOLLOWUPS.md, batch 18). Nothing here writes points, changes an XP or daily amount
-- paid, or changes what a sign-in does. Restated with their grants: own_achievements, admin_amounts_save,
-- admin_xp_table_save, admin_report_resolve, daily_xp, achievement_xp. daily_xp_field loses its unused `top` and is
-- replaced; one new door (change_set_release, closed to PUBLIC, the API role's). No new table or column. Deployed
-- migrations untouched.
SET LOCAL lock_timeout = '10s';

-- ================================================================ the next tier of an achievement (T-709c)
-- As 0122, with one change: only the next tier being the revoked one hides it (a revoked tier is never earned again). A
-- revoked lower tier blocks nothing above it, so a player who holds silver with bronze revoked still sees gold.
CREATE OR REPLACE FUNCTION own_achievements() RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_agg(jsonb_build_object('id', a.id, 'name', jsonb_build_object('ar', a.name_ar, 'en', a.name_en),
    'visualKey', a.visual_key, 'tier', t.tier, 'progress', m.value,
    'next', CASE WHEN r.revoked THEN NULL
                 WHEN t.tier = 'gold' THEN NULL
                 WHEN t.tier = 'silver' THEN jsonb_build_object('tier', 'gold', 'target', a.gold)
                 WHEN t.tier = 'bronze' THEN jsonb_build_object('tier', 'silver', 'target', a.silver)
                 ELSE jsonb_build_object('tier', 'bronze', 'target', a.bronze) END)
    ORDER BY a.position)
  FROM (SELECT profile_player() AS id) me
  CROSS JOIN LATERAL player_metrics(me.id) m JOIN achievement a ON a.metric = m.metric
  CROSS JOIN LATERAL (SELECT earned_tier(me.id, a.id) AS tier) t
  CROSS JOIN LATERAL (SELECT tier_revoked(me.id, a.id, CASE t.tier WHEN 'gold' THEN NULL WHEN 'silver' THEN 'gold'
                                                                   WHEN 'bronze' THEN 'silver' ELSE 'bronze' END)
                             AS revoked) r
  WHERE me.id IS NOT NULL
$$;
REVOKE ALL ON FUNCTION own_achievements() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION own_achievements() TO questify_app;

-- ================================================================ a save that changes nothing (T-709c)
-- As 0164, with one change: the missing row is stored only by a save that changes something, so a no-op writes nothing,
-- as this door's comment always said. With no row there is nothing to lock, so that save stores the row and runs again,
-- to read the amounts and write its audit entry under the lock.
CREATE OR REPLACE FUNCTION admin_amounts_save(doc jsonb, revert_of bigint, request uuid) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me     uuid := console_admin();
  old    jsonb;
  edited jsonb;
  stored boolean;
BEGIN
  PERFORM 1 FROM platform_setting s WHERE s.key = 'xp' FOR UPDATE;
  stored := FOUND;
  old := admin_amounts_doc();
  IF revert_of IS NOT NULL THEN
    doc := catalog_revert_doc('platform_setting', 'amounts', revert_of) - 'gems';
    IF jsonb_typeof(doc -> 'xp') = 'object' THEN
      doc := jsonb_build_object('xp', (old -> 'xp') || (doc -> 'xp'));
    END IF;
  END IF;
  IF jsonb_typeof(doc) IS DISTINCT FROM 'object' OR doc - ARRAY['xp'] <> '{}'::jsonb THEN
    RAISE EXCEPTION 'give the xp amounts only' USING ERRCODE = 'CA400', DETAIL = 'amounts';
  END IF;
  edited := jsonb_build_object(
    'xp', amounts_group(doc, 'xp',
                        ARRAY['questXp', 'dailyFinishXp', 'dailyRightXp', 'dailyWordXp', 'bronzeXp', 'silverXp', 'goldXp'],
                        ARRAY[1, 0, 0, 0, 0, 0, 0], ARRAY[99999, 400, 200, 1000, 1000, 1000, 1000]));
  IF old <> edited THEN
    IF NOT stored THEN
      INSERT INTO platform_setting (key, value, updated_by) VALUES ('xp', old -> 'xp', me)
      ON CONFLICT (key) DO NOTHING;
      RETURN admin_amounts_save(doc, revert_of, request);
    END IF;
    UPDATE platform_setting s SET value = s.value || (edited -> 'xp'), updated_at = now(), updated_by = me
    WHERE s.key = 'xp';
    PERFORM catalog_audit(CASE WHEN revert_of IS NOT NULL THEN 'catalog.amounts.revert' ELSE 'catalog.amounts.update' END,
                          'platform_setting', 'amounts', old, edited, request);
  END IF;
  RETURN admin_amounts();
END $$;
REVOKE ALL ON FUNCTION admin_amounts_save(jsonb, bigint, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_amounts_save(jsonb, bigint, uuid) TO questify_app;

-- ================================================================ the daily amounts' reader (T-709c)
-- platform_setting_xp_daily_check (0163) holds every stored field to a whole number in its range, the range this function
-- also checked, so a field is its stored value or, absent, the fallback. daily_xp and achievement_xp are its only callers.
-- As 0069 and 0164 otherwise; they pay the same amounts.
DROP FUNCTION daily_xp_field(jsonb, text, integer, integer);
CREATE FUNCTION daily_xp_field(setting jsonb, field text, fallback integer) RETURNS integer
  LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
BEGIN
  RETURN coalesce((setting ->> field)::integer, fallback);
END $$;
REVOKE ALL ON FUNCTION daily_xp_field(jsonb, text, integer) FROM PUBLIC;

CREATE OR REPLACE FUNCTION daily_xp() RETURNS TABLE (finish integer, per_right integer, word integer)
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT daily_xp_field(s.value, 'dailyFinishXp', 20), daily_xp_field(s.value, 'dailyRightXp', 10),
         daily_xp_field(s.value, 'dailyWordXp', 50)
  FROM (SELECT (SELECT p.value FROM platform_setting p WHERE p.key = 'xp') AS value) s
$$;
REVOKE ALL ON FUNCTION daily_xp() FROM PUBLIC;

CREATE OR REPLACE FUNCTION achievement_xp() RETURNS TABLE (bronze integer, silver integer, gold integer)
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  setting jsonb := (SELECT p.value FROM platform_setting p WHERE p.key = 'xp');
BEGIN
  RETURN QUERY SELECT daily_xp_field(setting, 'bronzeXp', 50), daily_xp_field(setting, 'silverXp', 150),
                      daily_xp_field(setting, 'goldXp', 300);
END $$;
REVOKE ALL ON FUNCTION achievement_xp() FROM PUBLIC;

-- ================================================================ a level's bad item takes no lock (T-709d)
-- As 0164, with one change: a souvenir's id or an unknown id is left unlocked, so a document xp_table_refusals will
-- refuse does not spend the door's 1 s budget waiting on an item row. An id that appears after this read reaches
-- xp_table_write, whose trigger locks the item (souvenir_catalog_guard).
CREATE OR REPLACE FUNCTION admin_xp_table_save(doc jsonb, revert_of bigint, confirmed boolean, request uuid) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  started timestamptz := clock_timestamp();
  old     jsonb;
  edited  jsonb;
  paying  integer[];
  target  smallint;
  chosen  text;
BEGIN
  PERFORM console_admin();
  PERFORM set_config('lock_timeout', xp_lock_left(started), true);
  PERFORM 1 FROM xp_level l WHERE l.level = 1 FOR UPDATE;
  FOR target IN SELECT l.level FROM xp_level l WHERE l.level > 1 ORDER BY l.level LOOP
    PERFORM set_config('lock_timeout', xp_lock_left(started), true);
    PERFORM 1 FROM xp_level l WHERE l.level = target FOR UPDATE;
  END LOOP;
  IF revert_of IS NOT NULL THEN
    doc := catalog_revert_doc('xp_level', 'all', revert_of);
  END IF;
  edited := xp_table_checked(doc);
  old := admin_xp_table_doc();
  IF old = edited THEN
    RETURN admin_xp_table();
  END IF;
  FOR target IN
    SELECT o.level FROM jsonb_to_recordset(old -> 'levels') AS o (level smallint, "itemId" text)
    LEFT JOIN jsonb_to_recordset(edited -> 'levels') AS n (level smallint, "itemId" text) ON n.level = o.level
    WHERE o.level > 1 AND o."itemId" IS DISTINCT FROM n."itemId"
    ORDER BY o.level
  LOOP
    PERFORM set_config('lock_timeout', xp_lock_left(started), true);
    PERFORM 1 FROM level_item m WHERE m.level = target FOR UPDATE;
  END LOOP;
  FOR chosen IN
    SELECT DISTINCT n."itemId" FROM jsonb_to_recordset(edited -> 'levels') AS n (level smallint, "itemId" text)
    LEFT JOIN jsonb_to_recordset(old -> 'levels') AS o (level smallint, "itemId" text) ON o.level = n.level
    WHERE n.level > 1 AND o."itemId" IS DISTINCT FROM n."itemId"
    ORDER BY 1
  LOOP
    CONTINUE WHEN chosen LIKE 'souvenir-%' OR NOT EXISTS (SELECT 1 FROM item i WHERE i.id = chosen);
    PERFORM set_config('lock_timeout', xp_lock_left(started), true);
    PERFORM 1 FROM item i WHERE i.id = chosen FOR UPDATE;
  END LOOP;
  PERFORM xp_table_refusals(old, edited);
  paying := xp_table_paying(old, edited);
  IF cardinality(paying) > 0 AND confirmed IS NOT TRUE THEN
    RAISE EXCEPTION 'a lower curve pays level rewards that cannot be taken back; confirm it'
      USING ERRCODE = 'CA428', DETAIL = jsonb_build_object('levels', to_jsonb(paying))::text;
  END IF;
  PERFORM xp_table_write(old, edited);
  PERFORM catalog_audit(CASE WHEN revert_of IS NOT NULL THEN 'catalog.xp_table.revert' ELSE 'catalog.xp_table.update' END,
                        'xp_level', 'all', old, edited, request);
  RETURN admin_xp_table();
END $$;
REVOKE ALL ON FUNCTION admin_xp_table_save(jsonb, bigint, boolean, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_xp_table_save(jsonb, bigint, boolean, uuid) TO questify_app;

-- ================================================================ a reported username (batch 4 review)
-- As 0162, with one change: usernames are compared as the unique index folds them (player_username_key, username_fold), so
-- a change of case or of an Arabic letter form is still the name the report names, not a rename.
CREATE OR REPLACE FUNCTION admin_report_resolve(target_kind text, target uuid, resolution text, request uuid)
  RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me     uuid := console_admin();
  closed integer;
  ev_id  uuid;
BEGIN
  IF resolution IS NULL OR resolution NOT IN ('dismissed', 'unpublished', 'event_suspended', 'username_changed',
                                              'player_banned') THEN
    RAISE EXCEPTION 'an outcome from the list' USING ERRCODE = 'RP422';
  END IF;
  PERFORM report_target_lock(admin_report_resolve.target_kind, target);
  IF NOT (CASE resolution
    WHEN 'dismissed' THEN true
    WHEN 'unpublished' THEN admin_report_resolve.target_kind IN ('quest', 'reward', 'announcement')
                            AND content_held(admin_report_resolve.target_kind, target)
    WHEN 'event_suspended' THEN admin_report_resolve.target_kind <> 'username'
                                AND coalesce(event_suspended(coalesce(
                                      report_event(admin_report_resolve.target_kind, target),
                                      (SELECT r.event_id FROM content_report r
                                       WHERE r.target_kind = admin_report_resolve.target_kind AND r.target_id = target
                                         AND r.event_id IS NOT NULL LIMIT 1))), false)
    WHEN 'username_changed' THEN admin_report_resolve.target_kind = 'username'
                                 AND NOT EXISTS (SELECT 1 FROM content_report r JOIN player p ON p.id = r.target_id
                                                 WHERE r.target_kind = 'username' AND r.target_id = target
                                                   AND r.status = 'open'
                                                   AND username_fold(r.snapshot ->> 'username') = username_fold(p.username))
    WHEN 'player_banned' THEN admin_report_resolve.target_kind = 'username'
                              AND EXISTS (SELECT 1 FROM player p WHERE p.id = target AND p.status = 'banned')
  END) THEN
    RAISE EXCEPTION 'take the action first, then close the reports with it' USING ERRCODE = 'RP409';
  END IF;
  WITH done AS (
    UPDATE content_report r
    SET status = CASE WHEN resolution = 'dismissed' THEN 'dismissed' ELSE 'actioned' END, outcome = resolution,
        handled_by = me, handled_at = now()
    WHERE r.target_kind = admin_report_resolve.target_kind AND r.target_id = target AND r.status = 'open'
    RETURNING r.event_id)
  SELECT count(*), max(d.event_id::text)::uuid INTO closed, ev_id FROM done d;
  IF closed > 0 THEN
    INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after,
                           request_id)
    VALUES ('admin', me, (SELECT e.organizer_id FROM event e WHERE e.id = ev_id), ev_id, 'report.resolve', target_kind,
            target::text, jsonb_build_object('outcome', resolution, 'closed', closed), request);
  END IF;
  RETURN closed;
END $$;
REVOKE ALL ON FUNCTION admin_report_resolve(text, uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_report_resolve(text, uuid, text, uuid) TO questify_app;

-- ================================================================ letting go of a change set (batch 7 review)
-- A claim is let go of even when its caller just lost the event (removed from the team, or limited to other events): the
-- row policies then hide the set, which would stay busy until the claim ran out. So the release does not ask them: it takes
-- the set of the organizer in context, and only the exact claim, which only the apply that made it holds.
CREATE FUNCTION change_set_release(target uuid, claim timestamptz) RETURNS void
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE change_set s SET applying_until = NULL
  WHERE s.id = target AND s.status = 'open' AND s.applying_until = claim
    AND s.organizer_id = NULLIF(current_setting('app.organizer_id', true), '')::uuid;
END $$;
REVOKE ALL ON FUNCTION change_set_release(uuid, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION change_set_release(uuid, timestamptz) TO questify_app;
