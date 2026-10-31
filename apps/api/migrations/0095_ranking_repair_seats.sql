-- The repair mark for the seats that move points by hand (a follow-up to T-505b's review; ADR-382 point 9 named the gap).
-- `mark_ranking_repair` (0015) marks an event only for the system or an enrolled player of it, so the doors that run as
-- a team member (`grant_manual_award` 0032, `review_core` 0040, `confirm_results` 0065) or as an operator called it and
-- marked nothing: a rehearsal board and an ended event's board were never rebuilt, and a live one waited for the
-- five-minute backstop. Now it also marks for a caller who holds the event's organizer seat (within their event limit)
-- or is one of the event's operators. The mark only asks for a rebuild, so it reveals and changes nothing else.
-- Deny by default: no new table or function; the grant stays with the API role and PUBLIC stays closed, so a stranger,
-- another organizer's team, a player or operator of another event, and the public key mark nothing.
SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION mark_ranking_repair(target uuid) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO ranking_repair (event_id) SELECT ev.id FROM event ev
  WHERE ev.id = target
    AND (ranking_system()
         OR ranking_reader_enrollment(target) IS NOT NULL
         OR (ev.organizer_id = app_organizer_id() AND in_event_scope(ev.id, app_event_scope()))
         OR EXISTS (SELECT 1 FROM staff_assignment sa WHERE sa.event_id = ev.id AND sa.player_id = app_player_id()))
  ON CONFLICT (event_id) DO UPDATE SET marked_at = now()
$$;
REVOKE ALL ON FUNCTION mark_ranking_repair(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mark_ranking_repair(uuid) TO questify_app;
