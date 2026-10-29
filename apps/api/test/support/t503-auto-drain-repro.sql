CREATE TEMP TABLE auto_pending (id integer);
CREATE TEMP TABLE auto_business (id integer);
CREATE FUNCTION pg_temp.auto_callback() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE NOTICE 'automatic callback: before SET CONSTRAINTS ALL IMMEDIATE';
  SET CONSTRAINTS ALL IMMEDIATE;
  RAISE NOTICE 'automatic callback: after SET CONSTRAINTS ALL IMMEDIATE';
  PERFORM pg_advisory_xact_lock(508,123);
  PERFORM set_config('t503_repro.phase','finalizing',true);
  RAISE NOTICE 'automatic callback: E acquired';
  RETURN NULL;
END $$;
CREATE FUNCTION pg_temp.business_callback() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE NOTICE 'business callback phase: %',current_setting('t503_repro.phase',true);
  IF current_setting('t503_repro.phase',true)='finalizing' THEN
    RAISE EXCEPTION 'business entry after finalization' USING ERRCODE='42501';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER auto_callback AFTER INSERT ON auto_pending
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pg_temp.auto_callback();
CREATE CONSTRAINT TRIGGER business_callback AFTER INSERT ON auto_business
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pg_temp.business_callback();
