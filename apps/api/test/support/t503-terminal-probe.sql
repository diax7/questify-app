CREATE SCHEMA t503_terminal;
REVOKE ALL ON SCHEMA t503_terminal FROM PUBLIC;
CREATE TABLE t503_terminal.entry (
  event_id uuid NOT NULL, enrollment_id uuid PRIMARY KEY,
  score bigint NOT NULL, score_version bigint NOT NULL
);
CREATE INDEX ON t503_terminal.entry (event_id, score DESC, score_version, enrollment_id);
CREATE TABLE t503_terminal.state (
  event_id uuid PRIMARY KEY, generation bigint NOT NULL DEFAULT 1,
  revision bigint NOT NULL DEFAULT 0, top_ids uuid[] NOT NULL
);
CREATE TABLE t503_terminal.fact (
  event_id uuid NOT NULL, generation bigint NOT NULL, revision bigint NOT NULL,
  enrollment_id uuid NOT NULL, direction text NOT NULL,
  PRIMARY KEY (event_id, generation, revision, enrollment_id)
);
CREATE TABLE t503_terminal.latest (
  event_id uuid NOT NULL, enrollment_id uuid NOT NULL,
  generation bigint NOT NULL, revision bigint NOT NULL,
  PRIMARY KEY (event_id, enrollment_id)
);
CREATE FUNCTION t503_terminal.has_event_lock(target uuid) RETURNS boolean
LANGUAGE sql AS $$
  SELECT EXISTS (SELECT FROM pg_locks WHERE pid = pg_backend_pid() AND granted
    AND locktype = 'advisory' AND classid = 506 AND objsubid = 2
    AND objid = (hashtext(target::text)::bigint & 4294967295)::oid)
