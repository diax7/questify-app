-- The event's analytics (T-607, FR-1201 to FR-1205, FR-1625, ADR-392): participation with the join source, quests with
-- the category funnels, and the rewards and points. Read-only: no table, no write, nothing about points changes. Each
-- is a door for the event's team (an owner or an editor within their event limit, AN404 for anyone else, as the
-- control room's reads in 0096); a player, another organizer's team and the public key reach none. Deny by default:
-- PUBLIC holds no EXECUTE, the grant names the API's role alone.
--
-- Only counts leave the database: never a player, an enrollment, a name or a time of one person (FR-1203 also forbids
-- time spent and a heatmap, and nothing here measures either). Nothing here scans the points record: participation
-- reads the event's enrollments (one index probe per player into `quest_completion`), the quests read the index of
-- first completions made in 0096, and the economy reads the enrollments' score cache and the rewards' redemptions.
-- Two small reads of it are bounded by something other than the players: the removals the team made (found through
-- the event's `ledger_note` rows; a bulk award's notes carry a bulk id and are skipped, a removal's never do) and one
-- probe per standing redemption (`ledger_entry_redeem_key`).
-- Rehearsal accounts are counted like any enrollment while they exist, and the answer says so (`rehearsal`), so the
-- page can mark the figures "Rehearsal, wiped at go-live" (T-211).
SET LOCAL lock_timeout = '10s';

-- Participation (FR-1201, FR-1202, FR-1625). Joined is every enrollment that was ever a member (not pending or
-- declined), so the join sources add up to it and the active count never passes it. Active is a player with at least
-- one completion; activation is active divided by joined as a whole percent (NULL when nobody joined). Returning is a
-- player with a completion on two or more event days, read from `event_streak_day` (one row per open event day with a
-- completion), so a one-day event has none. The series is the running count of joined players by the time they joined,
-- in the event's zone: by hour for a span of up to two days, by day up to 90 days, else by week. A completion whose
-- award the team removed (a `removal` entry of the event, which names the completion) does not make a player active;
-- a player whose other completion stands still does. The count of players with a completion is read without touching
-- the completions' rows (an index-only probe per player); the few whose completions were all removed are taken off it.
CREATE FUNCTION analytics_participation(target_event uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
  members record;
  unit text;
  series jsonb;
  returning_players integer;
  idle integer;
  active_players integer;
BEGIN
  WITH removed AS MATERIALIZED (
    SELECT x.completion_id FROM ledger_note t JOIN ledger_entry x ON x.id = t.entry_id
    WHERE t.event_id = ev.id AND t.bulk_id IS NULL AND x.kind = 'removal' AND x.completion_id IS NOT NULL)
  SELECT count(*)::integer INTO idle
  FROM (SELECT DISTINCT c.enrollment_id FROM quest_completion c
        WHERE c.id IN (SELECT r.completion_id FROM removed r)) g
  JOIN enrollment m ON m.id = g.enrollment_id AND m.status NOT IN ('pending', 'declined')
  WHERE NOT EXISTS (SELECT 1 FROM quest_completion o WHERE o.enrollment_id = g.enrollment_id
                    AND o.id NOT IN (SELECT r.completion_id FROM removed r));

  SELECT count(*)::integer AS joined,
         count(*) FILTER (WHERE EXISTS (SELECT 1 FROM quest_completion c WHERE c.enrollment_id = n.id))::integer AS active,
         min(n.joined_at) AS first_at, max(n.joined_at) AS last_at,
         bool_or(n.joined_via = 'rehearsal') AS rehearsal,
         jsonb_build_object(
           'code', count(*) FILTER (WHERE n.joined_via = 'code'),
           'qr', count(*) FILTER (WHERE n.joined_via = 'qr'),
           'link', count(*) FILTER (WHERE n.joined_via = 'link'),
           'public_list', count(*) FILTER (WHERE n.joined_via = 'public_list'),
           'invite', count(*) FILTER (WHERE n.joined_via = 'invite'),
           'operator', count(*) FILTER (WHERE n.joined_via = 'operator'),
           'rehearsal', count(*) FILTER (WHERE n.joined_via = 'rehearsal'),
           'other', count(*) FILTER (WHERE n.joined_via IS NULL)) AS sources
  INTO members
  FROM enrollment n WHERE n.event_id = ev.id AND n.status NOT IN ('pending', 'declined');

  unit := CASE WHEN members.last_at - members.first_at <= interval '2 days' THEN 'hour'
               WHEN members.last_at - members.first_at <= interval '90 days' THEN 'day'
               ELSE 'week' END;
  SELECT coalesce(jsonb_agg(jsonb_build_object('at', to_char(b.bucket, 'YYYY-MM-DD"T"HH24:MI'), 'joined', b.total)
                            ORDER BY b.bucket), '[]'::jsonb)
  INTO series
  FROM (SELECT g.bucket, (sum(g.members) OVER (ORDER BY g.bucket))::integer AS total
        FROM (SELECT date_trunc(unit, n.joined_at AT TIME ZONE ev.timezone) AS bucket, count(*) AS members
              FROM enrollment n WHERE n.event_id = ev.id AND n.status NOT IN ('pending', 'declined')
              GROUP BY 1) g) b;

  SELECT count(*)::integer INTO returning_players
  FROM (SELECT d.enrollment_id FROM event_streak_day d WHERE d.event_id = ev.id
        GROUP BY d.enrollment_id HAVING count(*) >= 2) r;

  active_players := members.active - idle;
  RETURN jsonb_build_object(
    'joined', members.joined,
    'active', active_players,
    'activation', CASE WHEN members.joined = 0 THEN NULL ELSE round(100.0 * active_players / members.joined)::integer END,
    'returning', returning_players,
    'rehearsal', coalesce(members.rehearsal, false),
    'unit', unit,
    'series', series,
    'sources', members.sources);
END $$;
REVOKE ALL ON FUNCTION analytics_participation(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION analytics_participation(uuid) TO questify_app;

-- Quests and categories (FR-1204): for every visible quest, the players who completed it at least once, grouped by
-- category in the builder's order, with the joined count the rates are taken over. `step` says whether the quest takes
-- part in a category's order (a flash quest or a live poll does not, as in `category_rule_lock`) and `skipped` that a
-- team member skipped it (T-603b); the funnel of an in-order category is drawn from these. A category's quests that
-- nobody completed carry 0. A first completion whose award the team removed does not count, unless the same player
-- has a later completion of the quest that stands; the first completions are counted from their index alone, and the
-- few removed ones are taken off.
CREATE FUNCTION analytics_quests(target_event uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
  joined integer;
BEGIN
  SELECT count(*)::integer INTO joined
  FROM enrollment n WHERE n.event_id = ev.id AND n.status NOT IN ('pending', 'declined');
  RETURN (
    WITH removed AS MATERIALIZED (
      SELECT x.completion_id FROM ledger_note t JOIN ledger_entry x ON x.id = t.entry_id
      WHERE t.event_id = ev.id AND t.bulk_id IS NULL AND x.kind = 'removal' AND x.completion_id IS NOT NULL),
    done AS MATERIALIZED (
      SELECT c.quest_id, count(*)::integer AS players FROM quest_completion c
      WHERE c.event_id = ev.id AND c.occurrence = 1 GROUP BY c.quest_id),
    lost AS MATERIALIZED (
      SELECT c.quest_id, count(*)::integer AS players FROM quest_completion c
      WHERE c.id IN (SELECT r.completion_id FROM removed r) AND c.occurrence = 1
        AND NOT EXISTS (SELECT 1 FROM quest_completion o
                        WHERE o.enrollment_id = c.enrollment_id AND o.quest_id = c.quest_id AND o.occurrence > 1
                          AND o.id NOT IN (SELECT r.completion_id FROM removed r))
      GROUP BY c.quest_id)
    SELECT jsonb_build_object(
      'joined', joined,
      'categories', coalesce(jsonb_agg(jsonb_build_object(
        'id', c.id,
        'name', jsonb_build_object('ar', c.name_ar, 'en', c.name_en),
        'inOrder', c.order_mode = 'in_order',
        'quests', coalesce((
          SELECT jsonb_agg(jsonb_build_object(
            'id', q.id,
            'title', jsonb_build_object('ar', q.title_ar, 'en', q.title_en),
            'done', coalesce(d.players, 0) - coalesce(l.players, 0),
            'step', NOT q.flash AND NOT is_live_poll(q.type, q.type_config),
            'skipped', q.skipped_at IS NOT NULL) ORDER BY q.position, q.id)
          FROM quest q LEFT JOIN done d ON d.quest_id = q.id LEFT JOIN lost l ON l.quest_id = q.id
          WHERE q.category_id = c.id AND q.visible AND q.deleted_at IS NULL), '[]'::jsonb)
      ) ORDER BY c.position, c.id), '[]'::jsonb))
    FROM category c WHERE c.event_id = ev.id);
END $$;
REVOKE ALL ON FUNCTION analytics_quests(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION analytics_quests(uuid) TO questify_app;

-- Rewards and points (FR-1205). `earned` is the players' points total (the score cache, which is the exact sum of the
-- points record), plus the score each standing redemption took when it was made: its own `redeem` entry in the points
-- record, one probe of `ledger_entry_redeem_key`. Only a purchase made while the event was live takes score (with
-- `spend_lowers_rank`); one made after the end moves the balance alone (ADR-135), so it adds nothing back. A spend
-- never reads as points not earned. `spent` is the price of every reward redemption that still stands (reserved,
-- delivered or handed over; a cancelled or timed-out one gave its points back). `unclaimed` counts the event's
-- reservations nobody has picked up, of every kind. Each reward lists its standing redemptions, its reservations
-- still waiting and the stock left; a removed reward only when something was redeemed from it.
CREATE FUNCTION analytics_economy(target_event uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
  score_total bigint;
  spent bigint;
  lowered bigint;
  unclaimed integer;
  rewards jsonb;
BEGIN
  SELECT coalesce(sum(n.score), 0) INTO score_total FROM enrollment n WHERE n.event_id = ev.id;
  SELECT count(*)::integer INTO unclaimed FROM redemption r WHERE r.event_id = ev.id AND r.status = 'reserved';
  SELECT coalesce(sum(x.spent), 0), coalesce(sum(x.lowered), 0), coalesce(jsonb_agg(jsonb_build_object(
           'id', x.id,
           'name', jsonb_build_object('ar', x.name_ar, 'en', x.name_en),
           'price', x.price,
           'redeemed', x.redeemed,
           'unclaimed', x.waiting,
           'stockLeft', x.stock_left,
           'removed', x.removed) ORDER BY x.redeemed DESC, x.position, x.id), '[]'::jsonb)
  INTO spent, lowered, rewards
  FROM (SELECT rw.id, rw.name_ar, rw.name_en, rw.price, rw.position, rw.status = 'removed' AS removed,
               rw.stock_total - rw.units_out AS stock_left,
               count(r.id) FILTER (WHERE r.status IN ('reserved', 'delivered', 'handed_over'))::integer AS redeemed,
               count(r.id) FILTER (WHERE r.status = 'reserved')::integer AS waiting,
               coalesce(sum(r.price) FILTER (WHERE r.status IN ('reserved', 'delivered', 'handed_over')), 0) AS spent,
               coalesce(sum(-p.score_delta) FILTER (WHERE r.status IN ('reserved', 'delivered', 'handed_over')), 0) AS lowered
        FROM reward rw LEFT JOIN redemption r ON r.reward_id = rw.id
          LEFT JOIN ledger_entry p ON p.redemption_id = r.id AND p.kind = 'redeem'
        WHERE rw.event_id = ev.id
        GROUP BY rw.id
        HAVING rw.status = 'active' OR count(r.id) FILTER (WHERE r.status IN ('reserved', 'delivered', 'handed_over')) > 0) x;
  RETURN jsonb_build_object(
    'earned', score_total + lowered,
    'spent', spent,
    'unclaimed', unclaimed,
    'rewards', rewards);
END $$;
REVOKE ALL ON FUNCTION analytics_economy(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION analytics_economy(uuid) TO questify_app;
