-- T-411: archiving ended events (FR-1608's last step; ADR-337 (5), ADR-341; plan note in
-- docs/plans/2026-10-27-t-410-after-the-event.md). The lifecycle tick's last step moves an ended event to archived once
-- its shop is closed, no redemption of any kind is reserved, its results are revealed or 60 days have passed since its
-- end, and no ticket of it is open. Two insert guards make that hold under concurrency, and archived becomes final for
-- every role. Deny by default: every new function is closed to PUBLIC in the group that creates it and only the step is
-- granted to the API role. Migrations 0074 and earlier untouched.
SET LOCAL lock_timeout = '10s';
-- The three tables gain a trigger (SHARE ROW EXCLUSIVE) and redemption and event an index; taken up front in one order.
LOCK TABLE event IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE redemption IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE ticket IN SHARE ROW EXCLUSIVE MODE;

-- What the archive step looks for every run, and the per-event look for a reservation still held.
CREATE INDEX event_due_to_archive ON event (ends_at) WHERE status = 'ended';
CREATE INDEX redemption_reserved_event ON redemption (event_id) WHERE status = 'reserved';

-- ================================================================ when an ended event is archived (ADR-337 (5))
-- All four hold: the shop is closed (shop_state, the one definition); no redemption of the event is reserved (shop
-- holds, rank prizes and quest items share the table); its results are revealed, or 60 days have passed since its end
-- (at exactly that moment included); no ticket of the event is open, in either queue. Each blocker clears on its own:
-- holds and prizes time out, tickets are purged 90 days after the end. STABLE (it reads now()); internal.
CREATE FUNCTION archive_due(ev event) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT ev.status = 'ended'
     AND shop_state(ev.status, ev.starts_at, ev.ends_at, ev.shop_days_after) = 'closed'
     AND (ev.ends_at + interval '60 days' <= now()
          OR EXISTS (SELECT 1 FROM event_result r WHERE r.event_id = ev.id AND r.revealed_at IS NOT NULL))
     AND NOT EXISTS (SELECT 1 FROM redemption d WHERE d.event_id = ev.id AND d.status = 'reserved')
     AND NOT EXISTS (SELECT 1 FROM ticket t WHERE t.event_id = ev.id AND t.status = 'open')
$$;
REVOKE ALL ON FUNCTION archive_due(event) FROM PUBLIC;

-- ================================================================ the step (FR-1608)
-- Archives up to 100 due events a run, oldest end first, audited as the other moves. Each is locked FOR UPDATE SKIP
-- LOCKED: a second instance running at once, or a door holding the event (the guards below), makes this run pass it by.
-- The rule is checked again by the UPDATE, a statement that starts after the lock and so sees every commit before it.
-- Applies only the rules, so anyone may call it; the API's tick does.
CREATE FUNCTION archive_ended_events() RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  due   event%ROWTYPE;
  moved integer := 0;
BEGIN
  FOR due IN
    SELECT e.* FROM event e
    WHERE e.status = 'ended' AND archive_due(e)
    ORDER BY e.ends_at, e.id
    LIMIT 100
    FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE event e SET status = 'archived' WHERE e.id = due.id AND archive_due(e);
    IF FOUND THEN
      INSERT INTO audit_log (actor_type, organizer_id, event_id, action, target_type, target_id, before, after)
      VALUES ('system', due.organizer_id, due.id, 'event.lifecycle', 'event', due.id::text,
              jsonb_build_object('status', 'ended'), jsonb_build_object('status', 'archived'));
      moved := moved + 1;
    END IF;
  END LOOP;
  RETURN moved;
END $$;
REVOKE ALL ON FUNCTION archive_ended_events() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION archive_ended_events() TO questify_app;

-- ================================================================ nothing new in an archived event
-- A redemption is never made in an archived event. The event row is read FOR KEY SHARE, which the step's FOR UPDATE
-- excludes both ways: a door that read first makes the step skip the event this run, and one that reads while the step
-- holds it waits and then sees archived. The refusal is the door's own: the shop's closed, the reveal's not_ended, a
-- quest item's payer's quest not open. Every role (the doors are definers).
CREATE FUNCTION redemption_event_open() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  now_status text;
BEGIN
  SELECT e.status INTO now_status FROM event e WHERE e.id = NEW.event_id FOR KEY SHARE;
  IF now_status IS DISTINCT FROM 'archived' THEN
    RETURN NEW;
  END IF;
  IF NEW.reward_id IS NOT NULL THEN
    RAISE EXCEPTION 'shop not open' USING ERRCODE = 'RS403', DETAIL = 'closed';
  ELSIF NEW.rank_prize_id IS NOT NULL THEN
    RAISE EXCEPTION 'the event is not in its ended state' USING ERRCODE = 'RF409', DETAIL = 'not_ended';
  END IF;
  RAISE EXCEPTION 'quest not open' USING ERRCODE = 'QN403', DETAIL = 'ended';
END $$;
REVOKE ALL ON FUNCTION redemption_event_open() FROM PUBLIC;
CREATE TRIGGER redemption_event_open BEFORE INSERT ON redemption
  FOR EACH ROW EXECUTE FUNCTION redemption_event_open();

-- The same for a ticket of an event (Questify's own kinds carry none): open_ticket's sending_closed.
CREATE FUNCTION ticket_event_open() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF (SELECT e.status FROM event e WHERE e.id = NEW.event_id FOR KEY SHARE) = 'archived' THEN
    RAISE EXCEPTION 'sending is closed for this event' USING ERRCODE = 'HT403', DETAIL = 'sending_closed';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ticket_event_open() FROM PUBLIC;
CREATE TRIGGER ticket_event_open BEFORE INSERT ON ticket
  FOR EACH ROW WHEN (NEW.event_id IS NOT NULL) EXECUTE FUNCTION ticket_event_open();

-- ================================================================ archived is final
-- No role moves an event out of archived: the API's role has no right on status (0009) and no definer does it; this
-- holds it for the owner connection too.
CREATE FUNCTION event_archived_final() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'an archived event stays archived' USING ERRCODE = 'QE409', DETAIL = 'archived';
END $$;
REVOKE ALL ON FUNCTION event_archived_final() FROM PUBLIC;
CREATE TRIGGER event_archived_final BEFORE UPDATE OF status ON event
  FOR EACH ROW WHEN (OLD.status = 'archived' AND NEW.status IS DISTINCT FROM 'archived')
  EXECUTE FUNCTION event_archived_final();