$$;
CREATE FUNCTION t503_terminal.enter_source(target uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF t503_terminal.has_event_lock(target) THEN
    RAISE EXCEPTION 'source after terminal fence' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(505, 0);
END $$;
CREATE FUNCTION t503_terminal.changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF t503_terminal.has_event_lock(NEW.event_id) OR NOT EXISTS (
    SELECT FROM pg_locks WHERE pid = pg_backend_pid() AND granted
    AND locktype = 'advisory' AND classid = 505 AND objid = 0 AND objsubid = 2) THEN
    RAISE EXCEPTION 'unguarded or post-fence projection writer' USING ERRCODE = '42501';
  END IF;
  IF ranking_eligible(NEW) THEN
    INSERT INTO t503_terminal.entry VALUES (NEW.event_id, NEW.id, NEW.score, NEW.score_version)
    ON CONFLICT (enrollment_id) DO UPDATE
      SET score = EXCLUDED.score, score_version = EXCLUDED.score_version;
  ELSE
    DELETE FROM t503_terminal.entry WHERE enrollment_id = NEW.id;
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION public.complete_quest(uuid, text, integer, text, text, uuid, jsonb)
  SET SCHEMA t503_terminal;
CREATE FUNCTION public.complete_quest(target uuid, proof_method text, proof_version integer, typed_code text,
  request_key text, device uuid, reading jsonb DEFAULT NULL)
RETURNS TABLE (completion_id bigint, points bigint, occurrence integer, score bigint, balance bigint, replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM t503_terminal.enter_source((SELECT event_id FROM quest WHERE id = target));
  RETURN QUERY SELECT * FROM t503_terminal.complete_quest(target, proof_method, proof_version,
    typed_code, request_key, device, reading);
END $$;
REVOKE ALL ON FUNCTION public.complete_quest(uuid, text, integer, text, text, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_quest(uuid, text, integer, text, text, uuid, jsonb) TO questify_app;
CREATE TRIGGER t503_terminal_changed AFTER UPDATE OF score, score_version, status ON enrollment
  FOR EACH ROW EXECUTE FUNCTION t503_terminal.changed();
CREATE FUNCTION public.t503_terminal_publish(target uuid)
RETURNS TABLE (wait_ms double precision, acquired_at timestamptz, published_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  started timestamptz;
  previous t503_terminal.state%ROWTYPE;
  next_ids uuid[];
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'READ COMMITTED required';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_locks WHERE pid = pg_backend_pid() AND granted
    AND locktype = 'advisory' AND classid = 505 AND objid = 0 AND objsubid = 2)
    OR t503_terminal.has_event_lock(target) THEN
    RAISE EXCEPTION 'missing source gate or already fenced' USING ERRCODE = '42501';
  END IF;
  SET CONSTRAINTS ALL IMMEDIATE;
  started := clock_timestamp();
  PERFORM pg_advisory_xact_lock(506, hashtext(target::text));
  acquired_at := clock_timestamp();
  wait_ms := extract(epoch FROM acquired_at - started) * 1000;
  SELECT * INTO STRICT previous FROM t503_terminal.state WHERE event_id = target FOR UPDATE;
  next_ids := ARRAY(SELECT enrollment_id FROM t503_terminal.entry WHERE event_id = target
    ORDER BY score DESC, score_version, enrollment_id LIMIT 10);
  UPDATE t503_terminal.state SET revision = revision + 1, top_ids = next_ids WHERE event_id = target;
  INSERT INTO t503_terminal.fact
    SELECT target, previous.generation, previous.revision + 1, changed.enrollment_id, 'entry'
    FROM unnest(next_ids) changed(enrollment_id) WHERE NOT changed.enrollment_id = ANY(previous.top_ids)
    UNION ALL
    SELECT target, previous.generation, previous.revision + 1, changed.enrollment_id, 'exit'
    FROM unnest(previous.top_ids) changed(enrollment_id) WHERE NOT changed.enrollment_id = ANY(next_ids);
  INSERT INTO t503_terminal.latest
    SELECT event_id, enrollment_id, generation, revision FROM t503_terminal.fact
    WHERE event_id = target AND generation = previous.generation AND revision = previous.revision + 1
    ON CONFLICT (event_id, enrollment_id) DO UPDATE
      SET generation = EXCLUDED.generation, revision = EXCLUDED.revision;
  published_at := clock_timestamp();
  RETURN NEXT;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA t503_terminal FROM PUBLIC;
REVOKE ALL ON FUNCTION public.t503_terminal_publish(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.t503_terminal_publish(uuid) TO questify_app;

CREATE FUNCTION public.t503_terminal_read(target uuid) RETURNS uuid[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE ids uuid[];
BEGIN
  PERFORM pg_advisory_xact_lock_shared(505, 0);
  PERFORM pg_advisory_xact_lock_shared(506, hashtext(target::text));
  SELECT top_ids INTO STRICT ids FROM t503_terminal.state WHERE event_id=target;
  RETURN ids;
END $$;
CREATE FUNCTION public.t503_terminal_reset(target uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS(SELECT FROM pg_locks WHERE pid=pg_backend_pid() AND granted
    AND locktype='advisory' AND classid=505 AND objid=0 AND objsubid=2 AND mode='ShareLock') THEN
    RAISE EXCEPTION 'shared gate upgrade refused' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(505, 0);
  PERFORM pg_advisory_xact_lock(506, hashtext(target::text));
  UPDATE t503_terminal.state SET generation=generation+1, revision=0,
    top_ids=ARRAY(SELECT enrollment_id FROM t503_terminal.entry WHERE event_id=target
      ORDER BY score DESC,score_version,enrollment_id LIMIT 10) WHERE event_id=target;
  DELETE FROM t503_terminal.latest WHERE event_id=target;
END $$;
REVOKE ALL ON FUNCTION public.t503_terminal_read(uuid), public.t503_terminal_reset(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.t503_terminal_read(uuid), public.t503_terminal_reset(uuid) TO questify_app;

CREATE TABLE t503_terminal.deferred_job (
  enrollment_id uuid REFERENCES enrollment(id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE t503_terminal.deferred_trace (was_fenced boolean NOT NULL);
CREATE FUNCTION t503_terminal.deferred_business() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE target uuid;
BEGIN
  SELECT event_id INTO STRICT target FROM enrollment WHERE id=NEW.enrollment_id;
  INSERT INTO t503_terminal.deferred_trace VALUES (t503_terminal.has_event_lock(target));
  UPDATE enrollment SET score=score WHERE id=NEW.enrollment_id;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER deferred_business AFTER INSERT ON t503_terminal.deferred_job
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION t503_terminal.deferred_business();
REVOKE ALL ON FUNCTION t503_terminal.deferred_business() FROM PUBLIC;
