-- Event builder and lifecycle (T-102). Status is never written by the API's role: events start as drafts, Questify
-- activates them (T-210), time moves them from scheduled to live to ended, and only the owner ends one early.
-- Deny by default (docs/rules.md): column grants, guards for the API's role, definer functions executable by
-- questify_app only.

-- ================================================================ new fields (FR-1001, FR-1002)
ALTER TABLE event
  ADD COLUMN kind text NOT NULL DEFAULT 'physical' CHECK (kind IN ('physical', 'virtual', 'workplace')),
  ADD COLUMN venue_ar text CHECK (length(venue_ar) <= 200),
  ADD COLUMN venue_en text CHECK (length(venue_en) <= 200),
  ADD COLUMN join_methods text[] NOT NULL DEFAULT ARRAY['code', 'qr', 'link']
    CHECK (cardinality(join_methods) > 0
           AND join_methods <@ ARRAY['code', 'qr', 'link', 'public_list']),
  ADD CONSTRAINT event_public_list_needs_public CHECK (NOT ('public_list' = ANY (join_methods)) OR access = 'public'),
  ADD CONSTRAINT event_name_length CHECK (length(name_ar) <= 120 AND length(name_en) <= 120),
  -- Out of draft, an event always has its times: the tick moves it by them, and no role can drop them.
  ADD CONSTRAINT event_times_once_active CHECK (status = 'draft' OR (starts_at IS NOT NULL AND ends_at IS NOT NULL));

-- What the lifecycle tick looks for every half minute.
CREATE INDEX event_due_to_start ON event (starts_at) WHERE status = 'scheduled';
CREATE INDEX event_due_to_end ON event (ends_at) WHERE status = 'live';

-- ================================================================ what the status is now
-- The stored status trails time by up to one tick; this reads it at now(), so nothing that gates play ever waits for
-- the tick. STABLE (it reads now()); the only place this rule lives.
CREATE FUNCTION event_status_now(status text, starts_at timestamptz, ends_at timestamptz) RETURNS text
  LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN status = 'scheduled' AND ends_at IS NOT NULL AND ends_at <= now() THEN 'ended'
    WHEN status = 'scheduled' AND starts_at IS NOT NULL AND starts_at <= now() THEN 'live'
    WHEN status = 'live' AND ends_at IS NOT NULL AND ends_at <= now() THEN 'ended'
    ELSE status
  END
