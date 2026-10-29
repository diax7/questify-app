CREATE SCHEMA t503_probe;
REVOKE ALL ON SCHEMA t503_probe FROM PUBLIC;

CREATE TABLE t503_probe.entry (
  event_id uuid NOT NULL,
  enrollment_id uuid PRIMARY KEY,
  score bigint NOT NULL,
  score_version bigint NOT NULL
);
CREATE INDEX ON t503_probe.entry (event_id, score DESC, score_version, enrollment_id);
CREATE TABLE t503_probe.state (
  event_id uuid PRIMARY KEY,
  generation bigint NOT NULL DEFAULT 1,
  revision bigint NOT NULL DEFAULT 0,
  top_ids uuid[] NOT NULL
);
CREATE TABLE t503_probe.fact (
  event_id uuid NOT NULL,
  generation bigint NOT NULL,
  revision bigint NOT NULL,
  enrollment_id uuid NOT NULL,
  direction text NOT NULL CHECK (direction IN ('entry', 'exit')),
  PRIMARY KEY (event_id, generation, revision, enrollment_id)
);
CREATE TABLE t503_probe.latest (
  event_id uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  generation bigint NOT NULL,
  revision bigint NOT NULL,
  PRIMARY KEY (event_id, enrollment_id)
);
CREATE TABLE t503_probe.dirty (
  event_id uuid NOT NULL,
  transaction_id bigint NOT NULL DEFAULT txid_current(),
  PRIMARY KEY (event_id, transaction_id)
);
CREATE TABLE t503_probe.measurement (
  transaction_id bigint PRIMARY KEY,
  event_id uuid NOT NULL,
  wait_ms double precision NOT NULL,
  hold_lower_ms double precision NOT NULL
);

CREATE FUNCTION t503_probe.guard(target uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  started timestamptz := clock_timestamp();
BEGIN
  PERFORM pg_advisory_xact_lock_shared(503, 0);
  PERFORM pg_advisory_xact_lock(504, hashtext(target::text));
  IF current_setting('t503_probe.acquired', true) IS NULL
     OR current_setting('t503_probe.acquired', true) = '' THEN
    PERFORM set_config('t503_probe.wait_ms',
      (extract(epoch FROM clock_timestamp() - started) * 1000)::text, true);
    PERFORM set_config('t503_probe.acquired', clock_timestamp()::text, true);
  END IF;
END $$;

CREATE FUNCTION t503_probe.assert_guard(target uuid) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_locks WHERE pid = pg_backend_pid() AND granted
    AND locktype = 'advisory' AND classid = 503 AND objid = 0 AND objsubid = 2)
    OR NOT EXISTS (SELECT 1 FROM pg_locks WHERE pid = pg_backend_pid() AND granted
      AND locktype = 'advisory' AND classid = 504 AND objsubid = 2 AND mode = 'ExclusiveLock'
      AND objid = (hashtext(target::text)::bigint & 4294967295)::oid) THEN
    RAISE EXCEPTION 'T503 unguarded enrollment writer' USING ERRCODE = 'insufficient_privilege';
  END IF;
END $$;

CREATE FUNCTION t503_probe.changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM t503_probe.assert_guard(NEW.event_id);
  IF ranking_eligible(NEW) THEN
    INSERT INTO t503_probe.entry VALUES (NEW.event_id, NEW.id, NEW.score, NEW.score_version)
    ON CONFLICT (enrollment_id) DO UPDATE
      SET score = EXCLUDED.score, score_version = EXCLUDED.score_version;
  ELSE
    DELETE FROM t503_probe.entry WHERE enrollment_id = NEW.id;
  END IF;
  INSERT INTO t503_probe.dirty (event_id) VALUES (NEW.event_id) ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;

CREATE FUNCTION t503_probe.finalize() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  previous t503_probe.state%ROWTYPE;
  next_ids uuid[];
BEGIN
  SELECT * INTO STRICT previous FROM t503_probe.state WHERE event_id = NEW.event_id FOR UPDATE;
  next_ids := ARRAY(SELECT enrollment_id FROM t503_probe.entry WHERE event_id = NEW.event_id
    ORDER BY score DESC, score_version, enrollment_id LIMIT 10);
  UPDATE t503_probe.state SET revision = revision + 1, top_ids = next_ids WHERE event_id = NEW.event_id;
  INSERT INTO t503_probe.fact
    SELECT NEW.event_id, previous.generation, previous.revision + 1, changed.enrollment_id, 'entry'
    FROM unnest(next_ids) changed(enrollment_id) WHERE NOT changed.enrollment_id = ANY(previous.top_ids)
    UNION ALL
    SELECT NEW.event_id, previous.generation, previous.revision + 1, changed.enrollment_id, 'exit'
    FROM unnest(previous.top_ids) changed(enrollment_id) WHERE NOT changed.enrollment_id = ANY(next_ids);
  INSERT INTO t503_probe.latest
    SELECT event_id, enrollment_id, generation, revision FROM t503_probe.fact
    WHERE event_id = NEW.event_id AND generation = previous.generation AND revision = previous.revision + 1
    ON CONFLICT (event_id, enrollment_id) DO UPDATE
      SET generation = EXCLUDED.generation, revision = EXCLUDED.revision;
  DELETE FROM t503_probe.dirty WHERE event_id = NEW.event_id AND transaction_id = NEW.transaction_id;
  INSERT INTO t503_probe.measurement VALUES (txid_current(), NEW.event_id,
    current_setting('t503_probe.wait_ms')::double precision,
    extract(epoch FROM clock_timestamp() - current_setting('t503_probe.acquired')::timestamptz) * 1000);
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER finalize AFTER INSERT ON t503_probe.dirty
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION t503_probe.finalize();

ALTER FUNCTION public.complete_quest(uuid, text, integer, text, text, uuid, jsonb)
  SET SCHEMA t503_probe;
CREATE FUNCTION public.complete_quest(target uuid, proof_method text, proof_version integer, typed_code text,
  request_key text, device uuid, reading jsonb DEFAULT NULL)
RETURNS TABLE (completion_id bigint, points bigint, occurrence integer, score bigint, balance bigint, replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM t503_probe.guard((SELECT event_id FROM quest WHERE id = target));
  RETURN QUERY SELECT * FROM t503_probe.complete_quest(target, proof_method, proof_version,
    typed_code, request_key, device, reading);
END $$;
REVOKE ALL ON FUNCTION public.complete_quest(uuid, text, integer, text, text, uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_quest(uuid, text, integer, text, text, uuid, jsonb) TO questify_app;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA t503_probe FROM PUBLIC;

CREATE TRIGGER t503_changed AFTER UPDATE OF score, score_version, status ON enrollment
  FOR EACH ROW EXECUTE FUNCTION t503_probe.changed();
