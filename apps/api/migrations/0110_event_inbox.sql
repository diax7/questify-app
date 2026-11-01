-- The owner's Inbox counts (T-616, FR-1825, ADR-401): what waits for the event's team, in one read. Read-only: no table,
-- no write, nothing about points or sign-in changes, and no second ticket or flag store: every figure is a count over the
-- rows the Help desk, Submissions, Flagged activity and Players pages already read. A door for the event's team (an owner
-- or an editor within their event limit, AN404 for anyone else, as the control room's reads in 0096); a player, another
-- organizer's team and the public key reach none. Deny by default: PUBLIC holds no EXECUTE, the grant names the API's
-- role alone.
--
-- Only counts leave the database: never a player, a name or a text. The lists the page shows under the counts are the
-- Help desk's and the join queue's own reads.
SET LOCAL lock_timeout = '10s';

-- One index-only walk of an event's open requests answers every ticket count, in either queue, however many requests
-- the other events (or this one's closed ones) hold. The Questify queue's own index (0061) is not keyed by event.
CREATE INDEX ticket_event_open_idx ON ticket (event_id, queue, kind) WHERE status = 'open';

-- The open flags of one event, index only. `flag_event_idx` (0031) lists every case of the event, open or not.
CREATE INDEX flag_event_open_idx ON flag (event_id) WHERE status = 'open';

-- The open help requests of the event's queue by kind (the Help desk's Open tab, so a count and its list always match),
-- the open ones Questify holds after an escalation, the join requests and waiting list (pending, rehearsal accounts
-- left out, as `pending_join_requests`), the submissions waiting for review and the open flags. `private` says the
-- event takes join requests (access private), so the page can say "nothing waiting" for an event that has a queue.
CREATE FUNCTION event_inbox(target_event uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
  tickets jsonb;
  with_questify bigint;
BEGIN
  SELECT jsonb_build_object(
           'question', count(*) FILTER (WHERE t.queue = 'event' AND t.kind = 'question'),
           'problem', count(*) FILTER (WHERE t.queue = 'event' AND t.kind = 'problem'),
           'prize', count(*) FILTER (WHERE t.queue = 'event' AND t.kind = 'prize'),
           'report_player', count(*) FILTER (WHERE t.queue = 'event' AND t.kind = 'report_player')),
         count(*) FILTER (WHERE t.queue = 'questify')
    INTO tickets, with_questify
    FROM ticket t WHERE t.event_id = ev.id AND t.status = 'open';
  RETURN jsonb_build_object(
    'tickets', tickets,
    'withQuestify', with_questify,
    'joinRequests', jsonb_build_object(
      'pending', (SELECT count(*) FROM enrollment n
                  WHERE n.event_id = ev.id AND n.status = 'pending' AND n.joined_via IS DISTINCT FROM 'rehearsal'),
      'private', ev.access = 'private'),
    'submissions', (SELECT count(*) FROM submission s WHERE s.event_id = ev.id AND s.status = 'pending'),
    'flags', (SELECT count(*) FROM flag f WHERE f.event_id = ev.id AND f.status = 'open'));
END $$;
REVOKE ALL ON FUNCTION event_inbox(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION event_inbox(uuid) TO questify_app;
