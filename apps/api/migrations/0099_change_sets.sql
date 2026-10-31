-- Change sets (T-604b, FR-1034, FR-1035, ADR-388, Q-355): changes to an event's quests, categories and rewards grouped
-- for review before anything is applied. A set lists up to 100 items (add, edit or delete of one target); the reviewer
-- applies all of them or only the ones they select, each item through the builder's own service in its own transaction,
-- and a target that changed since the set was made is skipped as stale. The tables hold only the reviewer's record of
-- what was proposed and what happened to it: no points are written here (an item that edits points goes through the
-- live-edit door of migration 0098 inside the builder's update), and no function is created.
-- Deny by default: forced row-level security, no PUBLIC grant, no DELETE grant, column grants for the API's role alone.
-- A row is visible and writable only to an owner or an editor of its organizer inside the editor's event limit; a
-- player's or an operator's context has no staff user, so the policies show it nothing. A set and its items never change
-- their content after they are written; only the states move, once.
SET LOCAL lock_timeout = '10s';
-- The event is a foreign-key target of the new tables.
LOCK TABLE event IN SHARE ROW EXCLUSIVE MODE;

-- ================================================================ the set
-- `created_by` names the staff member without a foreign key, as ledger_entry.staff_user_id: a removed team member's set
-- stays explained. A set is `open` until every item has been decided by an apply (`applied`) or the reviewer closes it
-- (`closed`).
CREATE TABLE change_set (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id uuid NOT NULL,
  event_id     uuid NOT NULL,
  created_by   uuid NOT NULL,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'applied', 'closed')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz,
  UNIQUE (id, event_id, organizer_id),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE CASCADE,
  CONSTRAINT change_set_finished CHECK ((status = 'open') = (finished_at IS NULL))
);
CREATE INDEX change_set_event ON change_set (event_id, created_at DESC, id DESC);
ALTER TABLE change_set ENABLE ROW LEVEL SECURITY;
ALTER TABLE change_set FORCE ROW LEVEL SECURITY;
REVOKE ALL ON change_set FROM PUBLIC;

-- ================================================================ the items
-- `body` is the same JSON the builder's route takes for the operation (including the points choice `apply` or `points`),
-- at most 16 KiB. `before` is the target's audit view when the set was made (null for an add, or for a target that did
-- not exist); an item is stale when the target's view differs from it at apply time. `error` is the builder's refusal
-- (the API's error envelope) of an item that failed.
CREATE TABLE change_set_item (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  change_set_id uuid NOT NULL,
  organizer_id  uuid NOT NULL,
  event_id      uuid NOT NULL,
  position      integer NOT NULL CHECK (position BETWEEN 0 AND 99),
  op            text NOT NULL CHECK (op IN ('add', 'edit', 'delete')),
  target        text NOT NULL CHECK (target IN ('quest', 'category', 'reward')),
  target_id     uuid,
  body          jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object' AND pg_column_size(body) <= 16384),
  before        jsonb CHECK (before IS NULL OR jsonb_typeof(before) = 'object'),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'failed', 'stale')),
  error         jsonb CHECK (error IS NULL OR jsonb_typeof(error) = 'object'),
  decided_at    timestamptz,
  UNIQUE (change_set_id, position),
  FOREIGN KEY (change_set_id, event_id, organizer_id) REFERENCES change_set (id, event_id, organizer_id)
    ON DELETE CASCADE,
  CONSTRAINT change_set_item_target CHECK ((op = 'add') = (target_id IS NULL)),
  CONSTRAINT change_set_item_before CHECK (op <> 'add' OR before IS NULL),
  CONSTRAINT change_set_item_decided CHECK ((status = 'pending') = (decided_at IS NULL)),
  CONSTRAINT change_set_item_error CHECK ((status = 'failed') = (error IS NOT NULL))
);
ALTER TABLE change_set_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE change_set_item FORCE ROW LEVEL SECURITY;
REVOKE ALL ON change_set_item FROM PUBLIC;

-- ================================================================ rights
GRANT SELECT ON change_set, change_set_item TO questify_app;
GRANT INSERT (organizer_id, event_id, created_by) ON change_set TO questify_app;
GRANT UPDATE (status, finished_at) ON change_set TO questify_app;
GRANT INSERT (change_set_id, organizer_id, event_id, position, op, target, target_id, body, before)
  ON change_set_item TO questify_app;
GRANT UPDATE (status, error, decided_at) ON change_set_item TO questify_app;

-- Owners and editors inside their event limit: the organizer, a staff user (not a player or an operator) and the event.
CREATE POLICY change_set_read ON change_set FOR SELECT TO questify_app
  USING (organizer_id = app_organizer_id() AND app_staff_user_id() IS NOT NULL
         AND in_event_scope(event_id, app_event_scope()));
