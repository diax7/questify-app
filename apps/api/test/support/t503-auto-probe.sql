CREATE SCHEMA t503_auto;
REVOKE ALL ON SCHEMA t503_auto FROM PUBLIC;
CREATE TABLE t503_auto.entry (
  event_id uuid NOT NULL, enrollment_id uuid PRIMARY KEY,
  score bigint NOT NULL, score_version bigint NOT NULL
);
CREATE INDEX ON t503_auto.entry (event_id, score DESC, score_version, enrollment_id);
CREATE TABLE t503_auto.state (
  event_id uuid PRIMARY KEY, generation bigint NOT NULL DEFAULT 1,
  revision bigint NOT NULL DEFAULT 0, top_ids uuid[] NOT NULL
);
CREATE TABLE t503_auto.fact (
  event_id uuid NOT NULL, generation bigint NOT NULL, revision bigint NOT NULL,
  enrollment_id uuid NOT NULL, direction text NOT NULL,
  PRIMARY KEY (event_id, generation, revision, enrollment_id)
);
CREATE TABLE t503_auto.latest (
  event_id uuid NOT NULL, enrollment_id uuid NOT NULL,
  generation bigint NOT NULL, revision bigint NOT NULL,
  PRIMARY KEY (event_id, enrollment_id)
);
CREATE TABLE t503_auto.dirty (
  transaction_id bigint NOT NULL, event_id uuid NOT NULL,
  PRIMARY KEY (transaction_id, event_id)
);
CREATE TABLE t503_auto.pending (transaction_id bigint PRIMARY KEY);
CREATE TABLE t503_auto.trace (
  event_id uuid NOT NULL, phase text NOT NULL, ordinal bigint GENERATED ALWAYS AS IDENTITY
);
CREATE FUNCTION t503_auto.check_source() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('t503_auto.phase', true), '') = 'finalizing'
    OR EXISTS (SELECT FROM pg_locks WHERE pid=pg_backend_pid() AND granted
      AND locktype='advisory' AND classid=508 AND objsubid=2) THEN
    RAISE EXCEPTION 'business entry after finalization' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(507, 0);
END $$;
CREATE FUNCTION t503_auto.before_business() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM t503_auto.check_source();
  PERFORM set_config('t503_auto.depth',
    (coalesce(nullif(current_setting('t503_auto.depth',true),''),'0')::integer+1)::text,true);
  RETURN NULL;
END $$;
CREATE FUNCTION t503_auto.after_business() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('t503_auto.depth',
    (current_setting('t503_auto.depth')::integer-1)::text,true);
  RETURN NULL;
END $$;
ALTER FUNCTION public.complete_quest(uuid,text,integer,text,text,uuid,jsonb) SET SCHEMA t503_auto;
CREATE FUNCTION public.complete_quest(target uuid, proof_method text, proof_version integer,
  typed_code text, request_key text, device uuid, reading jsonb DEFAULT NULL)
