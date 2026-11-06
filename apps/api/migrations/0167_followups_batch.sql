-- A batch of review follow-ups (docs/FOLLOWUPS.md, 2026-11-06 batch 10; ADR-811). Nothing here writes points, changes what a
-- sign-in does, or changes how a redemption is locked or written. Three functions restated with their arguments and grants
-- (console_feature_usage, desk_offer_sale, alert_scan_flags); my_desk_sales gains a result column; one new read
-- (my_held_prizes, closed to PUBLIC, the API role's door); one column closed; one index dropped. No new table. Deployed
-- migrations untouched.
SET LOCAL lock_timeout = '10s';

-- ================================================================ who set an override (T-711)
-- Whoever sees one of an organizer's public events reads its overrides (0136), and with them the admin's id in `set_by`.
-- The rows stay readable; that one column no longer is. The API role keeps writing it. A read of it now fails, which also
-- covers `EXCLUDED.set_by` in an upsert, so `upsertOverride` passes the value itself: the previous release's upsert fails
-- in the seconds before the new API takes over, and the admin's Save can be retried.
REVOKE SELECT ON organizer_feature_override FROM questify_app;
GRANT SELECT (organizer_id, feature, enabled, set_at) ON organizer_feature_override TO questify_app;

-- ================================================================ the next page of feature usage (T-714)
-- As 0140 (`page_size` reached 50), with one change: the size is held to 51. The route shows at most 50, and asks for one
-- more than it shows, so a last page of exactly `limit` organizers no longer answers a cursor to an empty page.
CREATE OR REPLACE FUNCTION console_feature_usage(search text, after uuid, page_size integer, feature_keys text[]) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  size constant integer := least(greatest(coalesce(page_size, 25), 1), 51);
  cap  constant integer := 200;
BEGIN
  PERFORM console_admin();
  RETURN (
    WITH page AS MATERIALIZED (
      SELECT x.id, x.name, x.slug FROM organizer x
      WHERE (search IS NULL OR starts_with(lower(x.name), lower(search)) OR starts_with(lower(x.slug), lower(search)))
        AND (after IS NULL OR (lower(x.name), x.id) > (SELECT lower(c.name), c.id FROM organizer c WHERE c.id = after))
      ORDER BY lower(x.name), x.id
      LIMIT size),
    latest AS MATERIALIZED (
      SELECT p.id AS org, e.id AS ev, e.config -> 'features' AS sw,
             row_number() OVER (PARTITION BY p.id ORDER BY e.created_at DESC, e.id) AS rn
      FROM page p
      CROSS JOIN LATERAL (SELECT x.id, x.config, x.created_at FROM event x WHERE x.organizer_id = p.id
                          ORDER BY x.created_at DESC, x.id LIMIT cap + 1) e),
    recent AS MATERIALIZED (SELECT l.org, l.ev, l.sw FROM latest l WHERE l.rn <= cap),
    sizes AS (
      SELECT l.org, count(*) FILTER (WHERE l.rn <= cap)::integer AS n, bool_or(l.rn > cap) AS more
      FROM latest l GROUP BY l.org),
    overrides AS (
      SELECT f.organizer_id AS org, jsonb_object_agg(f.feature, f.enabled) AS v
      FROM organizer_feature_override f JOIN page p ON p.id = f.organizer_id
      WHERE f.feature = ANY (feature_keys)
      GROUP BY f.organizer_id),
    switches AS (
      SELECT s.org, jsonb_object_agg(s.k, jsonb_build_object('on', s.n_on, 'off', s.n_off)) AS v
      FROM (SELECT r.org, kv.key AS k,
                   count(*) FILTER (WHERE kv.value = 'true'::jsonb)::integer AS n_on,
                   count(*) FILTER (WHERE kv.value = 'false'::jsonb)::integer AS n_off
            FROM recent r
            CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(r.sw) = 'object' THEN r.sw ELSE '{}'::jsonb END) kv
            WHERE kv.key = ANY (feature_keys)
            GROUP BY r.org, kv.key) s
      GROUP BY s.org),
    unlocked AS (
      SELECT u.org, jsonb_object_agg(u.k, u.n) AS v
      FROM (SELECT r.org, x.feature AS k, count(*)::integer AS n
            FROM recent r JOIN event_entitlement x ON x.event_id = r.ev
            WHERE x.feature = ANY (feature_keys)
            GROUP BY r.org, x.feature) u
      GROUP BY u.org),
    used AS (
      SELECT t.org, jsonb_object_agg(t.k, t.n) AS v
      FROM (SELECT p.id AS org, u.k, count(*) FILTER (WHERE u.yes)::integer AS n
            FROM page p
            LEFT JOIN recent r ON r.org = p.id
            CROSS JOIN LATERAL (VALUES
              ('agenda', EXISTS (SELECT 1 FROM event_session s WHERE s.event_id = r.ev)),
              ('bigScreen', EXISTS (SELECT 1 FROM paired_device d
                                    WHERE d.event_id = r.ev AND d.kind = 'screen' AND d.status = 'active')),
              ('boosts', EXISTS (SELECT 1 FROM boost b WHERE b.event_id = r.ev)),
              ('cheers', EXISTS (SELECT 1 FROM cheers_moment m WHERE m.event_id = r.ev)),
              ('community', EXISTS (SELECT 1 FROM community_goal g WHERE g.event_id = r.ev)),
              ('flashQuests', EXISTS (SELECT 1 FROM quest q WHERE q.event_id = r.ev AND q.flash)),
              ('helpDesk', EXISTS (SELECT 1 FROM ticket t WHERE t.event_id = r.ev)),
              ('maps', EXISTS (SELECT 1 FROM event_map m WHERE m.event_id = r.ev)),
              ('meetSomeone', EXISTS (SELECT 1 FROM quest q WHERE q.event_id = r.ev AND q.type = 'meet')),
              ('miniGames', EXISTS (SELECT 1 FROM quest q WHERE q.event_id = r.ev AND q.type = 'game')),
              ('polls', EXISTS (SELECT 1 FROM quest q
                                WHERE q.event_id = r.ev AND q.type = 'vote' AND q.type_config ? 'live')),
              ('questRatings', EXISTS (SELECT 1 FROM quest_rating q WHERE q.event_id = r.ev)),
              ('shareQuests', EXISTS (SELECT 1 FROM quest q WHERE q.event_id = r.ev AND q.type = 'share')),
              ('shop', EXISTS (SELECT 1 FROM reward w WHERE w.event_id = r.ev AND w.status = 'active'))
            ) u (k, yes)
            GROUP BY p.id, u.k) t
      GROUP BY t.org)
    SELECT jsonb_build_object('organizers', coalesce(jsonb_agg(jsonb_build_object(
             'id', p.id,
             'name', p.name,
             'slug', p.slug,
             'events', coalesce(z.n, 0),
             'more', coalesce(z.more, false),
             'overrides', coalesce(o.v, '{}'::jsonb),
             'switches', coalesce(w.v, '{}'::jsonb),
             'unlocked', coalesce(l.v, '{}'::jsonb),
             'using', coalesce(a.v, '{}'::jsonb))
           ORDER BY lower(p.name), p.id), '[]'::jsonb))
    FROM page p
    LEFT JOIN sizes z ON z.org = p.id
    LEFT JOIN overrides o ON o.org = p.id
    LEFT JOIN switches w ON w.org = p.id
    LEFT JOIN unlocked l ON l.org = p.id
    LEFT JOIN used a ON a.org = p.id);