CREATE POLICY change_set_insert ON change_set FOR INSERT TO questify_app
  WITH CHECK (organizer_id = app_organizer_id() AND created_by = app_staff_user_id()
              AND in_event_scope(event_id, app_event_scope()));
CREATE POLICY change_set_update ON change_set FOR UPDATE TO questify_app
  USING (organizer_id = app_organizer_id() AND app_staff_user_id() IS NOT NULL
         AND in_event_scope(event_id, app_event_scope()))
  WITH CHECK (organizer_id = app_organizer_id() AND app_staff_user_id() IS NOT NULL
              AND in_event_scope(event_id, app_event_scope()));
CREATE POLICY change_set_item_member ON change_set_item FOR ALL TO questify_app
  USING (organizer_id = app_organizer_id() AND app_staff_user_id() IS NOT NULL
         AND in_event_scope(event_id, app_event_scope()))
  WITH CHECK (organizer_id = app_organizer_id() AND app_staff_user_id() IS NOT NULL
              AND in_event_scope(event_id, app_event_scope()));

-- ================================================================ the rules, in the database
-- An event holds at most 20 open sets (CS429); the advisory lock makes two sets made at once count each other.
CREATE FUNCTION change_set_limit() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('change_set:' || NEW.event_id::text, 0));
  IF (SELECT count(*) FROM change_set s WHERE s.event_id = NEW.event_id AND s.status = 'open') >= 20 THEN
    RAISE EXCEPTION 'an event holds at most 20 open change sets' USING ERRCODE = 'CS429', DETAIL = 'limit';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION change_set_limit() FROM PUBLIC;
CREATE TRIGGER change_set_limit BEFORE INSERT ON change_set FOR EACH ROW EXECUTE FUNCTION change_set_limit();

-- A set only moves from open to applied or closed, once; nothing else about it changes.
CREATE FUNCTION change_set_frozen() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF (NEW.id, NEW.organizer_id, NEW.event_id, NEW.created_by, NEW.created_at)
     IS DISTINCT FROM (OLD.id, OLD.organizer_id, OLD.event_id, OLD.created_by, OLD.created_at) THEN
    RAISE EXCEPTION 'a change set''s owner, event and author are frozen' USING ERRCODE = 'CS409', DETAIL = 'frozen';
  ELSIF OLD.status <> 'open' THEN
    RAISE EXCEPTION 'a finished change set does not change' USING ERRCODE = 'CS409', DETAIL = 'finished';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION change_set_frozen() FROM PUBLIC;
CREATE TRIGGER change_set_frozen BEFORE UPDATE ON change_set FOR EACH ROW EXECUTE FUNCTION change_set_frozen();

-- An item is written into an open set only; its content never changes; it is decided once, and only while its set is
-- open (a closed set is not applied).
CREATE FUNCTION change_set_item_into_open() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM change_set s WHERE s.id = NEW.change_set_id AND s.status <> 'open') THEN
    RAISE EXCEPTION 'items are added to an open change set only' USING ERRCODE = 'CS409', DETAIL = 'finished';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION change_set_item_into_open() FROM PUBLIC;
CREATE TRIGGER change_set_item_into_open BEFORE INSERT ON change_set_item
  FOR EACH ROW EXECUTE FUNCTION change_set_item_into_open();

CREATE FUNCTION change_set_item_frozen() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF (NEW.id, NEW.change_set_id, NEW.organizer_id, NEW.event_id, NEW.position, NEW.op, NEW.target, NEW.target_id,
      NEW.body, NEW.before)
     IS DISTINCT FROM (OLD.id, OLD.change_set_id, OLD.organizer_id, OLD.event_id, OLD.position, OLD.op, OLD.target,
                       OLD.target_id, OLD.body, OLD.before) THEN
    RAISE EXCEPTION 'a change set item''s content is frozen' USING ERRCODE = 'CS409', DETAIL = 'frozen';
  ELSIF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'a decided change set item does not change' USING ERRCODE = 'CS409', DETAIL = 'decided';
  ELSIF EXISTS (SELECT 1 FROM change_set s WHERE s.id = OLD.change_set_id AND s.status <> 'open') THEN
    RAISE EXCEPTION 'a finished change set is not applied' USING ERRCODE = 'CS409', DETAIL = 'finished';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION change_set_item_frozen() FROM PUBLIC;
CREATE TRIGGER change_set_item_frozen BEFORE UPDATE ON change_set_item
  FOR EACH ROW EXECUTE FUNCTION change_set_item_frozen();
