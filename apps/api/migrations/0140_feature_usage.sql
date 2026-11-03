-- The console's per-organizer feature usage (T-714, FR-1839, ADR-550): for a page of organizers, what each organizer's
-- events switch on and which of them have content in the feature's own table. One read-only door, counts only: it names
-- no player, staff member, contact or message. The layer state (the platform's switch, the organizer's override) is laid
-- over these counts in TypeScript (`featureUsageOrganizer`), with the same functions as the organizer's Features panel.
--
-- Deny by default: the function is revoked from PUBLIC in this file and granted to the API's role alone; it begins with
-- `console_admin()`, which re-reads the admin from the account (QE403 for every other seat). No table is created.
SET LOCAL lock_timeout = '10s';

-- ================================================================ indexes the usage probes need
-- Every probe below is an EXISTS through an event-id index. `quest_rating` had none by event (its keys lead with the
-- player's enrollment or the quest); the event's delete cascade scans it the same way. The three quest types that carry
-- a feature (share, meet, game) are probed by type, so they get a small partial index like the flash and live-poll ones.
CREATE INDEX quest_rating_event_idx ON quest_rating (event_id);
CREATE INDEX quest_event_type_idx ON quest (event_id, type) WHERE type IN ('share', 'meet', 'game');

-- ================================================================ the door
-- `search` is a prefix of the organizer's name or slug (case-folded); `after` is the last organizer of the page before
-- (keyset by lower(name), id; an unknown id answers an empty page); `page_size` is held between 1 and 50. Only the
-- organizer's 200 latest events are read, and `more` says there are older ones, so a busy organizer costs what a small one
-- does. `feature_keys` is the registry's event-level feature list from the API: nothing outside it is answered.
--
-- Per organizer: `overrides` (feature -> Questify's On or Off), `switches` (feature -> events that set their own switch
-- on and off), `unlocked` (add-on -> events Questify unlocked it for) and `using` (feature -> events with content). `using`
-- holds every measured feature, zero included, and none of the others (ranking has no content of its own), so the API can
-- tell "not used" from "not measured".
--
-- Each part is aggregated once per organizer and joined back by organizer, never read by a correlated subquery over the
-- events read: a page of 50 organizers would otherwise scan its 10,000 events 50 times for each part.
CREATE FUNCTION console_feature_usage(search text, after uuid, page_size integer, feature_keys text[]) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  size constant integer := least(greatest(coalesce(page_size, 25), 1), 50);
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
REVOKE ALL ON FUNCTION console_feature_usage(text, uuid, integer, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_feature_usage(text, uuid, integer, text[]) TO questify_app;