END $$;

-- ================================================================ an offer replayed after it ran out (T-612)
-- As 0107, with one change: a key replayed after its offer's 2 minutes answers `expired`, as `desk_sale_state` does, not
-- `offered` with a past `offer_until`. The row keeps `offered`: an expired offer reads as expired and nothing is written.
CREATE OR REPLACE FUNCTION desk_offer_sale(target_event uuid, scanned uuid, scanned_version integer, target_reward uuid,
                                request_key text)
  RETURNS TABLE (sale_id uuid, status text, price integer, offer_until timestamptz, replayed boolean,
                 just_bought boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me       uuid := app_player_id();
  earlier  desk_sale%ROWTYPE;
  enrolled enrollment%ROWTYPE;
  ev       event%ROWTYPE;
  item     reward%ROWTYPE;
  hold     text;
  live     desk_sale%ROWTYPE;
BEGIN
  PERFORM ensure_rehearsal_wiped(target_event);
  PERFORM desk_operator(target_event, me);
  SELECT * INTO earlier FROM desk_sale s WHERE s.operator_id = me AND s.idempotency_key = request_key;
  IF FOUND THEN
    IF earlier.event_id <> target_event OR earlier.reward_id <> target_reward
       OR (SELECT n.player_id FROM enrollment n WHERE n.id = earlier.enrollment_id) IS DISTINCT FROM scanned THEN
      RAISE EXCEPTION 'this key was used for another offer' USING ERRCODE = 'RK422';
    END IF;
    RETURN QUERY SELECT earlier.id,
                        CASE WHEN earlier.status = 'offered' AND NOT desk_sale_live(earlier) THEN 'expired'
                             ELSE earlier.status END,
                        earlier.price, earlier.offer_until, true,
                        desk_just_bought(earlier.enrollment_id, earlier.reward_id);
    RETURN;
  END IF;
  enrolled := desk_scanned(target_event, me, scanned, scanned_version, true);
  SELECT * INTO ev FROM event e WHERE e.id = target_event;
  hold := desk_hold(enrolled, ev);
  IF hold IS NOT NULL THEN
    RAISE EXCEPTION 'the desk holds this player''s items' USING ERRCODE = 'RH409', DETAIL = hold;
  END IF;
  IF enrolled.status <> 'active' THEN
    RAISE EXCEPTION 'enrollment not active' USING ERRCODE = 'RA403', DETAIL = enrolled.status;
  END IF;
  SELECT * INTO item FROM reward r WHERE r.id = target_reward AND r.event_id = target_event AND r.status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reward not found' USING ERRCODE = 'RN404';
  END IF;
  IF item.kind NOT IN ('item', 'experience') THEN
    RAISE EXCEPTION 'a digital reward stays in the app' USING ERRCODE = 'DS422', DETAIL = 'not_desk_reward';
  END IF;
  IF ev.reservation_on THEN
    RAISE EXCEPTION 'this event reserves prizes' USING ERRCODE = 'DS409', DETAIL = 'reservation_on';
  END IF;
  IF NOT feature_enabled(ev, 'shop') THEN
    RAISE EXCEPTION 'the shop is switched off' USING ERRCODE = 'RS403', DETAIL = 'feature_off';
  END IF;
  IF play_phase(ev, enrolled) IS DISTINCT FROM 'rehearsal' AND desk_state(ev.desk_hours) <> 'open' THEN
    RAISE EXCEPTION 'the desk is closed' USING ERRCODE = 'RS403', DETAIL = 'desk_closed';
  END IF;

  SELECT s.* INTO live FROM desk_sale s
  -- `status = 'offered'` is repeated so the planner can use desk_sale_open (desk_sale_live hides it).
  WHERE s.enrollment_id = enrolled.id AND s.status = 'offered' AND desk_sale_live(s)
  ORDER BY s.created_at DESC LIMIT 1;
  IF FOUND AND live.operator_id <> me THEN
    RAISE EXCEPTION 'another desk is serving this player' USING ERRCODE = 'DS409', DETAIL = 'desk_busy';
  END IF;
  IF FOUND AND live.reward_id = target_reward THEN
    RETURN QUERY SELECT live.id, live.status, live.price, live.offer_until, true,
                        desk_just_bought(enrolled.id, target_reward);
    RETURN;
  END IF;
  IF FOUND THEN
    UPDATE desk_sale s SET status = 'withdrawn', ended_at = now() WHERE s.id = live.id;
  END IF;
  INSERT INTO desk_sale (organizer_id, event_id, enrollment_id, reward_id, operator_id, price, idempotency_key,
                         offer_until)
  VALUES (enrolled.organizer_id, target_event, enrolled.id, target_reward, me, item.price, request_key,
          now() + interval '2 minutes')
  RETURNING * INTO live;
  RETURN QUERY SELECT live.id, live.status, live.price, live.offer_until, false,
                      desk_just_bought(enrolled.id, target_reward);
END $$;

-- ================================================================ the event's currency word on a sale (T-612)
-- As 0107, with `currency`: the event's stored word, or NULL when it keeps the default. My QR is outside one event, so
-- without this the card named the price with the default word. The result type changes, so the function is replaced.
DROP FUNCTION my_desk_sales();
CREATE FUNCTION my_desk_sales()
  RETURNS TABLE (sale_id uuid, event_id uuid, event_name_ar text, event_name_en text, kind text, name_ar text,
                 name_en text, price integer, offer_until timestamptz, balance_after bigint, desk_location_ar text,
                 desk_location_en text, first_redemption boolean, rules_ar text, rules_en text, just_bought boolean,
                 currency jsonb)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.id, e.id, e.name_ar, e.name_en, r.kind, r.name_ar, r.name_en, s.price, s.offer_until, n.balance - s.price,
         e.desk_location_ar, e.desk_location_en, NOT EXISTS (SELECT 1 FROM redemption d WHERE d.enrollment_id = n.id),
         e.shop_rules_ar, e.shop_rules_en, desk_just_bought(n.id, s.reward_id), e.config -> 'terms' -> 'currency'
  FROM enrollment n
  JOIN desk_sale s ON s.enrollment_id = n.id AND s.status = 'offered' AND s.offer_until > now()
  JOIN reward r ON r.id = s.reward_id
  JOIN event e ON e.id = n.event_id
  WHERE n.player_id = app_player_id() AND n.status = 'active'
  ORDER BY s.created_at, s.id
$$;
REVOKE ALL ON FUNCTION my_desk_sales() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION my_desk_sales() TO questify_app;

-- ================================================================ the prizes a member holds (T-602d)
-- `my_redemptions` reads the newest 100 of any status, so an old held prize could fall off it. This reads the reserved ones
-- only, soonest deadline first, with no price and no code. It has no LIMIT on purpose: the same cut would hide a prize again,
-- and a member's reserved rows in one event are held down by stock and points. Same seat rule as `my_redemptions`: the
-- caller's own rows, bound to the session.
CREATE FUNCTION my_held_prizes(target uuid)
  RETURNS TABLE (id uuid, kind text, name_ar text, name_en text, reserved_until timestamptz, collect_until timestamptz,
                 rank integer, source text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT d.id, coalesce(r.kind, k.kind, 'item'), coalesce(r.name_ar, k.name_ar, i.name_ar),
         coalesce(r.name_en, k.name_en, i.name_en), d.reserved_until,
         CASE WHEN d.collect_until > now() THEN d.collect_until END, x.rank, redemption_source(d)
  FROM enrollment n JOIN redemption d ON d.enrollment_id = n.id LEFT JOIN reward r ON r.id = d.reward_id
  LEFT JOIN rank_prize k ON k.id = d.rank_prize_id LEFT JOIN quest_item i ON i.id = d.quest_item_id
  LEFT JOIN result_place x ON x.redemption_id = d.id
  WHERE n.event_id = target AND n.player_id = app_player_id() AND d.status = 'reserved'
  ORDER BY d.reserved_until NULLS LAST, d.id
$$;
REVOKE ALL ON FUNCTION my_held_prizes(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION my_held_prizes(uuid) TO questify_app;

-- ================================================================ one alert per event per window (T-503)
-- As 0082, with two changes. A member gets one `new_flags` alert for an event in each 15-minute window of `raised_at`, not
-- one per flag: the key is the event and the window, so a flag seen again, or another in the same window, writes nothing.
-- And `lim` now counts those event windows, newest first, so a storm in one event no longer starves the others and the
-- newest flags are not left behind the oldest. The look-back still bounds the read. A rehearsal account's flag raises none.
CREATE OR REPLACE FUNCTION alert_scan_flags(lim integer) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  made integer;
BEGIN
  PERFORM push_system_only();
  SELECT coalesce(sum(alert_enqueue(f.organizer_id, f.event_id, 'new_flags', 'flags:' || f.event_id || ':' || f.slot)),
                  0)::integer
  INTO made
  FROM (SELECT x.organizer_id, x.event_id, floor(extract(epoch FROM x.raised_at) / 900)::bigint AS slot
        FROM flag x
        JOIN enrollment n ON n.id = x.enrollment_id AND n.joined_via IS DISTINCT FROM 'rehearsal'
        WHERE x.raised_at > now() - interval '15 minutes'
        GROUP BY x.organizer_id, x.event_id, 3
        ORDER BY max(x.raised_at) DESC, x.event_id, 3
        LIMIT least(greatest(alert_scan_flags.lim, 0), 2000)) f;
  RETURN made;
END $$;

-- ================================================================ a second index on an organizer's events (batch 4 review)
-- Every organizer-led read of `event` is served by `event_organizer_created_idx` (0162). `status` is what this index adds, and
-- only two statements filter on both: `team.ts`'s `status <> 'draft'`, which it never narrowed, and the trigger
-- `mark_ranking_on_member`, which runs when a team member is added or removed and goes from about 0.2 ms to about 16 ms at an
-- organizer's 10,000 events. In exchange a status change stops writing to this index on every event's lifecycle step.
DROP INDEX event_organizer_idx;
