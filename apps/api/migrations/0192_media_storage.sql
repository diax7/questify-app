-- Photo storage, part 1 (T-301b phase 1a; plan docs/plans/2026-11-12-photo-storage.md, ADR-183, ADR-185, ADR-186).
-- The private bucket's objects are named by the database: one `media_object` row per upload, keyed
-- `o/<organizer>/e/<event>/<purpose>/<id>.jpg` from the row's own columns (a CHECK holds it), never from client input.
-- A key is deleted by construction: every `media_object` row that goes (a sweep, a purge, a released slot, its
-- event's deletion, or the submission or ticket that held it, migration 0193) queues its key in `media_delete`
-- from a BEFORE DELETE trigger, and the media worker deletes the object outside any transaction.
-- Deny by default: no table is granted to the API role; the definers below are its only doors.
--
-- Lock order (rules.md): submission or ticket -> media_object -> media_delete. A player door takes the rehearsal row
-- (ensure_rehearsal_wiped), then the caller's enrollment FOR NO KEY UPDATE, then media_object rows. The sweep takes
-- media_object rows FOR UPDATE SKIP LOCKED and never waits; the delete queue's claim takes its rows the same way.
SET LOCAL lock_timeout = '10s';

-- ================================================================ the objects
CREATE TABLE media_object (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id       uuid NOT NULL,
  event_id           uuid NOT NULL,
  -- What the object is for; organizer images (phase 2) widen this.
  purpose            text NOT NULL CHECK (purpose IN ('submission', 'ticket')),
  -- The submission's quest (purpose `submission`), kept so a replay of the key for another quest is refused. No
  -- foreign key: the event's cascade removes the row, and an insert need not key-share the quest.
  quest_id           uuid,
  key                text NOT NULL UNIQUE,
  -- reserved: a slot handed to an upload; stored: the re-encoded JPEG is in the bucket; attached: a submission or a
  -- ticket holds it. Never attached after 30 minutes, it is swept.
  state              text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved', 'stored', 'attached')),
  bytes              integer CHECK (bytes BETWEEN 1 AND 16777216),
  width              integer CHECK (width BETWEEN 1 AND 2048),
  height             integer CHECK (height BETWEEN 1 AND 2048),
  uploaded_by_player uuid NOT NULL REFERENCES player (id) ON DELETE CASCADE,
  request_key        text NOT NULL CHECK (length(request_key) BETWEEN 1 AND 255),
  created_at         timestamptz NOT NULL DEFAULT now(),
  stored_at          timestamptz,
  attached_at        timestamptz,
  UNIQUE (uploaded_by_player, request_key),
  -- The key is the row's own tenant, event, purpose and id: no row can name another organizer's object.
  CONSTRAINT media_object_key_prefix
    CHECK (key = 'o/' || organizer_id || '/e/' || event_id || '/' || purpose || '/' || id || '.jpg'),
  CHECK ((state = 'reserved') = (bytes IS NULL)),
  CHECK ((bytes IS NULL) = (width IS NULL) AND (bytes IS NULL) = (height IS NULL)),
  CHECK ((state = 'reserved') = (stored_at IS NULL)),
  CHECK ((state = 'attached') = (attached_at IS NOT NULL)),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE CASCADE
);
CREATE INDEX media_object_event_idx ON media_object (event_id);
CREATE INDEX media_object_player_idx ON media_object (uploaded_by_player, event_id, created_at);
CREATE INDEX media_object_unattached_idx ON media_object (created_at) WHERE state <> 'attached';
ALTER TABLE media_object ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_object FORCE ROW LEVEL SECURITY;
REVOKE ALL ON media_object FROM PUBLIC;

-- ================================================================ the delete queue
-- No foreign key: a key outlives its row, its event and its organizer until the bucket confirms the delete.
CREATE TABLE media_delete (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key          text NOT NULL UNIQUE CHECK (length(key) BETWEEN 1 AND 300),
  organizer_id uuid,
  due_at       timestamptz NOT NULL DEFAULT now(),
  attempts     integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  lease_until  timestamptz,
  -- The claim that holds the lease: only that claim's done may delete the row. A key queued again while leased (an
  -- upload written after its slot was swept) clears both, so the object is deleted once more after the write.
  claim        uuid,
  last_code    text CHECK (last_code IS NULL OR last_code ~ '^[a-z0-9_]{1,40}$'),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX media_delete_due_idx ON media_delete (due_at);
ALTER TABLE media_delete ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_delete FORCE ROW LEVEL SECURITY;
REVOKE ALL ON media_delete FROM PUBLIC;

-- Every object row that goes queues its key, whoever deletes it (a door, a cascade from its event, migration 0193's
-- submission and ticket triggers). Definer: a cascade runs as the table's owner, a door as its own.
CREATE FUNCTION media_object_forget() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO media_delete (key, organizer_id) VALUES (OLD.key, OLD.organizer_id) ON CONFLICT (key) DO NOTHING;
  RETURN OLD;
END $$;
REVOKE ALL ON FUNCTION media_object_forget() FROM PUBLIC;
CREATE TRIGGER media_object_forget BEFORE DELETE ON media_object
  FOR EACH ROW EXECUTE FUNCTION media_object_forget();

-- ================================================================ the upload doors
-- The seat a photo is uploaded from, refused as the door it is for would refuse it. Internal. Answers the enrollment,
-- locked FOR NO KEY UPDATE after the rehearsal row, so two uploads of one player count their cap one after the other.
CREATE FUNCTION media_seat(upload_purpose text, target_event uuid, target_quest uuid, me uuid) RETURNS enrollment
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  quest_row quest%ROWTYPE;
  enrolled  enrollment%ROWTYPE;
  ev        event%ROWTYPE;
BEGIN
  IF upload_purpose = 'submission' THEN
    SELECT * INTO quest_row FROM quest q WHERE q.id = target_quest;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'quest not found' USING ERRCODE = 'QC404';
    END IF;
    PERFORM ensure_rehearsal_wiped(quest_row.event_id);
    SELECT * INTO enrolled FROM enrollment n
    WHERE n.event_id = quest_row.event_id AND n.player_id = me FOR NO KEY UPDATE;
    IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM player p WHERE p.id = me AND p.status = 'active') THEN
      RAISE EXCEPTION 'quest not found' USING ERRCODE = 'QC404';
    END IF;
    PERFORM quest_open_check(quest_row, enrolled);
    IF quest_row.type <> 'submission' THEN
      RAISE EXCEPTION 'not a submission quest' USING ERRCODE = 'SQ422';
    END IF;
    IF NOT coalesce(quest_row.type_config -> 'accepts' ? 'photo', false) THEN
      RAISE EXCEPTION 'this quest takes no photo' USING ERRCODE = 'SM422', DETAIL = 'photo_not_accepted';
    END IF;
    RETURN enrolled;
  END IF;
  IF upload_purpose = 'ticket' THEN
    PERFORM ensure_rehearsal_wiped(target_event);
    SELECT * INTO enrolled FROM enrollment n WHERE n.event_id = target_event AND n.player_id = me FOR NO KEY UPDATE;
    IF NOT FOUND OR enrolled.status <> 'active'
       OR NOT EXISTS (SELECT 1 FROM player p WHERE p.id = me AND p.status = 'active') THEN
      RAISE EXCEPTION 'not a member of this event' USING ERRCODE = 'HT403', DETAIL = 'not_member';
    END IF;
    SELECT * INTO ev FROM event e WHERE e.id = target_event;
    IF NOT help_desk_on(ev) THEN
      RAISE EXCEPTION 'the help desk is off for this event' USING ERRCODE = 'HT403', DETAIL = 'feature_off';
    END IF;
    IF event_status_now(ev.status, ev.starts_at, ev.ends_at) NOT IN ('scheduled', 'live', 'ended')
       OR (ev.ends_at IS NOT NULL AND ev.ends_at + interval '30 days' <= now()) THEN
      RAISE EXCEPTION 'sending is closed for this event' USING ERRCODE = 'HT403', DETAIL = 'sending_closed';
    END IF;
    RETURN enrolled;
  END IF;
  RAISE EXCEPTION 'an upload purpose' USING ERRCODE = 'MD422';
