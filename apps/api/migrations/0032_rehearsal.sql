-- Rehearsal mode (T-211; ADR-080, ADR-157 to ADR-160). The organizer's team joins a Draft or Scheduled event with its
-- rehearsal code; each such enrollment is a rehearsal account (`joined_via = 'rehearsal'`) and everything it does is
-- rehearsal. At go-live (or when the team erases it) one definer deletes the rehearsal accounts with every row that
-- hangs off them, ledger entries included: the one exception to the append-only ledger, which every rehearsal entry
-- carries in an immutable `rehearsal` flag. The audit log keeps every rehearsal action and the erase itself.
--
-- Lock order everywhere: event → event_rehearsal → enrollment → reward → redemption. Every writer calls
-- `ensure_rehearsal_wiped(event)` before it locks an enrollment: it runs the go-live wipe when it is due and otherwise
-- takes a shared lock on the event's rehearsal row, so a wipe waits for rehearsal writes in flight and sees them.

-- ================================================================ rehearsal accounts
ALTER TABLE enrollment DROP CONSTRAINT enrollment_joined_via_check;
ALTER TABLE enrollment ADD CONSTRAINT enrollment_joined_via_check
  CHECK (joined_via IN ('code', 'qr', 'link', 'public_list', 'operator', 'invite', 'rehearsal'));

-- A rehearsal account never becomes a real one, nor the reverse: a rejoin path that rewrites joined_via cannot turn
-- rehearsal rows into live ones (or real ones into rows the wipe deletes).
CREATE FUNCTION enrollment_rehearsal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(OLD.joined_via = 'rehearsal', false) <> coalesce(NEW.joined_via = 'rehearsal', false) THEN
    RAISE EXCEPTION 'a rehearsal account stays one' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION enrollment_rehearsal_guard() FROM PUBLIC;
CREATE TRIGGER enrollment_rehearsal_guard BEFORE UPDATE OF joined_via ON enrollment
  FOR EACH ROW EXECUTE FUNCTION enrollment_rehearsal_guard();
CREATE INDEX enrollment_rehearsal_idx ON enrollment (event_id) WHERE joined_via = 'rehearsal';

-- The most rehearsal accounts an event may have (ADR-158, Q-122) until T-703 makes it a console setting.
CREATE FUNCTION rehearsal_cap() RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT 25 $$;
REVOKE ALL ON FUNCTION rehearsal_cap() FROM PUBLIC;

-- ================================================================ the event's rehearsal
-- One row per event once the team opens its rehearsal card: the code (shape XXXX-XXXX, which no join code can take),
-- when the rehearsal was first played, and what the last erase removed. Read by the event's team and admins; written
-- only by the definers below.
CREATE TABLE event_rehearsal (
  event_id      uuid PRIMARY KEY,
  organizer_id  uuid NOT NULL,
  code          text NOT NULL CHECK (code ~ '^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$'),
  code_set_at   timestamptz NOT NULL DEFAULT now(),
  first_play_at timestamptz,
  erased_at     timestamptz,
  erase_counts  jsonb,
  live_wiped_at timestamptz,
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX event_rehearsal_code_key ON event_rehearsal (code);
ALTER TABLE event_rehearsal ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_rehearsal FORCE ROW LEVEL SECURITY;
REVOKE ALL ON event_rehearsal FROM PUBLIC;
GRANT SELECT ON event_rehearsal TO questify_app;
CREATE POLICY event_rehearsal_read ON event_rehearsal FOR SELECT TO questify_app
  USING ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope())) OR app_is_admin());

-- ================================================================ the ledger's stamp and its one exception (ADR-157)
ALTER TABLE ledger_entry ADD COLUMN rehearsal boolean NOT NULL DEFAULT false;
ALTER TABLE bulk_award ADD COLUMN rehearsal boolean NOT NULL DEFAULT false;
-- The wipe keeps rehearsal bulk awards (a retry with the same key replays instead of running live), so one that
-- names a quest must not block deleting that quest: the quest is forgotten, the record stays.
ALTER TABLE bulk_award DROP CONSTRAINT bulk_award_quest_id_event_id_fkey,
  ADD FOREIGN KEY (quest_id, event_id) REFERENCES quest (id, event_id) ON DELETE SET NULL (quest_id);
CREATE INDEX ledger_entry_rehearsal_idx ON ledger_entry (event_id) WHERE rehearsal;

-- Set from the enrollment at insert, never by a writer. Named to fire before ledger_operator_play_guard (triggers of
-- one kind fire in name order), which reads it.
CREATE FUNCTION ledger_stamp_rehearsal() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  NEW.rehearsal := EXISTS (SELECT 1 FROM enrollment n WHERE n.id = NEW.enrollment_id AND n.joined_via = 'rehearsal');
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION ledger_stamp_rehearsal() FROM PUBLIC;
CREATE TRIGGER ledger_a_stamp_rehearsal BEFORE INSERT ON ledger_entry
  FOR EACH ROW EXECUTE FUNCTION ledger_stamp_rehearsal();

-- As 0012, with one exception: the rehearsal wipe of this very event may delete a rehearsal entry. UPDATE and
-- TRUNCATE stay refused for every row; the API's role has no DELETE right on the table at all.
CREATE OR REPLACE FUNCTION ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.rehearsal
     AND current_setting('questify.rehearsal_wipe', true) = OLD.event_id::text THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'points entries can never be changed or removed; a correction is a new entry'
    USING ERRCODE = 'insufficient_privilege';
END $$;

-- As 0030, but a rehearsal account plays whatever its owner's assignment says: FR-906 governs the live game.
CREATE OR REPLACE FUNCTION ledger_operator_play_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT NEW.rehearsal AND NEW.kind IN ('quest', 'redeem', 'award') AND EXISTS (
    SELECT 1 FROM enrollment e JOIN staff_assignment sa ON sa.event_id = e.event_id AND sa.player_id = e.player_id
    WHERE e.id = NEW.enrollment_id AND NOT sa.can_play) THEN
    RAISE EXCEPTION 'operators do not play the event they staff' USING ERRCODE = 'QP403';
  END IF;
  RETURN NEW;
END $$;

-- ================================================================ seats and the welcome skip rehearsal accounts
CREATE OR REPLACE FUNCTION event_seats(target uuid) RETURNS integer
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT count(*)::integer FROM enrollment
  WHERE event_id = target AND status IN ('pending', 'active', 'banned') AND joined_via IS DISTINCT FROM 'rehearsal'
$$;

CREATE OR REPLACE FUNCTION enrollment_player_limit() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  mode text;
  cap integer;
  seats integer;
BEGIN
  IF NEW.status NOT IN ('pending', 'active') OR NEW.joined_via = 'rehearsal' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IN ('pending', 'active', 'banned') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' AND EXISTS (SELECT 1 FROM enrollment WHERE event_id = NEW.event_id AND player_id = NEW.player_id)
  THEN
    RETURN NEW;
  END IF;
  SELECT player_limit_mode, player_limit INTO mode, cap FROM event WHERE id = NEW.event_id FOR KEY SHARE;
  IF mode IS NULL OR mode = 'none' THEN
    RETURN NEW;
  END IF;
  PERFORM lock_event_seats(NEW.event_id);
  IF TG_OP = 'INSERT' AND EXISTS (SELECT 1 FROM enrollment WHERE event_id = NEW.event_id AND player_id = NEW.player_id)
  THEN
    RETURN NEW;
  END IF;
  SELECT player_limit_mode, player_limit INTO mode, cap FROM event WHERE id = NEW.event_id;
  seats := event_seats(NEW.event_id);
  IF mode = 'hard' AND seats >= cap THEN
    RAISE EXCEPTION 'the event is full' USING ERRCODE = 'QL409', DETAIL = cap::text;
  END IF;
  IF mode <> 'none' THEN
    PERFORM record_limit_alerts(NEW.event_id, NEW.organizer_id, cap, seats + 1);
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION grant_welcome() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  amount integer;
  made bigint;
BEGIN
  IF NEW.status <> 'active' OR (TG_OP = 'UPDATE' AND OLD.status = 'active') OR NEW.joined_via = 'rehearsal' THEN
    RETURN NULL;
  END IF;
  SELECT e.welcome_points INTO amount FROM event e WHERE e.id = NEW.event_id;
  IF amount IS NULL THEN
    RETURN NULL;
  END IF;
  INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor)
  VALUES (NEW.organizer_id, NEW.event_id, NEW.id, 'welcome', amount, amount, 'system')
  ON CONFLICT (enrollment_id) WHERE kind = 'welcome' DO NOTHING
  RETURNING id INTO made;
  IF made IS NOT NULL THEN
    INSERT INTO ranking_repair (event_id) VALUES (NEW.event_id)
    ON CONFLICT (event_id) DO UPDATE SET marked_at = now();
  END IF;
  RETURN NULL;
END $$;

