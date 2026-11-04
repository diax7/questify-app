-- T-804a part A: the completion path's non-inlinable LANGUAGE sql functions become plpgsql (ADR-670; plan
-- docs/plans/2026-11-04-t-804a-completion-hot-path.md; Q-620, Q-632). PostgreSQL 16 and 17 plan every statement of a
-- LANGUAGE sql function that cannot be inlined (SECURITY DEFINER, a SET clause, a sub-select or a set result) on every
-- call; plpgsql keeps the plan per connection. Measured on the T-804 seed: 33.5 ms of database time a completion before.
--
-- The list is the profile's (2,000 QR completions, pg_stat_user_functions, 2026-11-04): every LANGUAGE sql function the
-- completion and the player guard call once or more per completion, so none of them is inlined anywhere on the path.
-- (1) 35 functions become plpgsql, one CREATE OR REPLACE each. (2) The six standard-body (BEGIN ATOMIC) functions on the
-- path, event_day, event_day_start, event_multi_day, questify_day, questify_month and streak_day_closed (event_day alone
-- is called 18 times a completion), stay SQL and lose their SET search_path, so PostgreSQL inlines them into the
-- calling statement (docs/rules.md, ADR-354 (5)): none is SECURITY DEFINER, and a standard body binds every name when it
-- is created, so the setting changed nothing at run time. Named in the plan but not called per completion (ticks and
-- reads only), so not touched: ranking_system, ranking_on, platform_feature_on, feature_enabled.
--
-- Behaviour kept, rule by rule: CREATE OR REPLACE with the same argument types keeps each function's OID, owner, ACL
-- and dependants; the header restates SECURITY DEFINER, SET search_path, volatility, strictness and the result word
-- for word (pg_get_functiondef of 0147); only LANGUAGE and the body change. `#variable_conflict use_column` makes a
-- column win over a same-named argument, as in a SQL function. A scalar is `SELECT answer_row.v INTO found_value FROM
-- (<the old query>) AS answer_row(v)`: the first row, NULL on none, never an error on two rows. A set is RETURN QUERY
-- of the old query. boost_in_force and quest_boost return NULL (not a row of NULLs) when no boost is in force;
-- flag_tuning fills its OUT columns from the same one-row select; levels_reach keeps its one data-modifying WITH,
-- ending in SELECT ... INTO. No table, trigger, index, policy or grant changes; the ledger stays append-only.
--
-- Checked by test/db/hot-path-plpgsql.int.test.ts against hot-path-plpgsql.fixture.json (each function's 0147
-- attributes and original CREATE statement): attributes equal, every function called, and each answer equal to the
-- old SQL body's on the same arguments; the six inlined functions keep their standard body and no setting. Rollback: a
-- forward migration made of the fixture's `definition` values plus `ALTER FUNCTION ... SET search_path = public, pg_temp`
-- for the six.
--
-- Catalog only: CREATE OR REPLACE and ALTER FUNCTION take no table lock and do not wait for running calls (a call that
-- started keeps the old body). Signatures unchanged, so the running API works before and after.
SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION public.boost_in_force(target_category uuid, enrolled enrollment, at timestamp with time zone)
 RETURNS boost
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  found_boost boost;
BEGIN
  SELECT b.* INTO found_boost FROM boost b JOIN event e ON e.id = b.event_id
  WHERE b.category_id = target_category AND b.starts_at <= at AND b.ends_at > at
    AND b.rehearsal = (enrolled.joined_via IS NOT DISTINCT FROM 'rehearsal') AND boosts_on(e)
  ORDER BY b.starts_at DESC
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  RETURN found_boost;
END
$function$;