END $$;
REVOKE ALL ON FUNCTION media_seat(text, uuid, uuid, uuid) FROM PUBLIC;

-- A slot for one upload by the calling player (purpose `submission`: the quest; `ticket`: the event). The same key
-- answers the same slot (a retry PUTs the same object again, or finds it stored); a key used for another purpose,
-- event or quest is QK422. A slot still reserved after 20 minutes is given up (its key queued) and a fresh one handed
-- out, so no PUT starts close to the 30-minute sweep. At most 5 slots not yet attached per player and event in 30 minutes (MD429, DETAIL the seconds to
-- wait): the one per-player rate limit on uploads.
CREATE FUNCTION media_reserve(upload_purpose text, target_event uuid, target_quest uuid, request_key text)
  RETURNS TABLE (id uuid, key text, stored boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  me       uuid := app_player_id();
  enrolled enrollment%ROWTYPE;
  earlier  media_object%ROWTYPE;
  made     media_object%ROWTYPE;
  fifth    timestamptz;
  new_id   uuid := gen_random_uuid();
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF request_key IS NULL OR length(request_key) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'a usable idempotency key is required' USING ERRCODE = 'QK422';
  END IF;
  enrolled := media_seat(upload_purpose, target_event, target_quest, me);
  SELECT * INTO earlier FROM media_object m WHERE m.uploaded_by_player = me AND m.request_key = media_reserve.request_key;
  IF FOUND THEN
    IF earlier.event_id <> enrolled.event_id OR earlier.purpose <> upload_purpose
       OR earlier.quest_id IS DISTINCT FROM target_quest THEN
      RAISE EXCEPTION 'this key was used for another upload' USING ERRCODE = 'QK422';
    END IF;
    IF earlier.state <> 'reserved' OR earlier.created_at > now() - interval '20 minutes' THEN
      RETURN QUERY SELECT earlier.id, earlier.key, earlier.state <> 'reserved';
      RETURN;
    END IF;
    DELETE FROM media_object m WHERE m.id = earlier.id;
  END IF;
  SELECT m.created_at INTO fifth FROM media_object m
  WHERE m.uploaded_by_player = me AND m.event_id = enrolled.event_id AND m.state <> 'attached'
    AND m.created_at > now() - interval '30 minutes'
  ORDER BY m.created_at DESC OFFSET 4 LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'five photos are waiting' USING ERRCODE = 'MD429',
      DETAIL = greatest(1, ceil(extract(epoch FROM fifth + interval '30 minutes' - now())))::bigint::text;
  END IF;
  INSERT INTO media_object (id, organizer_id, event_id, purpose, quest_id, key, uploaded_by_player, request_key)
  VALUES (new_id, enrolled.organizer_id, enrolled.event_id, upload_purpose,
          CASE WHEN upload_purpose = 'submission' THEN target_quest END,
          'o/' || enrolled.organizer_id || '/e/' || enrolled.event_id || '/' || upload_purpose || '/' || new_id || '.jpg',
          me, media_reserve.request_key)
  RETURNING * INTO made;
  RETURN QUERY SELECT made.id, made.key, false;
END $$;
REVOKE ALL ON FUNCTION media_reserve(text, uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION media_reserve(text, uuid, uuid, text) TO questify_app;

-- The calling player's slot now holds its re-encoded JPEG. True when stored (or stored already). False when the slot
-- is gone (swept after 30 minutes while the upload ran): the object just written is then queued for deletion by the
-- key the API was given, which must be this slot's key shape, so nothing else can be queued. A key still queued from
-- the sweep is made due again and its lease dropped: the worker may have deleted the object before this write, and
-- its done must not clear the row.
CREATE FUNCTION media_stored(target uuid, object_key text, size integer, w integer, h integer) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me   uuid := app_player_id();
  slot media_object%ROWTYPE;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO slot FROM media_object m WHERE m.id = target FOR UPDATE;
  IF FOUND THEN
    IF slot.uploaded_by_player <> me OR slot.key <> object_key THEN
      RAISE EXCEPTION 'not this player''s upload' USING ERRCODE = 'SM404';
    END IF;
    IF slot.state = 'reserved' THEN
      UPDATE media_object m SET state = 'stored', bytes = size, width = w, height = h, stored_at = now()
      WHERE m.id = target;
    END IF;
    RETURN true;
  END IF;
  IF object_key !~ ('^o/[0-9a-f-]{36}/e/[0-9a-f-]{36}/(submission|ticket)/' || target || '\.jpg$') THEN
    RAISE EXCEPTION 'not an upload key' USING ERRCODE = 'MD422';
  END IF;
  INSERT INTO media_delete (key, organizer_id)
  VALUES (object_key, substr(object_key, 3, 36)::uuid)
  ON CONFLICT (key) DO UPDATE SET due_at = now(), lease_until = NULL, claim = NULL;
  RETURN false;
END $$;
REVOKE ALL ON FUNCTION media_stored(uuid, text, integer, integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION media_stored(uuid, text, integer, integer, integer) TO questify_app;

-- Gives back the calling player's slot that was never attached (the image was refused as 415 or 422), so it does not
-- count toward the cap. Its key is queued like any other (a delete of an object never written is done at once).
CREATE FUNCTION media_release(target uuid) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me uuid := app_player_id();
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  DELETE FROM media_object m WHERE m.id = target AND m.uploaded_by_player = me AND m.state <> 'attached';
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION media_release(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION media_release(uuid) TO questify_app;

-- ================================================================ the media worker's doors (the system seat only)
CREATE FUNCTION media_system() RETURNS void
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT ranking_system() THEN
    RAISE EXCEPTION 'the media worker only' USING ERRCODE = 'insufficient_privilege';
  END IF;
END $$;
REVOKE ALL ON FUNCTION media_system() FROM PUBLIC;

-- Hands out due keys with a 5-minute lease under one claim token (SKIP LOCKED: two workers never take one key). The
-- worker deletes the objects after this transaction commits, then calls media_delete_done or media_delete_failed
-- with the token.
CREATE FUNCTION media_delete_claim(batch integer) RETURNS TABLE (id bigint, key text, claim uuid)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  token uuid := gen_random_uuid();
BEGIN
  PERFORM media_system();
  RETURN QUERY
  WITH claimed AS (
    UPDATE media_delete d SET lease_until = now() + interval '5 minutes', claim = token
    WHERE d.id IN (
      SELECT q.id FROM media_delete q
      WHERE q.due_at <= now() AND (q.lease_until IS NULL OR q.lease_until < now())
      ORDER BY q.due_at, q.id
      LIMIT least(greatest(coalesce(batch, 50), 1), 200)
      FOR UPDATE SKIP LOCKED)
    RETURNING d.id, d.key)
  SELECT claimed.id, claimed.key, token FROM claimed ORDER BY claimed.id;
END $$;
REVOKE ALL ON FUNCTION media_delete_claim(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION media_delete_claim(integer) TO questify_app;

-- The bucket confirmed these deletes (a 404 counts): their rows go, those still held by this claim only (a key queued
-- again since the claim stays for the next one).
CREATE FUNCTION media_delete_done(ids bigint[], token uuid) RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  gone integer;
BEGIN
  PERFORM media_system();
  DELETE FROM media_delete d WHERE d.id = ANY (ids) AND d.claim = token;
  GET DIAGNOSTICS gone = ROW_COUNT;
  RETURN gone;
END $$;
REVOKE ALL ON FUNCTION media_delete_done(bigint[], uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION media_delete_done(bigint[], uuid) TO questify_app;

-- A delete failed: the key waits 1, 2, 4 ... minutes, at most an hour, and keeps the failure's code. Only while this
-- claim holds it: a key queued again since stays due now.
CREATE FUNCTION media_delete_failed(target bigint, code text, token uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM media_system();
  UPDATE media_delete d
  SET attempts = d.attempts + 1, lease_until = NULL, claim = NULL, last_code = left(code, 40),
      due_at = now() + least(interval '1 hour', interval '1 minute' * power(2, least(d.attempts, 6)))
  WHERE d.id = target AND d.claim = token;
END $$;
REVOKE ALL ON FUNCTION media_delete_failed(bigint, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION media_delete_failed(bigint, text, uuid) TO questify_app;

-- Uploads never attached within 30 minutes go (their keys are queued by the trigger). SKIP LOCKED: an attach holding
-- the row FOR UPDATE keeps it, and re-checks the age itself. At most 500 a call.
CREATE FUNCTION media_sweep_uploads() RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  gone integer;
BEGIN
  PERFORM media_system();
  DELETE FROM media_object m WHERE m.id IN (
    SELECT o.id FROM media_object o
    WHERE o.state <> 'attached' AND o.created_at < now() - interval '30 minutes'
    ORDER BY o.created_at LIMIT 500
    FOR UPDATE SKIP LOCKED);
  GET DIAGNOSTICS gone = ROW_COUNT;
  RETURN gone;
END $$;
REVOKE ALL ON FUNCTION media_sweep_uploads() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION media_sweep_uploads() TO questify_app;