-- ================================================================ the phase of a play (STABLE: reads may call it)
-- 'live' for a real account in a live event; 'rehearsal' for a rehearsal account in a Draft or Scheduled event;
-- NULL otherwise (the writer's own not-live refusal).
CREATE FUNCTION play_phase(ev event, enrolled enrollment) RETURNS text
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN enrolled.joined_via = 'rehearsal' THEN
      CASE WHEN event_status_now(ev.status, ev.starts_at, ev.ends_at) IN ('draft', 'scheduled') THEN 'rehearsal' END
    WHEN event_status_now(ev.status, ev.starts_at, ev.ends_at) = 'live' THEN 'live'
  END
$$;
REVOKE ALL ON FUNCTION play_phase(event, enrollment) FROM PUBLIC;

-- Rehearsal is over once the event is live, ended or archived, or scheduled with its start passed on the clock (not
-- now(), which stays at the transaction's start). A Draft never goes live by time (only activation schedules it), so a
-- Draft whose start has passed can still rehearse. VOLATILE: it reads the clock.
CREATE FUNCTION rehearsal_over(ev event) RETURNS boolean
  LANGUAGE sql VOLATILE SET search_path = public, pg_temp AS $$
  SELECT ev.status IN ('live', 'ended', 'archived')
         OR (ev.status = 'scheduled' AND ev.starts_at IS NOT NULL AND ev.starts_at <= clock_timestamp())
$$;
REVOKE ALL ON FUNCTION rehearsal_over(event) FROM PUBLIC;

-- ================================================================ the wipe (ADR-157, ADR-160)
-- Deletes the event's rehearsal accounts and everything hanging off them, restores stock from what remains, marks the
-- ranking for a rebuild and audits the counts. `reason` 'go_live' (the system, once) or 'erase' (owner or editor,
-- before go-live). Under the rehearsal row's lock, then the accounts' locks in id order, so every writer in flight
-- has committed and is seen. Internal. Returns the counts, or NULL when there was nothing to do.
CREATE FUNCTION wipe_rehearsal(target uuid, reason text, request uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  found_row event_rehearsal%ROWTYPE;
  accounts  uuid[];
  counts    jsonb;
  first_at  timestamptz;
  entries   integer;
BEGIN
  SELECT * INTO found_row FROM event_rehearsal r WHERE r.event_id = target FOR UPDATE;
  IF NOT FOUND OR found_row.live_wiped_at IS NOT NULL THEN
    RETURN NULL;
  END IF;
  accounts := ARRAY(
    WITH locked AS (
      SELECT n.id FROM enrollment n WHERE n.event_id = target AND n.joined_via = 'rehearsal' ORDER BY n.id FOR UPDATE
    )
    SELECT locked.id FROM locked ORDER BY locked.id);
  SELECT min(l.created_at) FILTER (WHERE l.kind = 'quest'),
         jsonb_build_object(
           'accounts', cardinality(accounts),
           'completions', count(*) FILTER (WHERE l.kind = 'quest'),
           'points', coalesce(sum(l.score_delta) FILTER (WHERE l.kind IN ('quest', 'award', 'removal')), 0),
           'reservations', (SELECT count(*) FROM redemption d WHERE d.enrollment_id = ANY (accounts)),
           'flags', (SELECT count(*) FROM flag f WHERE f.enrollment_id = ANY (accounts)))
  INTO first_at, counts
  FROM ledger_entry l WHERE l.event_id = target AND l.rehearsal;

  PERFORM set_config('questify.rehearsal_wipe', target::text, true);
  DELETE FROM ledger_note t WHERE t.entry_id IN (SELECT l.id FROM ledger_entry l WHERE l.event_id = target AND l.rehearsal);
  DELETE FROM manual_award_key k
  WHERE k.entry_id IN (SELECT l.id FROM ledger_entry l WHERE l.event_id = target AND l.rehearsal);
  DELETE FROM ledger_entry l WHERE l.event_id = target AND l.rehearsal AND l.reverses IS NOT NULL;
  DELETE FROM ledger_entry l WHERE l.event_id = target AND l.rehearsal;
  GET DIAGNOSTICS entries = ROW_COUNT;
  PERFORM set_config('questify.rehearsal_wipe', '', true);
  IF EXISTS (SELECT 1 FROM reward_code c JOIN redemption d ON d.id = c.redemption_id
             WHERE d.enrollment_id = ANY (accounts)) THEN
    RAISE EXCEPTION 'a rehearsal reservation holds a real code' USING ERRCODE = 'RX500';
  END IF;
  DELETE FROM redemption d WHERE d.enrollment_id = ANY (accounts);
  DELETE FROM quest_completion c WHERE c.enrollment_id = ANY (accounts);
  DELETE FROM flag f WHERE f.enrollment_id = ANY (accounts);
  -- bulk_award rows stay (their notes are gone): a retried rehearsal bulk award replays from its row, never live.
  DELETE FROM enrollment n WHERE n.id = ANY (accounts);
  -- Stock from what remains (FR-1722): every reservation still holding a unit.
  UPDATE reward r SET units_out = (
    SELECT count(*) FROM redemption d
    WHERE d.reward_id = r.id AND d.status IN ('reserved', 'handed_over', 'delivered'))
  WHERE r.event_id = target;

  UPDATE event_rehearsal r
  SET erased_at = now(), erase_counts = counts, first_play_at = coalesce(r.first_play_at, first_at),
      live_wiped_at = CASE WHEN reason = 'go_live' THEN now() END
  WHERE r.event_id = target;
  INSERT INTO ranking_repair (event_id) VALUES (target) ON CONFLICT (event_id) DO UPDATE SET marked_at = now();
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after,
                         request_id)
  VALUES (CASE WHEN reason = 'go_live' THEN 'system' ELSE 'staff' END,
          CASE WHEN reason = 'go_live' THEN NULL ELSE app_staff_user_id() END,
          found_row.organizer_id, target, 'event.rehearsal_erased', 'event', target::text,
          counts || jsonb_build_object('reason', reason, 'entries', entries), request);
  RETURN counts;
END $$;
REVOKE ALL ON FUNCTION wipe_rehearsal(uuid, text, uuid) FROM PUBLIC;

-- Every writer calls this first, before any enrollment lock. No rehearsal, or already wiped: nothing, no lock (the
-- live hot path is one key lookup). Rehearsal over: the go-live wipe runs now. Otherwise a shared lock on the
-- rehearsal row for the rest of the transaction, so a wipe waits for this writer. True when it wiped. Granted: it
-- applies only the time rule, like advance_event_lifecycle, and the tick calls it.
CREATE FUNCTION ensure_rehearsal_wiped(target uuid) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  found_row event_rehearsal%ROWTYPE;
  ev        event%ROWTYPE;
BEGIN
  SELECT * INTO found_row FROM event_rehearsal r WHERE r.event_id = target;
  IF NOT FOUND OR found_row.live_wiped_at IS NOT NULL THEN
    RETURN false;
  END IF;
  SELECT * INTO ev FROM event e WHERE e.id = target;
  IF rehearsal_over(ev) THEN
    RETURN wipe_rehearsal(target, 'go_live', NULL) IS NOT NULL;
  END IF;
  SELECT * INTO found_row FROM event_rehearsal r WHERE r.event_id = target FOR SHARE;
  -- Re-checked under the lock (FOR SHARE reads the latest row): a go-live wipe that committed while this waited has
  -- already removed the rehearsal, so there is nothing to hold; the writer's own phase check then sees the event live.
  IF found_row.live_wiped_at IS NOT NULL THEN
    RETURN false;
  END IF;
  -- Not wiped: the shared lock is held to the end of the transaction, so a wipe waits for this writer.
  RETURN false;
END $$;
REVOKE ALL ON FUNCTION ensure_rehearsal_wiped(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ensure_rehearsal_wiped(uuid) TO questify_app;

-- The events whose rehearsal is due for its go-live wipe, for the tick (one event per transaction).
CREATE FUNCTION due_rehearsal_wipes() RETURNS SETOF uuid
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.event_id FROM event_rehearsal r JOIN event e ON e.id = r.event_id
  WHERE r.live_wiped_at IS NULL AND rehearsal_over(e)
  ORDER BY r.event_id LIMIT 100
$$;
REVOKE ALL ON FUNCTION due_rehearsal_wipes() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION due_rehearsal_wipes() TO questify_app;

-- ================================================================ the team's card, code and erase
-- The event of an owner or editor within their limit, still before go-live (RR409 otherwise). AN404 from
-- award_event_of.
CREATE FUNCTION rehearsal_event_of(target_event uuid) RETURNS event
  LANGUAGE plpgsql VOLATILE SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  IF ev.status NOT IN ('draft', 'scheduled') OR rehearsal_over(ev) THEN
    RAISE EXCEPTION 'the event has gone live' USING ERRCODE = 'RR409';
  END IF;
  RETURN ev;
END $$;
REVOKE ALL ON FUNCTION rehearsal_event_of(uuid) FROM PUBLIC;

-- What the rehearsal card shows: the code (NULL before it is opened), the accounts, what rehearsal wrote so far, and
-- the last erase. Owners and editors in their events (AN404). Any status: after go-live it shows the erase.
CREATE FUNCTION rehearsal_card(target_event uuid)
  RETURNS TABLE (code text, status_now text, accounts integer, completions integer, points bigint, reservations integer,
                 flags integer, first_play_at timestamptz, erased_at timestamptz, erase_counts jsonb,
                 live_wiped_at timestamptz)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN QUERY
  SELECT r.code, event_status_now(ev.status, ev.starts_at, ev.ends_at),
         (SELECT count(*)::integer FROM enrollment n WHERE n.event_id = ev.id AND n.joined_via = 'rehearsal'),
         (SELECT count(*)::integer FROM ledger_entry l WHERE l.event_id = ev.id AND l.rehearsal AND l.kind = 'quest'),
         (SELECT coalesce(sum(l.score_delta), 0)::bigint FROM ledger_entry l
          WHERE l.event_id = ev.id AND l.rehearsal AND l.kind IN ('quest', 'award', 'removal')),
         (SELECT count(*)::integer FROM redemption d JOIN enrollment n ON n.id = d.enrollment_id
          WHERE n.event_id = ev.id AND n.joined_via = 'rehearsal'),
         (SELECT count(*)::integer FROM flag f JOIN enrollment n ON n.id = f.enrollment_id
          WHERE n.event_id = ev.id AND n.joined_via = 'rehearsal'),
         coalesce(r.first_play_at, (SELECT min(l.created_at) FROM ledger_entry l
                                    WHERE l.event_id = ev.id AND l.rehearsal AND l.kind = 'quest')),
         r.erased_at, r.erase_counts, r.live_wiped_at
  FROM (SELECT 1) AS one LEFT JOIN event_rehearsal r ON r.event_id = ev.id;
END $$;
REVOKE ALL ON FUNCTION rehearsal_card(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rehearsal_card(uuid) TO questify_app;

-- Opens the rehearsal with this code when it has none, or answers the code it has (no audit: nothing changes for
-- anyone). The API makes the code; a clash with another event's raises unique_violation and the API tries another.
-- RR409 after go-live.
CREATE FUNCTION open_rehearsal(target_event uuid, new_code text) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev   event := rehearsal_event_of(target_event);
  kept text;
BEGIN
  INSERT INTO event_rehearsal (event_id, organizer_id, code) VALUES (ev.id, ev.organizer_id, new_code)
  ON CONFLICT (event_id) DO NOTHING;
  SELECT r.code INTO kept FROM event_rehearsal r WHERE r.event_id = ev.id;
  RETURN kept;
END $$;
REVOKE ALL ON FUNCTION open_rehearsal(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION open_rehearsal(uuid, text) TO questify_app;

-- Rotate: the old code stops at once; accounts already joined stay (Erase removes them). Audited. RR409, RR404 when
-- the rehearsal was never opened.
CREATE FUNCTION rotate_rehearsal_code(target_event uuid, new_code text, request uuid) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := rehearsal_event_of(target_event);
BEGIN
  UPDATE event_rehearsal r SET code = new_code, code_set_at = now() WHERE r.event_id = ev.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no rehearsal opened' USING ERRCODE = 'RR404';
  END IF;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'event.rehearsal_code', 'event', ev.id::text, request);
  RETURN new_code;
END $$;
REVOKE ALL ON FUNCTION rotate_rehearsal_code(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rotate_rehearsal_code(uuid, text, uuid) TO questify_app;

-- Erase: the same wipe, before go-live, by an owner or editor. Naturally idempotent (a second erase finds nothing).
-- RR409, RR404 when the rehearsal was never opened.
CREATE FUNCTION erase_rehearsal(target_event uuid, request uuid) RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev     event := rehearsal_event_of(target_event);
  counts jsonb;
BEGIN
  counts := wipe_rehearsal(ev.id, 'erase', request);
  IF counts IS NULL THEN
    RAISE EXCEPTION 'no rehearsal opened' USING ERRCODE = 'RR404';
  END IF;
  RETURN counts;
END $$;
REVOKE ALL ON FUNCTION erase_rehearsal(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION erase_rehearsal(uuid, uuid) TO questify_app;

-- ================================================================ joining a rehearsal (ADR-158)
-- The event a rehearsal code opens, for a signed-in player's card: nothing once rehearsal is over (one answer for a
-- wrong code and a closed one).
CREATE FUNCTION rehearsal_event(rehearsal_code text)
  RETURNS TABLE (id uuid, name_ar text, name_en text, venue_ar text, venue_en text, kind text, timezone text,
                 starts_at timestamptz, ends_at timestamptz, status_now text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT e.id, e.name_ar, e.name_en, e.venue_ar, e.venue_en, e.kind, e.timezone, e.starts_at, e.ends_at,
         event_status_now(e.status, e.starts_at, e.ends_at)
  FROM event_rehearsal r JOIN event e ON e.id = r.event_id
  WHERE app_player_id() IS NOT NULL AND r.code = upper(rehearsal_code) AND r.live_wiped_at IS NULL
    AND event_status_now(e.status, e.starts_at, e.ends_at) IN ('draft', 'scheduled')
$$;
REVOKE ALL ON FUNCTION rehearsal_event(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rehearsal_event(text) TO questify_app;

-- Outcomes: joined (new, or a rehearsal account that left), already, already_player (this account is a real member of
-- the event: it cannot rehearse), not_allowed (a banned or removed rehearsal account), full (rehearsal_cap accounts),
-- closed (no such code, rotated, or rehearsal over). The event FOR SHARE, then the rehearsal row FOR UPDATE: two joins
-- cannot both take the last place, and the wipe waits for a join in flight.
CREATE FUNCTION join_rehearsal(rehearsal_code text, card text)
  RETURNS TABLE (outcome text, enrollment_id uuid, event_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me        uuid;
  target    uuid;
  ev        event%ROWTYPE;
  found_row event_rehearsal%ROWTYPE;
  mine      enrollment%ROWTYPE;
  made      uuid;
BEGIN
  SELECT p.id INTO me FROM player p WHERE p.id = app_player_id() AND p.status = 'active';
  IF me IS NULL THEN
    RAISE EXCEPTION 'not an active player' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF card IS NULL THEN
    RAISE EXCEPTION 'the join card version is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT r.event_id INTO target FROM event_rehearsal r WHERE r.code = upper(rehearsal_code);
  IF target IS NULL THEN
    RETURN QUERY SELECT 'closed'::text, NULL::uuid, NULL::uuid;
    RETURN;
  END IF;
  SELECT * INTO ev FROM event e WHERE e.id = target FOR SHARE;
  SELECT * INTO found_row FROM event_rehearsal r WHERE r.event_id = target FOR UPDATE;
  IF found_row.code <> upper(rehearsal_code) OR found_row.live_wiped_at IS NOT NULL OR rehearsal_over(ev)
     OR ev.status NOT IN ('draft', 'scheduled') THEN
    PERFORM ensure_rehearsal_wiped(target);
    RETURN QUERY SELECT 'closed'::text, NULL::uuid, NULL::uuid;
    RETURN;
  END IF;
  SELECT n.* INTO mine FROM enrollment n WHERE n.event_id = target AND n.player_id = me FOR UPDATE;
  IF FOUND AND mine.joined_via IS DISTINCT FROM 'rehearsal' THEN
    RETURN QUERY SELECT 'already_player'::text, NULL::uuid, target;
    RETURN;
  END IF;
  IF FOUND AND mine.status = 'active' THEN
    RETURN QUERY SELECT 'already'::text, mine.id, target;
    RETURN;
  END IF;
  IF FOUND AND mine.status = 'left' THEN
    UPDATE enrollment n SET status = 'active', card_version = card, joined_at = now() WHERE n.id = mine.id;
    RETURN QUERY SELECT 'joined'::text, mine.id, target;
    RETURN;
  END IF;
  IF FOUND THEN
    RETURN QUERY SELECT 'not_allowed'::text, NULL::uuid, target;
    RETURN;
  END IF;
  IF (SELECT count(*) FROM enrollment n WHERE n.event_id = target AND n.joined_via = 'rehearsal') >= rehearsal_cap()
  THEN
    RETURN QUERY SELECT 'full'::text, NULL::uuid, target;
    RETURN;
  END IF;
  INSERT INTO enrollment AS n (organizer_id, event_id, player_id, status, card_version, joined_via)
  VALUES (ev.organizer_id, ev.id, me, 'active', card, 'rehearsal')
  RETURNING n.id INTO made;
  RETURN QUERY SELECT 'joined'::text, made, target;
END $$;
REVOKE ALL ON FUNCTION join_rehearsal(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION join_rehearsal(text, text) TO questify_app;

-- ================================================================ the join paths answer 'rehearsing'
-- As 0028, plus: the go-live wipe first (no stale 'rehearsing' between the start and the tick), and a player holding a
-- rehearsal account in the event is told so before any branch that would rewrite joined_via.
CREATE OR REPLACE FUNCTION join_core(target event, me uuid, via text, card text, answers jsonb)
  RETURNS TABLE (outcome text, enrollment_id uuid, event_id uuid, status text, welcome integer)
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  row_found enrollment;
  invited boolean;
  joined_status text;
  made uuid;
  had_welcome boolean := false;
  granted integer;
BEGIN
  PERFORM ensure_rehearsal_wiped(target.id);
  IF event_status_now(target.status, target.starts_at, target.ends_at) NOT IN ('scheduled', 'live') THEN
    RETURN QUERY SELECT 'ended'::text, NULL::uuid, target.id, NULL::text, 0;
    RETURN;
  END IF;
  IF via <> 'invite' AND NOT (via = ANY (target.join_methods)) THEN
    RETURN QUERY SELECT 'method_off'::text, NULL::uuid, target.id, NULL::text, 0;
    RETURN;
  END IF;
  SELECT en.* INTO row_found FROM enrollment en WHERE en.event_id = target.id AND en.player_id = me FOR UPDATE;
  IF row_found.joined_via = 'rehearsal' THEN
    RETURN QUERY SELECT 'rehearsing'::text, NULL::uuid, target.id, NULL::text, 0;
    RETURN;
  END IF;
  IF row_found.status = 'active' OR (row_found.status = 'pending' AND NOT player_invited(target.id, me)) THEN
    RETURN QUERY SELECT 'already'::text, row_found.id, target.id, row_found.status, 0;
    RETURN;
  END IF;
  IF row_found.status IN ('banned', 'removed') THEN
    RETURN QUERY SELECT 'not_allowed'::text, NULL::uuid, target.id, NULL::text, 0;
    RETURN;
  END IF;
  invited := player_invited(target.id, me);
  IF target.guest_list_only AND NOT invited THEN
    RETURN QUERY SELECT 'invite_only'::text, NULL::uuid, target.id, NULL::text, 0;
    RETURN;
  END IF;
  IF cardinality(target.email_domains) > 0 AND NOT invited AND NOT EXISTS (
       SELECT 1 FROM player_contact pc
       WHERE pc.player_id = me AND split_part(pc.email, '@', 2) = ANY (target.email_domains)) THEN
    RETURN QUERY SELECT 'domain_required'::text, NULL::uuid, target.id, NULL::text, 0;
    RETURN;
  END IF;
  PERFORM check_join_answers(target.id, coalesce(answers, '{}'::jsonb));
  joined_status := CASE WHEN target.access = 'private' AND NOT invited THEN 'pending' ELSE 'active' END;

  IF row_found.id IS NULL THEN
    INSERT INTO enrollment AS en (organizer_id, event_id, player_id, status, card_version, joined_via)
    VALUES (target.organizer_id, target.id, me, joined_status, card, via)
    ON CONFLICT ON CONSTRAINT enrollment_event_id_player_id_key DO NOTHING
    RETURNING en.id INTO made;
    IF made IS NULL THEN
      SELECT en.* INTO row_found FROM enrollment en WHERE en.event_id = target.id AND en.player_id = me;
      IF row_found.joined_via = 'rehearsal' THEN
        RETURN QUERY SELECT 'rehearsing'::text, NULL::uuid, target.id, NULL::text, 0;
        RETURN;
      END IF;
      RETURN QUERY SELECT 'already'::text, row_found.id, target.id, row_found.status, 0;
      RETURN;
    END IF;
  ELSE
    had_welcome := EXISTS (SELECT 1 FROM ledger_entry l WHERE l.enrollment_id = row_found.id AND l.kind = 'welcome');
    UPDATE enrollment en SET status = joined_status, card_version = card, joined_via = via, joined_at = now()
    WHERE en.id = row_found.id;
    made := row_found.id;
    DELETE FROM join_answer a WHERE a.enrollment_id = made;
  END IF;
  INSERT INTO join_answer (enrollment_id, field_id, organizer_id, event_id, value)
  SELECT made, a.key::uuid, target.organizer_id, target.id, a.value #>> '{}'
  FROM jsonb_each(coalesce(answers, '{}'::jsonb)) a;

  granted := 0;
  IF NOT had_welcome THEN
    SELECT l.score_delta::integer INTO granted FROM ledger_entry l WHERE l.enrollment_id = made AND l.kind = 'welcome';
  END IF;
  RETURN QUERY SELECT 'joined'::text, made, target.id, joined_status, coalesce(granted, 0);
END $$;

-- As 0026, plus the wipe first and the 'rehearsing' outcome before the insert and the rejoin's rewrite of joined_via.
-- An operator who already joined as a player answers 'already' as before; to rehearse they use another account.
CREATE OR REPLACE FUNCTION enroll_operator(target_event uuid, card text)
  RETURNS TABLE (outcome text, enrollment_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me uuid;
  ev event;
  assignment staff_assignment%ROWTYPE;
  row_found enrollment;
BEGIN
  SELECT p.id INTO me FROM player p WHERE p.id = app_player_id() AND p.status = 'active';
  IF me IS NULL THEN
    RAISE EXCEPTION 'not an active player' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF card IS NULL THEN
    RAISE EXCEPTION 'the join card version is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO ev FROM event WHERE id = target_event FOR SHARE;
  PERFORM ensure_rehearsal_wiped(target_event);
  SELECT * INTO assignment FROM staff_assignment sa WHERE sa.event_id = target_event AND sa.player_id = me FOR SHARE;
  IF NOT FOUND OR NOT assignment.can_play THEN
    RETURN QUERY SELECT 'not_allowed'::text, NULL::uuid;
    RETURN;
  END IF;
  IF event_status_now(ev.status, ev.starts_at, ev.ends_at) NOT IN ('scheduled', 'live') THEN
    RETURN QUERY SELECT 'ended'::text, NULL::uuid;
    RETURN;
  END IF;
  SELECT en.* INTO row_found FROM enrollment en WHERE en.event_id = ev.id AND en.player_id = me FOR UPDATE;
  IF row_found.joined_via = 'rehearsal' THEN
    RETURN QUERY SELECT 'rehearsing'::text, NULL::uuid;
    RETURN;
  END IF;
  INSERT INTO enrollment AS en (organizer_id, event_id, player_id, status, card_version, joined_via)
  VALUES (ev.organizer_id, ev.id, me, 'active', card, 'operator')
  ON CONFLICT ON CONSTRAINT enrollment_event_id_player_id_key DO NOTHING
  RETURNING en.* INTO row_found;
  IF row_found.id IS NOT NULL THEN
    RETURN QUERY SELECT 'joined'::text, row_found.id;
    RETURN;
  END IF;
  SELECT en.* INTO row_found FROM enrollment en WHERE en.event_id = ev.id AND en.player_id = me FOR UPDATE;
  IF row_found.joined_via = 'rehearsal' THEN
    RETURN QUERY SELECT 'rehearsing'::text, NULL::uuid;
  ELSIF row_found.status = 'active' THEN
    RETURN QUERY SELECT 'already'::text, row_found.id;
  ELSIF row_found.status IN ('left', 'pending') THEN
    UPDATE enrollment en SET status = 'active', card_version = card, joined_via = 'operator', joined_at = now()
    WHERE en.id = row_found.id;
    RETURN QUERY SELECT 'joined'::text, row_found.id;
  ELSE
    RETURN QUERY SELECT 'not_allowed'::text, NULL::uuid;
  END IF;
END $$;

-- ================================================================ completing a quest
-- As 0030, plus the wipe before the enrollment lock and play_phase in place of the live check: a rehearsal account
-- completes on a Draft or Scheduled event (with the quest's own window as written).
CREATE OR REPLACE FUNCTION record_completion(target uuid, who uuid, proof_method text, proof_version integer,
                                             typed_code text, request_key text, device uuid, operator uuid,
                                             staff uuid, reason text, expected_event uuid)
  RETURNS TABLE (completion_id bigint, points bigint, occurrence integer, score bigint, balance bigint,
                 replayed boolean)
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  quest_row     quest%ROWTYPE;
  enrolled      enrollment%ROWTYPE;
  ev            event%ROWTYPE;
  earlier       quest_completion%ROWTYPE;
  earlier_by    uuid;
  earlier_staff uuid;
  done_count    integer;
  made          bigint;
  entry         bigint;
BEGIN
  SELECT * INTO quest_row FROM quest WHERE id = target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quest not found' USING ERRCODE = 'QC404';
  END IF;
  IF quest_row.event_id IS DISTINCT FROM expected_event THEN
    RAISE EXCEPTION 'no such quest in this event' USING ERRCODE = 'AQ404';
  END IF;
  PERFORM ensure_rehearsal_wiped(quest_row.event_id);
  SELECT * INTO enrolled FROM enrollment WHERE event_id = quest_row.event_id AND player_id = who FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quest not found' USING ERRCODE = 'QC404';
  END IF;

  SELECT * INTO earlier FROM quest_completion c
  WHERE c.enrollment_id = enrolled.id AND c.idempotency_key = request_key;
  IF FOUND THEN
    SELECT l.operator_id, l.staff_user_id INTO earlier_by, earlier_staff
    FROM ledger_entry l WHERE l.completion_id = earlier.id AND l.kind = 'quest';
    IF earlier.quest_id <> target OR earlier.method <> proof_method OR earlier_by IS DISTINCT FROM operator
       OR earlier_staff IS DISTINCT FROM staff THEN
      RAISE EXCEPTION 'this key was used for another completion' USING ERRCODE = 'QK422';
    END IF;
    RETURN QUERY SELECT earlier.id, l.score_delta, earlier.occurrence, enrolled.score, enrolled.balance, true
      FROM ledger_entry l WHERE l.completion_id = earlier.id AND l.kind = 'quest';
    RETURN;
  END IF;

  IF enrolled.status <> 'active' THEN
    RAISE EXCEPTION 'enrollment not active' USING ERRCODE = 'QC403', DETAIL = enrolled.status;
  END IF;
  SELECT * INTO ev FROM event e WHERE e.id = quest_row.event_id;
  IF play_phase(ev, enrolled) IS NULL THEN
    RAISE EXCEPTION 'quest not open' USING ERRCODE = 'QN403', DETAIL = 'event_not_live';
  END IF;
  IF NOT quest_row.visible THEN
    RAISE EXCEPTION 'quest not open' USING ERRCODE = 'QN403', DETAIL = 'hidden';
  END IF;
  IF quest_row.opens_at IS NOT NULL AND quest_row.opens_at > now() THEN
    RAISE EXCEPTION 'quest not open' USING ERRCODE = 'QN403', DETAIL = 'not_started';
  END IF;
  IF quest_row.closes_at IS NOT NULL AND quest_row.closes_at <= now() THEN
    RAISE EXCEPTION 'quest not open' USING ERRCODE = 'QN403', DETAIL = 'ended';
  END IF;

  IF proof_method <> 'manual' THEN
    IF NOT ((quest_row.type = 'scan_qr' AND proof_method = 'qr' AND 'quest_qr' = ANY (quest_row.verification))
            OR (quest_row.type = 'scan_qr' AND proof_method = 'my_qr' AND 'my_qr' = ANY (quest_row.verification))
            OR (quest_row.type = 'enter_code' AND proof_method = 'code')) THEN
      RAISE EXCEPTION 'bad proof' USING ERRCODE = 'QV422', DETAIL = 'wrong_method';
    END IF;
    IF proof_method = 'qr' AND proof_version IS DISTINCT FROM quest_row.qr_version THEN
      RAISE EXCEPTION 'bad proof' USING ERRCODE = 'QV422', DETAIL = 'old';
    END IF;
    IF proof_method = 'code' AND (typed_code IS NULL OR typed_code IS DISTINCT FROM quest_row.type_config ->> 'code') THEN
      RAISE EXCEPTION 'bad proof' USING ERRCODE = 'QV422', DETAIL = 'wrong_code';
    END IF;
  END IF;

  IF operator IS NOT NULL AND EXISTS (
    SELECT 1 FROM ledger_entry l
    WHERE l.operator_id = operator AND l.quest_id = target AND l.enrollment_id = enrolled.id AND l.kind = 'quest'
      AND l.created_at > now() - interval '10 seconds') THEN
    RAISE EXCEPTION 'already completed' USING ERRCODE = 'QD409', DETAIL = quest_row.repeat_cap::text;
  END IF;

  SELECT count(*) INTO done_count FROM quest_completion c
  WHERE c.enrollment_id = enrolled.id AND c.quest_id = target;
  IF done_count >= quest_row.repeat_cap THEN
    RAISE EXCEPTION 'already completed' USING ERRCODE = 'QD409', DETAIL = quest_row.repeat_cap::text;
  END IF;

  INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                idempotency_key, device_id)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, target, done_count + 1, proof_method,
          request_key, device)
  RETURNING id INTO made;
  INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                            completion_id, quest_id, actor, operator_id, staff_user_id)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, 'quest', quest_row.points, quest_row.points, made, target,
          CASE WHEN operator IS NOT NULL THEN 'operator' WHEN staff IS NOT NULL THEN 'staff' ELSE 'player' END,
          operator, staff)
  RETURNING id INTO entry;
  IF proof_method = 'manual' THEN
    INSERT INTO ledger_note (entry_id, organizer_id, event_id, reason)
    VALUES (entry, enrolled.organizer_id, enrolled.event_id, clean_reason(reason));
  END IF;

  RETURN QUERY SELECT made, quest_row.points::bigint, done_count + 1, e.score, e.balance, false
    FROM enrollment e WHERE e.id = enrolled.id;
END $$;

-- ================================================================ awards by hand
-- As 0030, plus the wipe first and play_phase in place of the live check.
CREATE OR REPLACE FUNCTION grant_manual_award(ev event, target_enrollment uuid, target_quest uuid, amount integer,
                                              reason text, request_key text, operator uuid, staff uuid,
                                              capped boolean)
  RETURNS TABLE (entry_id bigint, points bigint, replayed boolean)
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  enrolled  enrollment%ROWTYPE;
  quest_row quest%ROWTYPE;
  earlier   manual_award_key%ROWTYPE;
  worth     bigint;
  used      bigint;
  why       text;
  made      bigint;
  done      record;
BEGIN
  IF (target_quest IS NULL) = (amount IS NULL) THEN
    RAISE EXCEPTION 'award a quest or an amount' USING ERRCODE = 'AP400';
  END IF;
  IF request_key IS NULL OR length(request_key) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'an idempotency key is required' USING ERRCODE = 'AK422';
  END IF;
  PERFORM ensure_rehearsal_wiped(ev.id);

  IF amount IS NOT NULL THEN
    SELECT k.* INTO earlier FROM manual_award_key k
    WHERE k.event_id = ev.id AND k.idempotency_key = request_key
      AND k.operator_id IS NOT DISTINCT FROM operator AND k.staff_user_id IS NOT DISTINCT FROM staff;
    IF FOUND THEN
      IF earlier.kind <> 'award' OR earlier.enrollment_id <> target_enrollment OR earlier.amount <> amount THEN
        RAISE EXCEPTION 'this key was used for another award' USING ERRCODE = 'AK422';
      END IF;
      RETURN QUERY SELECT earlier.entry_id, earlier.amount, true;
      RETURN;
    END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM quest q WHERE q.id = target_quest AND q.event_id = ev.id) THEN
    RAISE EXCEPTION 'no such quest in this event' USING ERRCODE = 'AQ404';
  ELSIF EXISTS (SELECT 1 FROM quest_completion c
                WHERE c.enrollment_id = target_enrollment AND c.idempotency_key = request_key) THEN
    SELECT n.* INTO enrolled FROM enrollment n WHERE n.id = target_enrollment AND n.event_id = ev.id;
    SELECT * INTO done FROM record_completion(target_quest, enrolled.player_id, 'manual', NULL, NULL, request_key, NULL,
                                              operator, staff, reason, ev.id);
    RETURN QUERY SELECT l.id, done.points, done.replayed FROM ledger_entry l
      WHERE l.completion_id = done.completion_id AND l.kind = 'quest';
    RETURN;
  END IF;

  why := clean_reason(reason);
  SELECT n.* INTO enrolled FROM enrollment n WHERE n.id = target_enrollment AND n.event_id = ev.id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such player in this event' USING ERRCODE = 'QC404';
  END IF;
  IF operator IS NOT NULL AND enrolled.player_id = operator THEN
    RAISE EXCEPTION 'an operator cannot award themselves' USING ERRCODE = 'AY409';
  END IF;
  IF enrolled.status <> 'active' THEN
    RAISE EXCEPTION 'enrollment not active' USING ERRCODE = 'QC403', DETAIL = enrolled.status;
  END IF;
  IF play_phase(ev, enrolled) IS NULL THEN
    RAISE EXCEPTION 'quest not open' USING ERRCODE = 'QN403', DETAIL = 'event_not_live';
  END IF;

  IF target_quest IS NOT NULL THEN
    SELECT q.* INTO quest_row FROM quest q WHERE q.id = target_quest AND q.event_id = ev.id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'no such quest in this event' USING ERRCODE = 'AQ404';
    END IF;
    worth := quest_row.points;
  ELSE
    IF amount NOT BETWEEN 1 AND 100000 THEN
      RAISE EXCEPTION 'an amount of 1 to 100000 points' USING ERRCODE = 'AP400';
    END IF;
    worth := amount;
  END IF;

  IF capped THEN
    used := awarded_today(ev, operator, staff);
    IF worth > ev.award_cap_each THEN
      RAISE EXCEPTION 'over the cap per award' USING ERRCODE = 'AC409', DETAIL = 'each',
        HINT = ev.award_cap_each || ',' || greatest(ev.award_cap_day - used, 0);
    END IF;
    IF used + worth > ev.award_cap_day THEN
      RAISE EXCEPTION 'over the daily cap' USING ERRCODE = 'AC409', DETAIL = 'day',
        HINT = ev.award_cap_day || ',' || greatest(ev.award_cap_day - used, 0);
    END IF;
  END IF;

  IF target_quest IS NOT NULL THEN
    SELECT * INTO done FROM record_completion(target_quest, enrolled.player_id, 'manual', NULL, NULL, request_key, NULL,
                                              operator, staff, why, ev.id);
    RETURN QUERY SELECT l.id, done.points, done.replayed FROM ledger_entry l
      WHERE l.completion_id = done.completion_id AND l.kind = 'quest';
  ELSE
    INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor,
                              operator_id, staff_user_id)
    VALUES (ev.organizer_id, ev.id, enrolled.id, 'award', worth, worth,
            CASE WHEN operator IS NOT NULL THEN 'operator' ELSE 'staff' END, operator, staff)
    RETURNING id INTO made;
    INSERT INTO ledger_note (entry_id, organizer_id, event_id, reason) VALUES (made, ev.organizer_id, ev.id, why);
    INSERT INTO manual_award_key (event_id, operator_id, staff_user_id, idempotency_key, kind, enrollment_id, amount,
                                  entry_id)
    VALUES (ev.id, operator, staff, request_key, 'award', enrolled.id, worth, made);
    RETURN QUERY SELECT made, worth, false;
  END IF;
  PERFORM mark_ranking_repair(ev.id);
END $$;

-- The award form's "live" means "awards work now": live, or rehearsal before go-live (a real player is still refused
-- before go-live by grant_manual_award).
CREATE OR REPLACE FUNCTION operator_award_state(target_event uuid)
  RETURNS TABLE (cap_each integer, cap_day integer, left_today bigint, live boolean)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me uuid := app_player_id();
  ev event;
BEGIN
  IF me IS NULL OR NOT EXISTS (SELECT 1 FROM staff_assignment sa WHERE sa.event_id = target_event AND sa.player_id = me)
  THEN
    RAISE EXCEPTION 'not an operator of this event' USING ERRCODE = 'OP403';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM staff_assignment sa
                 WHERE sa.event_id = target_event AND sa.player_id = me AND 'award' = ANY (sa.abilities)) THEN
    RAISE EXCEPTION 'awarding is off for this operator' USING ERRCODE = 'OA403';
  END IF;
  SELECT * INTO ev FROM event WHERE id = target_event;
  RETURN QUERY SELECT ev.award_cap_each, ev.award_cap_day,
                      greatest(ev.award_cap_day - awarded_today(ev, me, NULL), 0),
                      event_status_now(ev.status, ev.starts_at, ev.ends_at) IN ('live', 'draft', 'scheduled');
END $$;

-- As 0031 (removal), plus the wipe first; a rehearsal entry may be removed before go-live, a real one while the event
-- is live or ended.
CREATE OR REPLACE FUNCTION remove_award(target_event uuid, target_entry bigint, reason text, request_key text,
                                        request uuid)
  RETURNS TABLE (entry_id bigint, score_delta bigint, balance_delta bigint, replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev       event := award_event_of(target_event);
  me       uuid := app_staff_user_id();
  credit   ledger_entry%ROWTYPE;
  enrolled enrollment%ROWTYPE;
  earlier  manual_award_key%ROWTYPE;
  why      text;
  take_s   bigint;
  take_b   bigint;
  made     bigint;
  st       text;
BEGIN
  IF request_key IS NULL OR length(request_key) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'an idempotency key is required' USING ERRCODE = 'AK422';
  END IF;
  PERFORM ensure_rehearsal_wiped(ev.id);
  SELECT k.* INTO earlier FROM manual_award_key k
  WHERE k.event_id = ev.id AND k.staff_user_id = me AND k.idempotency_key = request_key;
  IF FOUND THEN
    IF earlier.kind <> 'removal' OR earlier.reverses <> target_entry THEN
      RAISE EXCEPTION 'this key was used for another removal' USING ERRCODE = 'AK422';
    END IF;
    RETURN QUERY SELECT l.id, l.score_delta, l.balance_delta, true FROM ledger_entry l WHERE l.id = earlier.entry_id;
    RETURN;
  END IF;

  why := clean_reason(reason);
  SELECT l.* INTO credit FROM ledger_entry l WHERE l.id = target_entry AND l.event_id = ev.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such entry in this event' USING ERRCODE = 'AE404';
  END IF;
  IF credit.kind NOT IN ('quest', 'award', 'welcome') THEN
    RAISE EXCEPTION 'only an award can be removed' USING ERRCODE = 'AT422';
  END IF;
  st := event_status_now(ev.status, ev.starts_at, ev.ends_at);
  IF (CASE WHEN credit.rehearsal THEN st NOT IN ('draft', 'scheduled') ELSE st NOT IN ('live', 'ended') END) THEN
    RAISE EXCEPTION 'the event is not live or ended' USING ERRCODE = 'AS409';
  END IF;
  SELECT n.* INTO enrolled FROM enrollment n WHERE n.id = credit.enrollment_id FOR NO KEY UPDATE;
  IF EXISTS (SELECT 1 FROM ledger_entry l WHERE l.reverses = credit.id AND l.kind = 'removal') THEN
    RAISE EXCEPTION 'already removed' USING ERRCODE = 'AD409';
  END IF;

  take_s := least(credit.score_delta, enrolled.score);
  take_b := least(credit.balance_delta, enrolled.balance);
  IF (take_s < credit.score_delta OR take_b < credit.balance_delta)
     AND EXISTS (SELECT 1 FROM redemption d WHERE d.enrollment_id = enrolled.id AND d.status = 'reserved') THEN
    RAISE EXCEPTION 'cancel the player''s reserved prize first' USING ERRCODE = 'AO409';
  END IF;

  INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, completion_id,
                            quest_id, actor, staff_user_id, reverses)
  VALUES (ev.organizer_id, ev.id, enrolled.id, 'removal', -take_s, -take_b, credit.completion_id, credit.quest_id,
          'staff', me, credit.id)
  RETURNING id INTO made;
  INSERT INTO ledger_note (entry_id, organizer_id, event_id, reason) VALUES (made, ev.organizer_id, ev.id, why);
  INSERT INTO manual_award_key (event_id, staff_user_id, idempotency_key, kind, enrollment_id, reverses, entry_id)
  VALUES (ev.id, me, request_key, 'removal', enrolled.id, credit.id, made);
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before, after,
                         request_id)
  VALUES ('staff', me, ev.organizer_id, ev.id, 'event.award_removed', 'ledger_entry', credit.id::text,
          jsonb_build_object('score', enrolled.score, 'balance', enrolled.balance),
          jsonb_build_object('entry', made, 'score', enrolled.score - take_s, 'balance', enrolled.balance - take_b),
          request);
  PERFORM mark_ranking_repair(ev.id);
  RETURN QUERY SELECT made, -take_s, -take_b, false;
END $$;

-- As 0030, but a rehearsal account is always a target (the play switch governs the live game).
CREATE OR REPLACE FUNCTION quest_bulk_targets(ev event, target_quest uuid) RETURNS SETOF uuid
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT DISTINCT n.id
  FROM ledger_entry l
  JOIN enrollment n ON n.id = l.enrollment_id
  WHERE l.event_id = ev.id AND l.quest_id = target_quest AND l.kind = 'quest' AND n.status = 'active'
    AND NOT EXISTS (SELECT 1 FROM ledger_entry r WHERE r.reverses = l.id)
    AND (n.joined_via = 'rehearsal'
         OR NOT EXISTS (SELECT 1 FROM staff_assignment sa WHERE sa.event_id = ev.id AND sa.player_id = n.player_id
                        AND NOT sa.can_play))
$$;

-- As 0030, plus the wipe first and the phase: live reaches real members only; before go-live, rehearsal accounts only
-- (none in the list: QN403 as before), and the bulk is marked rehearsal so the wipe takes it.
CREATE OR REPLACE FUNCTION bulk_award(target_event uuid, enrollments uuid[], target_quest uuid, amount integer,
                                      reason text, request_key text, request uuid)
  RETURNS TABLE (bulk_id uuid, awarded integer, skipped integer, replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev         event := award_event_of(target_event);
  me         uuid := app_staff_user_id();
  earlier    bulk_award%ROWTYPE;
  why        text;
  asked      integer;
  candidates uuid[];
  targets    uuid[];
  made       uuid;
  got        integer;
  st         text;
  rehearsing boolean;
BEGIN
  IF (enrollments IS NULL) = (target_quest IS NULL) OR coalesce(cardinality(enrollments), 0) > 2000 THEN
    RAISE EXCEPTION 'a list of at most 2000 members, or a quest' USING ERRCODE = 'AB400';
  END IF;
  IF request_key IS NULL OR length(request_key) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'an idempotency key is required' USING ERRCODE = 'AK422';
  END IF;
  PERFORM ensure_rehearsal_wiped(ev.id);
  asked := coalesce(cardinality(enrollments), 0);
  SELECT b.* INTO earlier FROM bulk_award b
  WHERE b.event_id = ev.id AND b.staff_user_id = me AND b.idempotency_key = request_key;
  IF FOUND THEN
    IF earlier.amount IS DISTINCT FROM amount OR earlier.quest_id IS DISTINCT FROM target_quest
       OR earlier.requested IS DISTINCT FROM asked THEN
      RAISE EXCEPTION 'this key was used for another bulk award' USING ERRCODE = 'AK422';
    END IF;
    RETURN QUERY SELECT earlier.id, earlier.awarded, earlier.skipped, true;
    RETURN;
  END IF;

  why := clean_reason(reason);
  IF amount IS NULL OR amount NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'an amount of 1 to 100000 points' USING ERRCODE = 'AP400';
  END IF;
  IF NOT app_is_owner(ev.organizer_id) AND amount > ev.award_cap_each THEN
    RAISE EXCEPTION 'over the cap per award' USING ERRCODE = 'AC409', DETAIL = 'each',
      HINT = ev.award_cap_each || ',' || ev.award_cap_day;
  END IF;
  st := event_status_now(ev.status, ev.starts_at, ev.ends_at);
  rehearsing := st IN ('draft', 'scheduled');
  IF NOT rehearsing AND st <> 'live' THEN
    RAISE EXCEPTION 'quest not open' USING ERRCODE = 'QN403', DETAIL = 'event_not_live';
  END IF;
  IF target_quest IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM quest q WHERE q.id = target_quest AND q.event_id = ev.id) THEN
      RAISE EXCEPTION 'no such quest in this event' USING ERRCODE = 'AQ404';
    END IF;
    candidates := ARRAY(SELECT quest_bulk_targets(ev, target_quest));
    asked := 0;
  ELSE
    candidates := enrollments;
  END IF;
  IF rehearsing AND NOT EXISTS (SELECT 1 FROM enrollment n WHERE n.id = ANY (candidates) AND n.event_id = ev.id
                                                            AND n.joined_via = 'rehearsal') THEN
    RAISE EXCEPTION 'quest not open' USING ERRCODE = 'QN403', DETAIL = 'event_not_live';
  END IF;
  targets := ARRAY(
    WITH locked AS (
      SELECT n.id, n.player_id, n.status, n.joined_via FROM enrollment n
      WHERE n.id = ANY (candidates) AND n.event_id = ev.id
      ORDER BY n.id FOR NO KEY UPDATE
    )
    SELECT l.id FROM locked l
    WHERE l.status = 'active' AND (l.joined_via IS NOT DISTINCT FROM 'rehearsal') = rehearsing
      AND (l.joined_via = 'rehearsal'
           OR NOT EXISTS (SELECT 1 FROM staff_assignment sa WHERE sa.event_id = ev.id AND sa.player_id = l.player_id
                          AND NOT sa.can_play))
    ORDER BY l.id);

  INSERT INTO bulk_award (organizer_id, event_id, staff_user_id, amount, reason, quest_id, requested, awarded, skipped,
                          idempotency_key, rehearsal)
  VALUES (ev.organizer_id, ev.id, me, amount, why, target_quest, asked, cardinality(targets),
          greatest(asked - cardinality(targets), 0), request_key, rehearsing)
  RETURNING id INTO made;
  WITH entries AS (
    INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor,
                              staff_user_id)
    SELECT ev.organizer_id, ev.id, t.id, 'award', amount, amount, 'staff', me FROM unnest(targets) AS t(id)
    RETURNING id
  )
  INSERT INTO ledger_note (entry_id, organizer_id, event_id, bulk_id)
  SELECT entries.id, ev.organizer_id, ev.id, made FROM entries;
  GET DIAGNOSTICS got = ROW_COUNT;

  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after,
                         request_id)
  VALUES ('staff', me, ev.organizer_id, ev.id, 'event.bulk_award', 'bulk_award', made::text,
          jsonb_build_object('amount', amount, 'quest', target_quest, 'awarded', got), request);
  PERFORM mark_ranking_repair(ev.id);
  RETURN QUERY SELECT made, got, greatest(asked - got, 0), false;
