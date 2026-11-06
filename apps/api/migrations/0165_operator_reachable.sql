-- The Operators page's confirmation before a staff briefing names how many operators it reaches (docs/FOLLOWUPS.md,
-- T-617 line; ADR-790). `operator_activity` (0111) gains `reachable`: the operators of the event with an active account,
-- the same people `staff_briefing_send` counts, where the page counted every operator including a banned one. One
-- restated function with the same arguments, result type and grant, closed to PUBLIC next to it; no table, no new
-- function, nothing written. Deployed migrations untouched.
SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION operator_activity(target_event uuid, recent_limit integer DEFAULT 5) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev        event := award_event_of(target_event);
  day_start timestamptz := event_day_start(ev, event_day(now(), ev));
BEGIN
  RETURN jsonb_build_object(
    'asOf', now(),
    'reachable', (SELECT count(*)::integer
                  FROM staff_assignment sa JOIN player p ON p.id = sa.player_id AND p.status = 'active'
                  WHERE sa.event_id = ev.id),
    'operators', operator_activity_rows(ev, day_start, now() - interval '1 hour'),
    'recent', operator_activity_recent(ev, least(greatest(coalesce(recent_limit, 5), 1), 50)),
    'briefings', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', x.id, 'titleAr', x.title_ar, 'titleEn', x.title_en, 'bodyAr', x.body_ar,
                                          'bodyEn', x.body_en, 'recipients', x.recipients, 'sentAt', x.created_at)
                       ORDER BY x.created_at DESC, x.id DESC)
      FROM (SELECT b.* FROM staff_briefing b WHERE b.event_id = ev.id
            ORDER BY b.created_at DESC, b.id DESC LIMIT 5) x), '[]'::jsonb));
END $$;
REVOKE ALL ON FUNCTION operator_activity(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION operator_activity(uuid, integer) TO questify_app;