RETURNS TABLE (completion_id bigint, points bigint, occurrence integer, score bigint, balance bigint, replayed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM t503_auto.check_source();
  RETURN QUERY SELECT * FROM t503_auto.complete_quest(target,proof_method,proof_version,
    typed_code,request_key,device,reading);
END $$;
ALTER FUNCTION public.record_completion(uuid,uuid,text,integer,text,text,uuid,uuid,uuid,text,uuid,jsonb)
  SET SCHEMA t503_auto;
CREATE FUNCTION public.record_completion(target uuid, who uuid, proof_method text, proof_version integer,
  typed_code text, request_key text, device uuid, operator uuid, staff uuid, reason text,
  expected_event uuid, reading jsonb DEFAULT NULL)
RETURNS TABLE (completion_id bigint, points bigint, occurrence integer, score bigint, balance bigint, replayed boolean)
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM t503_auto.check_source();
  RETURN QUERY SELECT * FROM t503_auto.record_completion(target,who,proof_method,proof_version,
    typed_code,request_key,device,operator,staff,reason,expected_event,reading);
END $$;
CREATE FUNCTION t503_auto.changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF ranking_eligible(NEW) THEN
    INSERT INTO t503_auto.entry VALUES (NEW.event_id,NEW.id,NEW.score,NEW.score_version)
    ON CONFLICT (enrollment_id) DO UPDATE
      SET score=EXCLUDED.score,score_version=EXCLUDED.score_version;
  ELSE
    DELETE FROM t503_auto.entry WHERE enrollment_id=NEW.id;
  END IF;
  INSERT INTO t503_auto.dirty VALUES(txid_current(),NEW.event_id) ON CONFLICT DO NOTHING;
  INSERT INTO t503_auto.pending VALUES(txid_current()) ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER t503_auto_changed AFTER UPDATE OF score,score_version,status ON enrollment
  FOR EACH ROW EXECUTE FUNCTION t503_auto.changed();
DO $$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['enrollment','quest_completion','ledger_entry','quest','event'] LOOP
    EXECUTE format('CREATE TRIGGER t503_auto_before BEFORE INSERT OR UPDATE OR DELETE ON %I
      FOR EACH STATEMENT EXECUTE FUNCTION t503_auto.before_business()',target);
    EXECUTE format('CREATE TRIGGER t503_auto_after AFTER INSERT OR UPDATE OR DELETE ON %I
      FOR EACH STATEMENT EXECUTE FUNCTION t503_auto.after_business()',target);
  END LOOP;
END $$;
CREATE FUNCTION t503_auto.publish_event(target uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE previous t503_auto.state%ROWTYPE; next_ids uuid[];
BEGIN
  PERFORM set_config('t503_auto.before_acquire',extract(epoch FROM clock_timestamp())::text,false);
  PERFORM pg_advisory_xact_lock(508,hashtext(target::text));
  PERFORM set_config('t503_auto.acquired',extract(epoch FROM clock_timestamp())::text,false);
  SELECT * INTO STRICT previous FROM t503_auto.state WHERE event_id=target FOR UPDATE;
  next_ids:=ARRAY(SELECT enrollment_id FROM t503_auto.entry WHERE event_id=target
    ORDER BY score DESC,score_version,enrollment_id LIMIT 10);
  UPDATE t503_auto.state SET revision=revision+1,top_ids=next_ids WHERE event_id=target;
  INSERT INTO t503_auto.fact
    SELECT target,previous.generation,previous.revision+1,changed.enrollment_id,'entry'
      FROM unnest(next_ids) changed(enrollment_id) WHERE NOT changed.enrollment_id=ANY(previous.top_ids)
    UNION ALL
    SELECT target,previous.generation,previous.revision+1,changed.enrollment_id,'exit'
      FROM unnest(previous.top_ids) changed(enrollment_id) WHERE NOT changed.enrollment_id=ANY(next_ids);
  INSERT INTO t503_auto.latest
    SELECT event_id,enrollment_id,generation,revision FROM t503_auto.fact
    WHERE event_id=target AND generation=previous.generation AND revision=previous.revision+1
    ON CONFLICT(event_id,enrollment_id) DO UPDATE
      SET generation=EXCLUDED.generation,revision=EXCLUDED.revision;
  INSERT INTO t503_auto.trace VALUES(target,'published');
END $$;
CREATE FUNCTION t503_auto.finalize() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE target uuid;
BEGIN
  IF coalesce(nullif(current_setting('t503_auto.depth',true),''),'0')::integer<>0 THEN
    RAISE EXCEPTION 'cannot finalize inside business statement' USING ERRCODE='42501';
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'READ COMMITTED required' USING ERRCODE='42501';
  END IF;
  IF coalesce(current_setting('t503_auto.phase',true),'') IN ('draining','finalizing') THEN
    RAISE EXCEPTION 'recursive finalizer' USING ERRCODE='42501';
  END IF;
  PERFORM set_config('t503_auto.phase','draining',true);
  SET CONSTRAINTS ALL IMMEDIATE;
  PERFORM set_config('t503_auto.phase','finalizing',true);
  FOR target IN SELECT event_id FROM t503_auto.dirty WHERE transaction_id=NEW.transaction_id
    ORDER BY hashtext(event_id::text),event_id LOOP
    PERFORM t503_auto.publish_event(target);
  END LOOP;
  IF current_setting('t503_auto.fail',true)='on' THEN
    RAISE EXCEPTION 'injected commit finalizer failure' USING ERRCODE='P0001';
  END IF;
  DELETE FROM t503_auto.dirty WHERE transaction_id=NEW.transaction_id;
  DELETE FROM t503_auto.pending WHERE transaction_id=NEW.transaction_id;
  PERFORM set_config('t503_auto.finished',extract(epoch FROM clock_timestamp())::text,false);
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER auto_finalize AFTER INSERT ON t503_auto.pending
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION t503_auto.finalize();
CREATE FUNCTION public.t503_auto_read(target uuid) RETURNS uuid[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE ids uuid[];
BEGIN
  PERFORM pg_advisory_xact_lock_shared(507,0);
  PERFORM pg_advisory_xact_lock_shared(508,hashtext(target::text));
  SELECT top_ids INTO STRICT ids FROM t503_auto.state WHERE event_id=target;
  RETURN ids;
END $$;
CREATE FUNCTION public.t503_auto_reset(target uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF EXISTS (SELECT FROM pg_locks WHERE pid=pg_backend_pid() AND granted AND locktype='advisory'
    AND classid=507 AND objid=0 AND objsubid=2 AND mode='ShareLock') THEN
    RAISE EXCEPTION 'shared gate upgrade refused' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock(507,0);
  PERFORM pg_advisory_xact_lock(508,hashtext(target::text));
  UPDATE t503_auto.state SET generation=generation+1,revision=0,
    top_ids=ARRAY(SELECT enrollment_id FROM t503_auto.entry WHERE event_id=target
      ORDER BY score DESC,score_version,enrollment_id LIMIT 10) WHERE event_id=target;
  DELETE FROM t503_auto.latest WHERE event_id=target;
END $$;
CREATE TABLE t503_auto.deferred_job (enrollment_id uuid, remaining integer NOT NULL DEFAULT 0);
CREATE TABLE t503_auto.deferred_trace (phase text NOT NULL);
CREATE FUNCTION t503_auto.deferred_business() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM t503_auto.check_source();
  INSERT INTO t503_auto.deferred_trace VALUES(coalesce(current_setting('t503_auto.phase',true),''));
  UPDATE enrollment SET score=score WHERE id=NEW.enrollment_id;
  IF NEW.remaining>0 THEN
    INSERT INTO t503_auto.deferred_job VALUES(NEW.enrollment_id,NEW.remaining-1);
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER deferred_business AFTER INSERT ON t503_auto.deferred_job
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION t503_auto.deferred_business();
CREATE TRIGGER t503_auto_before BEFORE INSERT OR UPDATE OR DELETE ON t503_auto.deferred_job
  FOR EACH STATEMENT EXECUTE FUNCTION t503_auto.before_business();
CREATE TRIGGER t503_auto_after AFTER INSERT OR UPDATE OR DELETE ON t503_auto.deferred_job
  FOR EACH STATEMENT EXECUTE FUNCTION t503_auto.after_business();
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA t503_auto FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_completion(uuid,uuid,text,integer,text,text,uuid,uuid,uuid,text,uuid,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_quest(uuid,text,integer,text,text,uuid,jsonb),
  public.t503_auto_read(uuid),public.t503_auto_reset(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_quest(uuid,text,integer,text,text,uuid,jsonb),
  public.t503_auto_read(uuid),public.t503_auto_reset(uuid) TO questify_app;