END $$;

-- ================================================================ the shop
-- As 0031, plus the wipe first; in rehearsal the shop is open and the desk's hours do not apply (ADR-159). A digital
-- reward in rehearsal never touches the code pool or the stock: the redemption is delivered with no code, and the API
-- shows the test code derived from its id ('TEST-' || upper(substr(md5(id::text), 1, 8))).
CREATE OR REPLACE FUNCTION reserve_reward(target uuid, request_key text)
  RETURNS TABLE (redemption_id uuid, kind text, status text, price integer, reserved_until timestamptz,
                 balance bigint, stock_left integer, replayed boolean, code_cipher bytea)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me          uuid := app_player_id();
  found_ev    uuid;
  enrolled    enrollment%ROWTYPE;
  item        reward%ROWTYPE;
  ev          event%ROWTYPE;
  earlier     redemption%ROWTYPE;
  shop        text;
  desk        text;
  held        integer;
  code_id     bigint;
  spend_rank  integer := 0;
  pickup_from timestamptz := now();
  made        redemption%ROWTYPE;
  rehearsing  boolean;
  test_digital boolean;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT r.event_id INTO found_ev FROM reward r WHERE r.id = target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reward not found' USING ERRCODE = 'RN404';
  END IF;
  PERFORM ensure_rehearsal_wiped(found_ev);
  SELECT * INTO enrolled FROM enrollment n WHERE n.event_id = found_ev AND n.player_id = me FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reward not found' USING ERRCODE = 'RN404';
  END IF;

  SELECT * INTO earlier FROM redemption d WHERE d.enrollment_id = enrolled.id AND d.idempotency_key = request_key;
  IF FOUND THEN
    IF earlier.reward_id <> target THEN
      RAISE EXCEPTION 'this key was used for another reward' USING ERRCODE = 'RK422';
    END IF;
    RETURN QUERY SELECT earlier.id, r.kind, earlier.status, earlier.price, earlier.reserved_until, enrolled.balance,
                        r.stock_total - r.units_out, true,
                        (SELECT c.code_cipher FROM reward_code c WHERE c.redemption_id = earlier.id)
      FROM reward r WHERE r.id = target;
    RETURN;
  END IF;

  IF enrolled.status <> 'active' THEN
    RAISE EXCEPTION 'enrollment not active' USING ERRCODE = 'RA403', DETAIL = enrolled.status;
  END IF;
  IF enrolled.redeem_paused_at IS NOT NULL THEN
    RAISE EXCEPTION 'redeeming is paused for this player' USING ERRCODE = 'RP403';
  END IF;
  SELECT * INTO item FROM reward r WHERE r.id = target FOR UPDATE;
  IF item.status <> 'active' THEN
    RAISE EXCEPTION 'reward not found' USING ERRCODE = 'RN404';
  END IF;
  SELECT * INTO ev FROM event e WHERE e.id = item.event_id;
  rehearsing := play_phase(ev, enrolled) = 'rehearsal';
  shop := CASE WHEN rehearsing THEN 'open' ELSE shop_state(ev.status, ev.starts_at, ev.ends_at, ev.shop_days_after) END;
  IF shop <> 'open' THEN
    RAISE EXCEPTION 'shop not open' USING ERRCODE = 'RS403', DETAIL = shop;
  END IF;
  IF item.kind IN ('item', 'experience') AND NOT rehearsing THEN
    desk := desk_state(ev.desk_hours);
    IF desk = 'finished' THEN
      RAISE EXCEPTION 'shop not open' USING ERRCODE = 'RS403', DETAIL = 'desk_finished';
    END IF;
    IF desk = 'closed' THEN
      SELECT min(lower(w)) INTO pickup_from FROM unnest(ev.desk_hours) w WHERE lower(w) > now();
    END IF;
  END IF;
  IF item.opens_at IS NOT NULL AND item.opens_at > now() THEN
    RAISE EXCEPTION 'reward not open' USING ERRCODE = 'RW403', DETAIL = 'not_started';
  END IF;
  IF item.closes_at IS NOT NULL AND item.closes_at <= now() THEN
    RAISE EXCEPTION 'reward not open' USING ERRCODE = 'RW403', DETAIL = 'ended';
  END IF;
  IF item.units_out >= item.stock_total THEN
    RAISE EXCEPTION 'sold out' USING ERRCODE = 'RO409';
  END IF;
  IF item.per_player_limit IS NOT NULL THEN
    SELECT count(*) INTO held FROM redemption d
    WHERE d.enrollment_id = enrolled.id AND d.reward_id = target AND d.status NOT IN ('cancelled', 'expired');
    IF held >= item.per_player_limit THEN
      RAISE EXCEPTION 'limit reached' USING ERRCODE = 'RL409', DETAIL = item.per_player_limit::text;
    END IF;
  END IF;
  IF enrolled.balance < item.price THEN
    RAISE EXCEPTION 'balance too low' USING ERRCODE = 'RB422';
  END IF;
  test_digital := item.kind = 'digital' AND rehearsing;
  IF item.kind = 'digital' AND NOT rehearsing THEN
    SELECT c.id INTO code_id FROM reward_code c
    WHERE c.reward_id = target AND c.redemption_id IS NULL ORDER BY c.id LIMIT 1 FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'a digital reward''s stock and codes disagree' USING ERRCODE = 'RX500';
    END IF;
  END IF;
  IF ev.spend_lowers_rank AND play_phase(ev, enrolled) IS NOT NULL THEN
    spend_rank := -item.price;
  END IF;

  INSERT INTO redemption (organizer_id, event_id, enrollment_id, reward_id, price, idempotency_key, status,
                          reserved_until, ended_at, ended_by)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, target, item.price, request_key,
          CASE WHEN item.kind = 'digital' THEN 'delivered' ELSE 'reserved' END,
          CASE WHEN item.kind <> 'digital' THEN pickup_from + make_interval(mins => ev.pickup_minutes) END,
          CASE WHEN item.kind = 'digital' THEN now() END,
          CASE WHEN item.kind = 'digital' THEN 'delivery' END)
  RETURNING * INTO made;
  UPDATE reward_code c SET redemption_id = made.id WHERE c.id = code_id;
  IF NOT test_digital THEN
    UPDATE reward r SET units_out = r.units_out + 1 WHERE r.id = target;
  END IF;
  INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, redemption_id,
                            actor)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, 'redeem', spend_rank, -item.price, made.id, 'player');
  IF spend_rank <> 0 THEN
    INSERT INTO ranking_repair (event_id) VALUES (enrolled.event_id)
    ON CONFLICT (event_id) DO UPDATE SET marked_at = now();
  END IF;

  RETURN QUERY SELECT made.id, item.kind, made.status, made.price, made.reserved_until, n.balance,
                      item.stock_total - item.units_out - CASE WHEN test_digital THEN 0 ELSE 1 END, false,
                      (SELECT c.code_cipher FROM reward_code c WHERE c.id = code_id)
    FROM enrollment n WHERE n.id = enrolled.id;