CREATE OR REPLACE FUNCTION public.category_community_lock(target uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  found_value uuid;
BEGIN
  SELECT answer_row.v INTO found_value FROM (
    SELECT s.id FROM community_step s
    WHERE s.unlock_category_id = target AND NOT EXISTS (SELECT 1 FROM community_reach r WHERE r.step_id = s.id)
  ) AS answer_row(v);
  RETURN found_value;
END
$function$;

CREATE OR REPLACE FUNCTION public.category_lock(quest_row quest, member uuid)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  found_value text;
BEGIN
  SELECT answer_row.v INTO found_value FROM (
    SELECT CASE WHEN quest_community_lock(quest_row) IS NOT NULL THEN 'community_locked'
                ELSE category_rule_lock(quest_row, member) END
  ) AS answer_row(v);
  RETURN found_value;
END
$function$;

CREATE OR REPLACE FUNCTION public.category_period_start(cat category, ev event)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  found_value timestamp with time zone;
BEGIN
  SELECT answer_row.v INTO found_value FROM (
    SELECT CASE cat.refresh
             WHEN 'daily' THEN event_day_start(ev, d.today)
             WHEN 'weekly' THEN event_day_start(ev, d.first + 7 * floor((d.today - d.first) / 7.0)::integer)
             ELSE '-infinity'::timestamptz
           END
    FROM (SELECT event_day(now(), ev) AS today, event_day(coalesce(ev.starts_at, ev.created_at), ev) AS first) d
  ) AS answer_row(v);
  RETURN found_value;
END
$function$;

CREATE OR REPLACE FUNCTION public.completion_boost(completion bigint)
 RETURNS integer
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  found_value integer;
BEGIN
  SELECT answer_row.v INTO found_value FROM (
    SELECT b.multiplier
    FROM ledger_entry l
    JOIN enrollment n ON n.id = l.enrollment_id AND n.player_id = app_player_id()
    JOIN boost b ON b.id = l.boost_id
    WHERE l.completion_id = completion AND l.kind = 'quest'
  ) AS answer_row(v);
  RETURN found_value;
END
$function$;

CREATE OR REPLACE FUNCTION public.daily_streak_on()
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  found_value boolean;
BEGIN
  SELECT answer_row.v INTO found_value FROM (
    SELECT coalesce((SELECT s.value -> 'dailyStreak' -> 'enabled' <> 'false'::jsonb
                     FROM platform_setting s WHERE s.key = 'features'), true)
  ) AS answer_row(v);
  RETURN found_value;
END
$function$;

CREATE OR REPLACE FUNCTION public.event_suspended(target uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  found_value boolean;
BEGIN
  SELECT answer_row.v INTO found_value FROM (
    SELECT EXISTS (SELECT 1 FROM event e JOIN organizer o ON o.id = e.organizer_id
                   WHERE e.id = target AND (e.suspended_at IS NOT NULL OR o.status = 'paused'))
  ) AS answer_row(v);
  RETURN found_value;
END
$function$;

CREATE OR REPLACE FUNCTION public.excluded_from_event(target_event uuid, target_player uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
AS $function$
#variable_conflict use_column
DECLARE
  found_value boolean;
BEGIN
  SELECT answer_row.v INTO found_value FROM (
    SELECT EXISTS (
      SELECT 1 FROM player_contact pc JOIN event_exclusion x ON x.event_id = target_event
      WHERE pc.player_id = target_player
        AND ((x.kind = 'phone' AND x.value = pc.phone_e164)
             OR (x.kind = 'email_domain' AND x.value = split_part(pc.email, '@', 2))))
  ) AS answer_row(v);
  RETURN found_value;
END
$function$;

CREATE OR REPLACE FUNCTION public.flag_tuning(OUT burst_count integer, OUT burst_window interval)
 RETURNS record
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
BEGIN
  SELECT platform_tuning_int('flagBurstCount', 10, 3, 100),
         platform_tuning_int('flagBurstMinutes', 5, 1, 60) * interval '1 minute'
  INTO burst_count, burst_window;
END
$function$;

CREATE OR REPLACE FUNCTION public.is_review_demo_player(target uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  found_value boolean;
BEGIN
  SELECT answer_row.v INTO found_value FROM (
    SELECT EXISTS (SELECT 1 FROM review_demo_player r WHERE r.player_id = target)
  ) AS answer_row(v);
  RETURN found_value;
END
$function$;

CREATE OR REPLACE FUNCTION public.legal_in_force_rows()
 RETURNS TABLE(id bigint, document text, version text, published_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  SELECT DISTINCT ON (v.document) v.id, v.document, v.version, v.published_at
  FROM legal_version v ORDER BY v.document, legal_version_key(v.version) DESC;
END
$function$;

CREATE OR REPLACE FUNCTION public.legal_version_key(version text)
 RETURNS integer[]
 LANGUAGE plpgsql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  found_value integer[];
BEGIN
  SELECT answer_row.v INTO found_value FROM (
    SELECT parts || array_fill(0, ARRAY[3 - cardinality(parts)])
    FROM (SELECT string_to_array(version, '.')::integer[] AS parts) p
  ) AS answer_row(v);
  RETURN found_value;
END
$function$;

CREATE OR REPLACE FUNCTION public.level_title_of(target smallint)
 RETURNS TABLE(name_ar text, name_en text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  SELECT t.name_ar, t.name_en FROM level_title t WHERE t.level_from <= target ORDER BY t.level_from DESC LIMIT 1;
END
$function$;

CREATE OR REPLACE FUNCTION public.levels_reach(who uuid, made bigint, total bigint)
 RETURNS smallint[]
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  found_value smallint[];
BEGIN
  WITH due AS MATERIALIZED (
    SELECT l.level FROM xp_level l
    WHERE l.level > 1 AND l.xp_from <= total
      AND NOT EXISTS (SELECT 1 FROM level_reached r WHERE r.player_id = who AND r.level = l.level)
    ORDER BY l.level
    FOR KEY SHARE OF l
  ), written AS (
    INSERT INTO level_reached (player_id, level, xp_entry_id)
    SELECT who, d.level, made FROM due d ORDER BY d.level
    ON CONFLICT DO NOTHING
    RETURNING level
  )
  SELECT coalesce(array_agg(w.level ORDER BY w.level), '{}'::smallint[]) INTO found_value FROM written w;
  RETURN found_value;
END
$function$;

CREATE OR REPLACE FUNCTION public.organizer_team_players(org uuid)
 RETURNS SETOF uuid
 LANGUAGE plpgsql
 STABLE
AS $function$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  SELECT pc.player_id FROM organizer_member m
  JOIN staff_user s ON s.id = m.staff_user_id
  JOIN player_contact pc ON pc.email = s.email
  WHERE m.organizer_id = org;
END
$function$;

CREATE OR REPLACE FUNCTION public.own_bonus(completion bigint)
 RETURNS TABLE(category_id uuid, points bigint, name_ar text, name_en text, item_ar text, item_en text, item_outcome text, item_until timestamp with time zone, item_time_zone text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  SELECT b.category_id, coalesce(l.score_delta, 0), c.name_ar, c.name_en, i.name_ar, i.name_en,
         CASE WHEN d.id IS NOT NULL THEN 'pending' ELSE m.reason END, d.reserved_until,
         (SELECT x.timezone FROM event x WHERE x.id = b.event_id)
  FROM category_bonus b
  JOIN enrollment n ON n.id = b.enrollment_id AND n.player_id = app_player_id()
  LEFT JOIN ledger_entry l ON l.id = b.entry_id
  JOIN category c ON c.id = b.category_id
  LEFT JOIN redemption d ON d.enrollment_id = b.enrollment_id AND d.source_category_id = b.category_id
    AND d.source_period = b.period_start AND d.quest_item_id IS NOT NULL
  LEFT JOIN quest_item_miss m ON m.enrollment_id = b.enrollment_id AND m.source_category_id = b.category_id
    AND m.source_period = b.period_start
  LEFT JOIN quest_item i ON i.id = coalesce(d.quest_item_id, m.quest_item_id)
  WHERE b.completion_id = completion;
END
$function$;

CREATE OR REPLACE FUNCTION public.own_first_bonus(completion bigint)
 RETURNS TABLE(points integer, place integer, slots integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  SELECT coalesce(l.score_delta::integer, b.points),
         CASE WHEN s.quest_id IS NOT NULL THEN first_bonus_place(s) END,
         b.slots
  FROM quest_completion c
  JOIN enrollment n ON n.id = c.enrollment_id AND n.player_id = app_player_id()
  JOIN quest_first_bonus b ON b.quest_id = c.quest_id
  LEFT JOIN quest_bonus_slot s ON s.completion_id = c.id
  LEFT JOIN ledger_entry l ON l.id = s.entry_id
  WHERE c.id = completion AND (s.quest_id IS NOT NULL OR (c.occurrence = 1 AND c.method <> 'manual'));
END
$function$;

CREATE OR REPLACE FUNCTION public.own_level(completion bigint)
 RETURNS TABLE(xp bigint, level smallint, level_from bigint, next_level_at bigint, title_ar text, title_en text, level_up smallint, up_title_ar text, up_title_en text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  SELECT x.xp, cur.level, cur.xp_from, nxt.xp_from, t.name_ar, t.name_en, up.level, ut.name_ar, ut.name_en
  FROM player_xp x
  JOIN player p ON p.id = x.player_id AND p.status = 'active'
  JOIN xp_level cur ON cur.level = xp_level_of(x.xp)
  LEFT JOIN xp_level nxt ON nxt.level = cur.level + 1
  LEFT JOIN LATERAL level_title_of(cur.level) t ON true
  LEFT JOIN LATERAL (SELECT max(r.level) AS level FROM level_reached r
                     JOIN xp_entry e ON e.id = r.xp_entry_id
                     JOIN ledger_entry l ON l.id = e.ledger_entry_id
                     WHERE r.player_id = x.player_id AND l.completion_id = completion AND l.kind = 'quest') up ON true
  LEFT JOIN LATERAL level_title_of(up.level) ut ON true
  WHERE x.player_id = app_player_id();
END
$function$;

CREATE OR REPLACE FUNCTION public.own_quest_item(completion bigint)
 RETURNS TABLE(name_ar text, name_en text, outcome text, until timestamp with time zone, time_zone text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  SELECT i.name_ar, i.name_en, CASE WHEN d.id IS NOT NULL THEN 'pending' ELSE m.reason END, d.reserved_until,
         e.timezone
  FROM quest_completion c
  JOIN enrollment n ON n.id = c.enrollment_id AND n.player_id = app_player_id()
  JOIN event e ON e.id = c.event_id
  LEFT JOIN redemption d ON d.source_completion_id = c.id AND d.quest_item_id IS NOT NULL
  LEFT JOIN quest_item_miss m ON m.source_completion_id = c.id
  JOIN quest_item i ON i.id = coalesce(d.quest_item_id, m.quest_item_id)
  WHERE c.id = completion;
END
$function$;

CREATE OR REPLACE FUNCTION public.own_streak_bonus(completion bigint)
 RETURNS TABLE(points integer, days integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  SELECT l.score_delta::integer, d.days
  FROM event_streak_day d
  JOIN enrollment n ON n.id = d.enrollment_id AND n.player_id = app_player_id()
  JOIN ledger_entry l ON l.id = d.entry_id
  WHERE d.completion_id = completion;
END
$function$;

CREATE OR REPLACE FUNCTION public.period_count(member uuid, quest_row quest)
 RETURNS integer
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  found_value integer;
BEGIN
  SELECT answer_row.v INTO found_value FROM (
    SELECT count(*)::integer FROM quest_completion c
    WHERE c.enrollment_id = member AND c.quest_id = quest_row.id
      AND c.created_at >= (SELECT category_period_start(g, e) FROM category g JOIN event e ON e.id = g.event_id
                           WHERE g.id = quest_row.category_id)
  ) AS answer_row(v);
  RETURN found_value;
END
$function$;

CREATE OR REPLACE FUNCTION public.platform_tuning_int(key_name text, fallback integer, low integer, high integer)
 RETURNS integer
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  found_value integer;
BEGIN
  SELECT answer_row.v INTO found_value FROM (
    SELECT coalesce((
      SELECT CASE WHEN jsonb_typeof(s.value -> key_name) = 'number' AND (s.value ->> key_name) ~ '^[0-9]{1,9}$'
                  THEN CASE WHEN (s.value ->> key_name)::integer BETWEEN low AND high
                            THEN (s.value ->> key_name)::integer END
             END
      FROM platform_setting s WHERE s.key = 'tuning'), fallback)
  ) AS answer_row(v);
  RETURN found_value;
END
$function$;

CREATE OR REPLACE FUNCTION public.play_phase(ev event, enrolled enrollment)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  found_value text;
BEGIN
  SELECT answer_row.v INTO found_value FROM (
    SELECT CASE
      WHEN enrolled.joined_via = 'rehearsal' THEN
        CASE WHEN event_status_now(ev.status, ev.starts_at, ev.ends_at) IN ('draft', 'scheduled') THEN 'rehearsal' END
      WHEN event_status_now(ev.status, ev.starts_at, ev.ends_at) = 'live' THEN 'live'
    END
  ) AS answer_row(v);
  RETURN found_value;
END
$function$;

CREATE OR REPLACE FUNCTION public.player_legal_held(p uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  found_value boolean;
BEGIN
  SELECT answer_row.v INTO found_value FROM (
    SELECT EXISTS (
      SELECT 1 FROM legal_in_force_rows() f
      WHERE f.document IN ('terms_of_use', 'privacy_policy')
        AND EXISTS (SELECT 1 FROM player_acceptance a WHERE a.player_id = p AND a.document = f.document)
        AND NOT EXISTS (SELECT 1 FROM player_acceptance a
                        WHERE a.player_id = p AND a.document = f.document AND a.version = f.version))
  ) AS answer_row(v);
  RETURN found_value;
END
$function$;

CREATE OR REPLACE FUNCTION public.player_session_owner(hash bytea)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  found_value uuid;
BEGIN
  SELECT answer_row.v INTO found_value FROM (
    SELECT s.player_id FROM player_session s JOIN player p ON p.id = s.player_id
    WHERE s.token_hash = hash AND s.revoked_at IS NULL AND s.expires_at > now() AND p.status = 'active'
      AND s.created_at > coalesce(p.tokens_valid_after, '-infinity'::timestamptz)
  ) AS answer_row(v);
  RETURN found_value;
END
$function$;

CREATE OR REPLACE FUNCTION public.quest_boost(quest_row quest, enrolled enrollment, at timestamp with time zone)
 RETURNS boost
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
BEGIN
  RETURN boost_in_force(quest_row.category_id, enrolled, at);
END
$function$;

CREATE OR REPLACE FUNCTION public.quest_community_lock(quest_row quest)
 RETURNS uuid
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  found_value uuid;
BEGIN
  SELECT answer_row.v INTO found_value FROM (
    SELECT coalesce(
      (SELECT s.id FROM community_step s
       WHERE s.unlock_quest_id = quest_row.id AND NOT EXISTS (SELECT 1 FROM community_reach r WHERE r.step_id = s.id)),
      category_community_lock(quest_row.category_id))
  ) AS answer_row(v);
  RETURN found_value;
END
$function$;

CREATE OR REPLACE FUNCTION public.quest_xp()
 RETURNS integer
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  found_value integer;
BEGIN
  SELECT answer_row.v INTO found_value FROM (
    SELECT coalesce((SELECT CASE WHEN s.value ->> 'questXp' ~ '^[1-9][0-9]{0,4}$'
                                 THEN (s.value ->> 'questXp')::integer END
                     FROM platform_setting s WHERE s.key = 'xp'), 100)
  ) AS answer_row(v);
  RETURN found_value;
END
$function$;

CREATE OR REPLACE FUNCTION public.ranking_day_entry_of(completion bigint)
 RETURNS TABLE(event_id uuid, day date, enrollment_id uuid, score bigint, score_version bigint, ranked boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  WITH mine AS (
    SELECT e, ev, event_day(c.created_at, ev) AS day
    FROM quest_completion c
    JOIN enrollment e ON e.id = c.enrollment_id
    JOIN event ev ON ev.id = e.event_id
    WHERE c.id = completion AND e.player_id = app_player_id() AND event_multi_day(ev)
  )
  SELECT (m.e).event_id, m.day, (m.e).id, t.score, t.version, ranking_eligible(m.e) AND t.score > 0
  FROM mine m,
  LATERAL (SELECT coalesce(sum(l.score_delta), 0)::bigint AS score, max(l.id) AS version
           FROM ledger_entry l
           WHERE l.enrollment_id = (m.e).id AND l.score_delta <> 0
             AND l.created_at >= event_day_start(m.ev, m.day)
             AND l.created_at < event_day_start(m.ev, m.day + 1)) t
  WHERE t.version IS NOT NULL;
END
$function$;

CREATE OR REPLACE FUNCTION public.ranking_eligible(target enrollment)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
AS $function$
#variable_conflict use_column
DECLARE
  found_value boolean;
BEGIN
  SELECT answer_row.v INTO found_value FROM (
    SELECT target.status = 'active' AND target.score > 0 AND target.score_version IS NOT NULL
      AND EXISTS (SELECT 1 FROM player p WHERE p.id = target.player_id AND p.status = 'active')
      AND target.player_id NOT IN (SELECT organizer_team_players(target.organizer_id))
      AND NOT excluded_from_event(target.event_id, target.player_id)
      AND NOT EXISTS (SELECT 1 FROM staff_assignment sa
                      WHERE sa.event_id = target.event_id AND sa.player_id = target.player_id)
  ) AS answer_row(v);
  RETURN found_value;
END
$function$;

CREATE OR REPLACE FUNCTION public.ranking_entry_of(completion bigint)
 RETURNS TABLE(event_id uuid, enrollment_id uuid, score bigint, score_version bigint, ranked boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  SELECT e.event_id, e.id, e.score, e.score_version, ranking_eligible(e)
  FROM quest_completion c JOIN enrollment e ON e.id = c.enrollment_id
  WHERE c.id = completion AND e.player_id = app_player_id();
END
$function$;

CREATE OR REPLACE FUNCTION public.reviewer_paid(method text, completion_key text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  found_value boolean;
BEGIN
  SELECT answer_row.v INTO found_value FROM (
    SELECT method = 'submission' AND completion_key ~ '^sub:[0-9]{1,18}$' AND EXISTS (
      SELECT 1 FROM submission s WHERE s.id = substr(completion_key, 5)::bigint AND NOT s.auto)
  ) AS answer_row(v);
  RETURN found_value;
END
$function$;

CREATE OR REPLACE FUNCTION public.system_paid(method text, completion_key text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  found_value boolean;
BEGIN
  SELECT answer_row.v INTO found_value FROM (
    SELECT reviewer_paid(method, completion_key) OR (
      method = 'quiz' AND completion_key ~ '^quiz:[0-9]{1,18}$' AND EXISTS (
        SELECT 1 FROM quiz_attempt a WHERE a.id = substr(completion_key, 6)::bigint AND a.swept))
  ) AS answer_row(v);
  RETURN found_value;
END
$function$;

CREATE OR REPLACE FUNCTION public.xp_level_of(total bigint)
 RETURNS smallint
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  found_value smallint;
BEGIN
  SELECT answer_row.v INTO found_value FROM (
    SELECT coalesce(max(l.level), 1)::smallint FROM xp_level l WHERE l.xp_from <= total
  ) AS answer_row(v);
  RETURN found_value;
END
$function$;

CREATE OR REPLACE FUNCTION public.xp_month_of(entry bigint)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  found_value text;
BEGIN
  SELECT answer_row.v INTO found_value FROM (
    SELECT questify_month(coalesce(c.created_at, e.created_at))
    FROM xp_entry e LEFT JOIN xp_entry c ON c.id = e.reverses
    WHERE e.id = entry
  ) AS answer_row(v);
  RETURN found_value;
END
$function$;

ALTER FUNCTION public.event_day(timestamp with time zone, event) RESET search_path;
ALTER FUNCTION public.event_day_start(event, date) RESET search_path;
ALTER FUNCTION public.event_multi_day(event) RESET search_path;
ALTER FUNCTION public.questify_day(timestamp with time zone) RESET search_path;
ALTER FUNCTION public.questify_month(timestamp with time zone) RESET search_path;
ALTER FUNCTION public.streak_day_closed(event_streak, date) RESET search_path;