$$;
REVOKE ALL ON FUNCTION event_status_now(text, timestamptz, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION event_status_now(text, timestamptz, timestamptz) TO questify_app;

-- ================================================================ the API's role: what it may write
REVOKE INSERT, UPDATE ON event FROM questify_app;
-- A new event is always a draft: status, config_version, id and created_at take their defaults.
GRANT INSERT (organizer_id, join_code, name_ar, name_en, kind, venue_ar, venue_en, access, join_methods, timezone,
              day_start_hour, starts_at, ends_at) ON event TO questify_app;
-- config and config_version stay writable: organizers edit their event's switches (0003, settings/store.ts).
GRANT UPDATE (name_ar, name_en, kind, venue_ar, venue_en, access, join_methods, timezone, day_start_hour, starts_at,
              ends_at, config, config_version) ON event TO questify_app;

-- A real IANA zone only (the API checks first, for a clear answer).
CREATE FUNCTION event_timezone_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'unknown time zone' USING ERRCODE = 'QE422';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION event_timezone_guard() FROM PUBLIC;
CREATE TRIGGER event_timezone_guard BEFORE INSERT OR UPDATE OF timezone ON event
  FOR EACH ROW EXECUTE FUNCTION event_timezone_guard();

-- Times are history once they have happened (FR-1608). Judged on the status at now(), so the tick's lag is no gap:
-- draft: anything; scheduled: it must stay scheduled; live: only a later end; ended or archived: nothing. Shortening a
-- live event is end_event_early, the owner's. The owner connection and the definer functions are not the API's role.
CREATE FUNCTION event_times_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  now_status text := event_status_now(OLD.status, OLD.starts_at, OLD.ends_at);
BEGIN
  IF current_user <> 'questify_app' THEN
    RETURN NEW;
  END IF;
  IF now_status = 'scheduled' AND NEW.starts_at IS NOT NULL AND NEW.starts_at <= now() THEN
    RAISE EXCEPTION 'a scheduled event must start in the future' USING ERRCODE = 'QE409';
  END IF;
  IF now_status = 'live' AND (
       NEW.starts_at IS DISTINCT FROM OLD.starts_at
       OR NEW.timezone IS DISTINCT FROM OLD.timezone
       OR NEW.day_start_hour IS DISTINCT FROM OLD.day_start_hour
       OR NEW.ends_at IS NULL OR NEW.ends_at < OLD.ends_at
     ) THEN
    RAISE EXCEPTION 'a live event keeps its start, zone and day start; its end may only move later' USING ERRCODE = 'QE409';
  END IF;
  IF now_status IN ('ended', 'archived') AND (
       NEW.starts_at IS DISTINCT FROM OLD.starts_at
       OR NEW.ends_at IS DISTINCT FROM OLD.ends_at
       OR NEW.timezone IS DISTINCT FROM OLD.timezone
       OR NEW.day_start_hour IS DISTINCT FROM OLD.day_start_hour
     ) THEN
    RAISE EXCEPTION 'an ended event keeps its times' USING ERRCODE = 'QE409';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION event_times_guard() FROM PUBLIC;
CREATE TRIGGER event_times_guard BEFORE UPDATE OF starts_at, ends_at, timezone, day_start_hour ON event
  FOR EACH ROW EXECUTE FUNCTION event_times_guard();

-- Only drafts are deleted (FR-1003): an activated event is paid for and has history.
DROP POLICY event_delete ON event;
CREATE POLICY event_delete ON event FOR DELETE TO questify_app
  USING ((organizer_id = app_organizer_id() AND in_event_scope(id, app_event_scope()) AND status = 'draft')
         OR app_is_admin());

-- ================================================================ the lifecycle (FR-1608)
-- The owner ends a live event early, after a confirmation in the dashboard.
CREATE FUNCTION end_event_early(target uuid, request uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  found_event event%ROWTYPE;
BEGIN
  SELECT * INTO found_event FROM event WHERE id = target FOR UPDATE;
  IF NOT FOUND OR NOT (app_is_admin() OR (app_is_owner(found_event.organizer_id)
                                          AND found_event.organizer_id = app_organizer_id())) THEN
    RAISE EXCEPTION 'only the owner of this event''s organizer can end it' USING ERRCODE = 'QE403';
  END IF;
  IF event_status_now(found_event.status, found_event.starts_at, found_event.ends_at) <> 'live' THEN
    RAISE EXCEPTION 'only a live event can be ended early' USING ERRCODE = 'QE409';
  END IF;
  UPDATE event SET status = 'ended', ends_at = now() WHERE id = target;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before, after,
                         request_id)
  VALUES (CASE WHEN app_is_admin() THEN 'admin' ELSE 'staff' END, app_staff_user_id(), found_event.organizer_id,
          target, 'event.end', 'event', target::text,
          jsonb_build_object('status', found_event.status, 'endsAt', found_event.ends_at),
          jsonb_build_object('status', 'ended', 'endsAt', now()), request);
END $$;
REVOKE ALL ON FUNCTION end_event_early(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION end_event_early(uuid, uuid) TO questify_app;

-- Moves every event whose time has come: scheduled to live, then live to ended, in one call (a late-activated event
-- finishes in one tick with both entries). Applies only the time rules, so anyone may call it; the API's tick does.
CREATE FUNCTION advance_event_lifecycle() RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  started integer;
  ended integer;
BEGIN
  WITH moved AS (
    UPDATE event SET status = 'live'
    WHERE status = 'scheduled' AND starts_at IS NOT NULL AND starts_at <= now()
    RETURNING id, organizer_id
  ), logged AS (
    INSERT INTO audit_log (actor_type, organizer_id, event_id, action, target_type, target_id, before, after)
    SELECT 'system', organizer_id, id, 'event.lifecycle', 'event', id::text,
           jsonb_build_object('status', 'scheduled'), jsonb_build_object('status', 'live')
    FROM moved
    RETURNING 1
  )
  SELECT count(*) INTO started FROM logged;
  WITH moved AS (
    UPDATE event SET status = 'ended'
    WHERE status = 'live' AND ends_at IS NOT NULL AND ends_at <= now()
    RETURNING id, organizer_id
  ), logged AS (
    INSERT INTO audit_log (actor_type, organizer_id, event_id, action, target_type, target_id, before, after)
    SELECT 'system', organizer_id, id, 'event.lifecycle', 'event', id::text,
           jsonb_build_object('status', 'live'), jsonb_build_object('status', 'ended')
    FROM moved
    RETURNING 1
  )
  SELECT count(*) INTO ended FROM logged;
  RETURN started + ended;
END $$;
REVOKE ALL ON FUNCTION advance_event_lifecycle() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION advance_event_lifecycle() TO questify_app;

-- Events are deleted one per statement (the API deletes one draft per request): with several in one statement, an
-- AFTER ROW pass would leave the other deleted ids in a limit and the scope guard (0008) would refuse it.
-- A deleted event leaves the editor limits that named it. A limit left with no event keeps the deleted id: the editor
-- then sees nothing, where an empty limit is impossible and NULL would widen them to every event.
CREATE FUNCTION prune_event_scopes() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE organizer_member SET event_scope = array_remove(event_scope, OLD.id)
  WHERE organizer_id = OLD.organizer_id AND OLD.id = ANY (event_scope) AND cardinality(event_scope) > 1;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION prune_event_scopes() FROM PUBLIC;
CREATE TRIGGER prune_event_scopes AFTER DELETE ON event FOR EACH ROW EXECUTE FUNCTION prune_event_scopes();