END $$;

-- As 0029, plus the wipe first; a reservation the wipe removed meanwhile is not ended twice.
CREATE OR REPLACE FUNCTION end_reservation(target uuid, outcome text, by_whom text, who text, operator uuid)
  RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  found_row redemption%ROWTYPE;
  locked    redemption%ROWTYPE;
  paid_rank bigint;
BEGIN
  SELECT * INTO found_row FROM redemption d WHERE d.id = target;
  IF NOT FOUND THEN
    RETURN false;
  END IF;
  PERFORM ensure_rehearsal_wiped(found_row.event_id);
  PERFORM 1 FROM enrollment n WHERE n.id = found_row.enrollment_id FOR NO KEY UPDATE;
  PERFORM 1 FROM reward r WHERE r.id = found_row.reward_id FOR UPDATE;
  SELECT * INTO locked FROM redemption d WHERE d.id = target FOR UPDATE;
  IF NOT FOUND OR locked.status <> 'reserved' THEN
    RETURN false;
  END IF;
  IF outcome = 'expired' AND (locked.reserved_until > now() OR coalesce(locked.collect_until > now(), false)
                              OR coalesce(locked.offer_until > now(), false)) THEN
    RETURN false;
  END IF;
  SELECT l.score_delta INTO paid_rank FROM ledger_entry l WHERE l.redemption_id = target AND l.kind = 'redeem';
  UPDATE redemption d
  SET status = outcome, ended_at = now(), ended_by = by_whom, operator_id = operator, collect_until = NULL,
      offer_by = NULL, offer_until = NULL
  WHERE d.id = target;
  UPDATE reward r SET units_out = r.units_out - 1 WHERE r.id = locked.reward_id;
  INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, redemption_id,
                            actor, operator_id)
  VALUES (locked.organizer_id, locked.event_id, locked.enrollment_id, 'redeem_return', -paid_rank, locked.price,
          target, who, operator);
  IF paid_rank <> 0 THEN
    INSERT INTO ranking_repair (event_id) VALUES (locked.event_id)
    ON CONFLICT (event_id) DO UPDATE SET marked_at = now();
  END IF;
  RETURN true;
END $$;

-- As 0031, plus the wipe first (then the reservation is read again: the wipe may have removed it), and a rehearsal
-- account's handover ignores the desk's hours.
CREATE OR REPLACE FUNCTION finish_handover(target uuid, operator uuid, via_offer boolean) RETURNS text
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  found_row redemption%ROWTYPE;
  locked    redemption%ROWTYPE;
  enrolled  enrollment%ROWTYPE;
  ev        event%ROWTYPE;
  hold      text;
  live      boolean;
BEGIN
  SELECT * INTO found_row FROM redemption d WHERE d.id = target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reservation not found' USING ERRCODE = 'RN404';
  END IF;
  PERFORM ensure_rehearsal_wiped(found_row.event_id);
  PERFORM desk_operator(found_row.event_id, operator);
  SELECT * INTO enrolled FROM enrollment n WHERE n.id = found_row.enrollment_id FOR NO KEY UPDATE;
  PERFORM 1 FROM reward r WHERE r.id = found_row.reward_id FOR UPDATE;
  SELECT * INTO locked FROM redemption d WHERE d.id = target FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reservation not found' USING ERRCODE = 'RN404';
  END IF;

  IF locked.status = 'handed_over' AND locked.operator_id = operator THEN
    RETURN 'replayed';
  END IF;
  IF locked.status <> 'reserved' THEN
    RAISE EXCEPTION 'reservation ended' USING ERRCODE = 'RE409', DETAIL = locked.status;
  END IF;
  SELECT * INTO ev FROM event e WHERE e.id = locked.event_id;
  hold := desk_hold(enrolled, ev);
  IF hold IS NOT NULL THEN
    RAISE EXCEPTION 'the desk holds this player''s items' USING ERRCODE = 'RH409', DETAIL = hold;
  END IF;
  IF enrolled.status <> 'active' THEN
    RAISE EXCEPTION 'enrollment not active' USING ERRCODE = 'RA403', DETAIL = enrolled.status;
  END IF;
  IF enrolled.player_id = operator THEN
    RAISE EXCEPTION 'an operator does not hand over their own reservation' USING ERRCODE = 'OY409';
  END IF;
  IF ev.handover_confirm <> (CASE WHEN via_offer THEN 'desk_offer' ELSE 'collect_first' END) THEN
    RAISE EXCEPTION 'this event confirms handovers the other way' USING ERRCODE = 'RM409';
  END IF;
  IF play_phase(ev, enrolled) IS DISTINCT FROM 'rehearsal' AND desk_state(ev.desk_hours) <> 'open' THEN
    RAISE EXCEPTION 'the desk is closed' USING ERRCODE = 'RS403', DETAIL = 'desk_closed';
  END IF;
  live := CASE WHEN via_offer THEN locked.offer_by = operator AND locked.offer_until > now()
               ELSE locked.collect_until > now() END;
  live := coalesce(live, false);
  IF locked.reserved_until <= now() AND NOT live THEN
    RAISE EXCEPTION 'reservation ended' USING ERRCODE = 'RE409', DETAIL = 'expired';
  END IF;
  IF NOT live AND via_offer THEN
    RAISE EXCEPTION 'no live offer' USING ERRCODE = 'RO410';
  END IF;
  IF NOT live THEN
    RAISE EXCEPTION 'the player has not tapped Collect' USING ERRCODE = 'RC409';
  END IF;

  UPDATE redemption d
  SET status = 'handed_over', ended_at = now(), ended_by = 'handover', operator_id = operator, collect_until = NULL,
      offer_by = NULL, offer_until = NULL
  WHERE d.id = target;
  INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, redemption_id,
                            actor, operator_id)
  VALUES (locked.organizer_id, locked.event_id, locked.enrollment_id, 'handover', 0, 0, target, 'operator', operator);
  RETURN 'handed_over';
END $$;

-- As 0031, plus the wipe first and the rehearsal desk.
CREATE OR REPLACE FUNCTION desk_hand_over(target uuid)
  RETURNS TABLE (status text, offer_until timestamptz, replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me        uuid := app_player_id();
  found_row redemption%ROWTYPE;
  locked    redemption%ROWTYPE;
  enrolled  enrollment%ROWTYPE;
  ev        event%ROWTYPE;
  answer    text;
  hold      text;
  until     timestamptz;
BEGIN
  SELECT * INTO found_row FROM redemption d WHERE d.id = target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reservation not found' USING ERRCODE = 'RN404';
  END IF;
  PERFORM ensure_rehearsal_wiped(found_row.event_id);
  SELECT * INTO ev FROM event e WHERE e.id = found_row.event_id;
  IF ev.handover_confirm = 'collect_first' THEN
    answer := finish_handover(target, me, false);
    RETURN QUERY SELECT 'handed_over'::text, NULL::timestamptz, answer = 'replayed';
    RETURN;
  END IF;

  PERFORM desk_operator(found_row.event_id, me);
  SELECT * INTO enrolled FROM enrollment n WHERE n.id = found_row.enrollment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reservation not found' USING ERRCODE = 'RN404';
  END IF;
  IF enrolled.player_id = me THEN
    RAISE EXCEPTION 'an operator does not hand over their own reservation' USING ERRCODE = 'OY409';
  END IF;
  SELECT * INTO locked FROM redemption d WHERE d.id = target FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reservation not found' USING ERRCODE = 'RN404';
  END IF;
  IF locked.status = 'handed_over' AND locked.operator_id = me THEN
    RETURN QUERY SELECT 'handed_over'::text, NULL::timestamptz, true;
    RETURN;
  END IF;
  IF locked.status <> 'reserved' THEN
    RAISE EXCEPTION 'reservation ended' USING ERRCODE = 'RE409', DETAIL = locked.status;
  END IF;
  hold := desk_hold(enrolled, ev);
  IF hold IS NOT NULL THEN
    RAISE EXCEPTION 'the desk holds this player''s items' USING ERRCODE = 'RH409', DETAIL = hold;
  END IF;
  IF enrolled.status <> 'active' THEN
    RAISE EXCEPTION 'enrollment not active' USING ERRCODE = 'RA403', DETAIL = enrolled.status;
  END IF;
  IF play_phase(ev, enrolled) IS DISTINCT FROM 'rehearsal' AND desk_state(ev.desk_hours) <> 'open' THEN
    RAISE EXCEPTION 'the desk is closed' USING ERRCODE = 'RS403', DETAIL = 'desk_closed';
  END IF;
  IF locked.reserved_until <= now() AND coalesce(locked.offer_until <= now(), true) THEN
    RAISE EXCEPTION 'reservation ended' USING ERRCODE = 'RE409', DETAIL = 'expired';
  END IF;
  UPDATE redemption d
  SET offer_by = me,
      offer_until = CASE WHEN locked.reserved_until <= now() THEN locked.offer_until
                         ELSE now() + interval '2 minutes' END
  WHERE d.id = target RETURNING d.offer_until INTO until;
  RETURN QUERY SELECT 'offered'::text, until, false;
END $$;

-- As 0031, plus the wipe first and the rehearsal desk.
CREATE OR REPLACE FUNCTION start_collect(target uuid) RETURNS timestamptz
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me     uuid := app_player_id();
  mine   redemption%ROWTYPE := my_desk_redemption(target, app_player_id());
  ev     event%ROWTYPE;
  joined enrollment%ROWTYPE;
  locked redemption%ROWTYPE;
  until  timestamptz;
BEGIN
  PERFORM ensure_rehearsal_wiped(mine.event_id);
  SELECT * INTO ev FROM event e WHERE e.id = mine.event_id;
  IF ev.handover_confirm <> 'collect_first' THEN
    RAISE EXCEPTION 'this event confirms handovers the other way' USING ERRCODE = 'RM409';
  END IF;
  SELECT n.* INTO joined FROM enrollment n WHERE n.id = mine.enrollment_id AND n.player_id = me;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reservation not found' USING ERRCODE = 'RN404';
  END IF;
  IF play_phase(ev, joined) IS DISTINCT FROM 'rehearsal' AND desk_state(ev.desk_hours) <> 'open' THEN
    RAISE EXCEPTION 'the desk is closed' USING ERRCODE = 'RS403', DETAIL = 'desk_closed';
  END IF;
  IF joined.status <> 'active' THEN
    RAISE EXCEPTION 'enrollment not active' USING ERRCODE = 'RA403', DETAIL = joined.status;
  END IF;
  IF joined.redeem_paused_at IS NOT NULL THEN
    RAISE EXCEPTION 'redeeming is paused for this player' USING ERRCODE = 'RP403';
  END IF;
  SELECT * INTO locked FROM redemption d WHERE d.id = target FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'reservation not found' USING ERRCODE = 'RN404';
  END IF;
  IF locked.status <> 'reserved' THEN
    RAISE EXCEPTION 'reservation ended' USING ERRCODE = 'RE409', DETAIL = locked.status;
  END IF;
  IF locked.reserved_until <= now() AND coalesce(locked.collect_until <= now(), true) THEN
    RAISE EXCEPTION 'reservation ended' USING ERRCODE = 'RE409', DETAIL = 'expired';
  END IF;
  UPDATE redemption d
  SET collect_until = CASE WHEN locked.reserved_until <= now() THEN locked.collect_until
                           ELSE now() + interval '5 minutes' END
  WHERE d.id = target RETURNING d.collect_until INTO until;
  RETURN until;
END $$;

-- The desk's header: before go-live the desk is the team's rehearsal desk, open whatever its hours.
CREATE OR REPLACE FUNCTION operator_desk(target_event uuid)
  RETURNS TABLE (desk_location_ar text, desk_location_en text, desk_lat numeric, desk_lng numeric,
                 desk_opens timestamptz[], desk_closes timestamptz[], desk_state text, handover_confirm text,
                 timezone text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM desk_operator(target_event, app_player_id());
  RETURN QUERY
  SELECT e.desk_location_ar, e.desk_location_en, e.desk_lat, e.desk_lng,
         (SELECT array_agg(lower(w) ORDER BY lower(w)) FROM unnest(e.desk_hours) w),
         (SELECT array_agg(upper(w) ORDER BY lower(w)) FROM unnest(e.desk_hours) w),
         CASE WHEN event_status_now(e.status, e.starts_at, e.ends_at) IN ('draft', 'scheduled') THEN 'open'
              ELSE desk_state(e.desk_hours) END,
         e.handover_confirm, e.timezone
  FROM event e WHERE e.id = target_event;
END $$;

-- The shop's header: a rehearsal account sees the shop and the desk open and spending lowering rank as live would.
CREATE OR REPLACE FUNCTION event_shop(target uuid)
  RETURNS TABLE (state text, closes_at timestamptz, pickup_minutes integer, rules_ar text, rules_en text,
                 balance bigint, first_redemption boolean, spend_lowers_rank boolean, desk_location_ar text,
                 desk_location_en text, desk_lat numeric, desk_lng numeric, desk_opens timestamptz[],
                 desk_closes timestamptz[], desk_state text, handover_confirm text, timezone text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN play_phase(e, n) = 'rehearsal' THEN 'open'
              ELSE shop_state(e.status, e.starts_at, e.ends_at, e.shop_days_after) END,
         e.ends_at + make_interval(days => e.shop_days_after), e.pickup_minutes, e.shop_rules_ar, e.shop_rules_en,
         n.balance, NOT EXISTS (SELECT 1 FROM redemption d WHERE d.enrollment_id = n.id),
         e.spend_lowers_rank AND play_phase(e, n) IS NOT NULL,
         e.desk_location_ar, e.desk_location_en, e.desk_lat, e.desk_lng,
         (SELECT array_agg(lower(w) ORDER BY lower(w)) FROM unnest(e.desk_hours) w),
         (SELECT array_agg(upper(w) ORDER BY lower(w)) FROM unnest(e.desk_hours) w),
         CASE WHEN play_phase(e, n) = 'rehearsal' THEN 'open' ELSE desk_state(e.desk_hours) END,
         e.handover_confirm, e.timezone
  FROM enrollment n JOIN event e ON e.id = n.event_id JOIN player p ON p.id = n.player_id
  WHERE n.event_id = target AND n.player_id = app_player_id() AND n.status = 'active' AND p.status = 'active'
$$;

-- ================================================================ the team's players list marks rehearsal accounts
-- As 0031, plus `rehearsal`: the Players page badges a rehearsal account (it goes at go-live).
DROP FUNCTION event_players(uuid, uuid, integer, text);
CREATE FUNCTION event_players(target uuid, after_id uuid, page integer, prefix text)
  RETURNS TABLE (enrollment_id uuid, username text, avatar text, status text, score bigint, joined_at timestamptz,
                 open_flag bigint, redeem_paused boolean, rehearsal boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT n.id, p.username, p.avatar, n.status, n.score, n.joined_at,
         (SELECT min(f.id) FROM flag f WHERE f.enrollment_id = n.id AND f.status = 'open'),
         n.redeem_paused_at IS NOT NULL,
         n.joined_via IS NOT DISTINCT FROM 'rehearsal'
  FROM event ev
  JOIN enrollment n ON n.event_id = ev.id
  JOIN player p ON p.id = n.player_id
  WHERE ev.id = target
    AND ev.organizer_id = app_organizer_id() AND in_event_scope(ev.id, app_event_scope())
    AND (prefix IS NULL OR username_fold(p.username) LIKE
         replace(replace(replace(username_fold(left(prefix, 30)), '\', '\'), '%', '\%'), '_', '\_') || '%')
    AND (after_id IS NULL
         OR NOT EXISTS (SELECT 1 FROM enrollment c WHERE c.id = after_id AND c.event_id = target)
         OR (n.joined_at, n.id) > (SELECT c.joined_at, c.id FROM enrollment c WHERE c.id = after_id AND c.event_id = target))
  ORDER BY n.joined_at, n.id
  LIMIT least(greatest(page, 1), 100)
$$;
REVOKE ALL ON FUNCTION event_players(uuid, uuid, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION event_players(uuid, uuid, integer, text) TO questify_app;
