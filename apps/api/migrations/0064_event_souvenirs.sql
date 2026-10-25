-- T-402b: drain pre-upgrade erasures before changing ownership/cleanup.
SET LOCAL lock_timeout = '10s';
LOCK TABLE player IN EXCLUSIVE MODE;
LOCK TABLE player_xp IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE player_item IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE souvenir_rule (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organizer_id uuid NOT NULL, event_id uuid NOT NULL,
 item_id text NOT NULL UNIQUE REFERENCES item(id), audience text NOT NULL CHECK(audience IN ('joined','category','all','rank')),
 category_id uuid, rank_from integer, rank_to integer, status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','stopped')),
 created_at timestamptz NOT NULL DEFAULT now(), activated_at timestamptz, stopped_at timestamptz,
 UNIQUE(id,event_id), UNIQUE(id,event_id,item_id),
 FOREIGN KEY(event_id,organizer_id) REFERENCES event(id,organizer_id),
 FOREIGN KEY(category_id,event_id) REFERENCES category(id,event_id),
 CHECK((audience='category')=(category_id IS NOT NULL)),
 CHECK((audience='rank' AND rank_from IS NOT NULL AND rank_to IS NOT NULL AND rank_from BETWEEN 1 AND 100 AND rank_to BETWEEN rank_from AND 100)
    OR (audience<>'rank' AND rank_from IS NULL AND rank_to IS NULL)),
 CHECK((status='draft')=(activated_at IS NULL)), CHECK((status='stopped')=(stopped_at IS NOT NULL))
);
CREATE INDEX souvenir_event ON souvenir_rule(event_id,status);
CREATE TABLE souvenir_target (
 rule_id uuid NOT NULL, event_id uuid NOT NULL, quest_id uuid NOT NULL,
 PRIMARY KEY(rule_id,quest_id), FOREIGN KEY(rule_id,event_id) REFERENCES souvenir_rule(id,event_id),
 FOREIGN KEY(quest_id,event_id) REFERENCES quest(id,event_id)
);
ALTER TABLE enrollment ADD CONSTRAINT enrollment_souvenir_identity UNIQUE(id,event_id,player_id);
-- No direct event FK: inserting after enrollment must not wait on confirm_results' event UPDATE lock.
CREATE TABLE souvenir_receipt (
 rule_id uuid NOT NULL, event_id uuid NOT NULL, item_id text NOT NULL, player_id uuid NOT NULL,
 enrollment_id uuid NOT NULL, earned_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(rule_id,player_id), UNIQUE(player_id,item_id), UNIQUE(player_id,item_id,rule_id,event_id),
 FOREIGN KEY(rule_id,event_id,item_id) REFERENCES souvenir_rule(id,event_id,item_id),
 FOREIGN KEY(enrollment_id,event_id,player_id) REFERENCES enrollment(id,event_id,player_id)
);
CREATE TABLE souvenir_work (
 event_id uuid NOT NULL, enrollment_id uuid NOT NULL, generation bigint NOT NULL DEFAULT 1,
 ready_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz, lease_token uuid,
 attempts integer NOT NULL DEFAULT 0, error_code text,
 PRIMARY KEY(event_id,enrollment_id), FOREIGN KEY(enrollment_id,event_id) REFERENCES enrollment(id,event_id),
 CHECK(generation>0 AND attempts>=0), CHECK((lease_until IS NULL)=(lease_token IS NULL))
);
CREATE INDEX souvenir_due ON souvenir_work(ready_at,lease_until);
CREATE TABLE souvenir_scan (
 rule_id uuid PRIMARY KEY REFERENCES souvenir_rule(id), cursor_id uuid,
 next_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE souvenir_command (
 request_id uuid PRIMARY KEY, event_id uuid NOT NULL, staff_user_id uuid NOT NULL,
 fingerprint text NOT NULL, result_id uuid NOT NULL
);
ALTER TABLE souvenir_command ENABLE ROW LEVEL SECURITY;
ALTER TABLE souvenir_command FORCE ROW LEVEL SECURITY;
REVOKE ALL ON souvenir_command FROM PUBLIC,questify_app;

ALTER TABLE souvenir_rule ENABLE ROW LEVEL SECURITY;
ALTER TABLE souvenir_rule FORCE ROW LEVEL SECURITY;
ALTER TABLE souvenir_target ENABLE ROW LEVEL SECURITY;
ALTER TABLE souvenir_target FORCE ROW LEVEL SECURITY;
ALTER TABLE souvenir_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE souvenir_receipt FORCE ROW LEVEL SECURITY;
ALTER TABLE souvenir_work ENABLE ROW LEVEL SECURITY;
ALTER TABLE souvenir_work FORCE ROW LEVEL SECURITY;
ALTER TABLE souvenir_scan ENABLE ROW LEVEL SECURITY;
ALTER TABLE souvenir_scan FORCE ROW LEVEL SECURITY;
REVOKE ALL ON souvenir_rule,souvenir_target,souvenir_receipt,souvenir_work,souvenir_scan FROM PUBLIC,questify_app;

ALTER TABLE player_item DROP CONSTRAINT player_item_source_check;
ALTER TABLE player_item ALTER COLUMN source_level DROP NOT NULL;
ALTER TABLE player_item ADD COLUMN source_rule_id uuid, ADD COLUMN source_event_id uuid;
ALTER TABLE player_item ADD CONSTRAINT player_item_source_check CHECK(
 (source='level' AND source_level IS NOT NULL AND source_rule_id IS NULL AND source_event_id IS NULL)
 OR (source='souvenir' AND source_level IS NULL AND source_rule_id IS NOT NULL AND source_event_id IS NOT NULL));
ALTER TABLE player_item ADD CONSTRAINT player_item_souvenir_fk
 FOREIGN KEY(player_id,item_id,source_rule_id,source_event_id)
 REFERENCES souvenir_receipt(player_id,item_id,rule_id,event_id);

CREATE OR REPLACE FUNCTION owned_item_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF current_setting('app.erasure',true)='on' THEN RETURN OLD; END IF;
 ELSIF (NEW.player_id,NEW.item_id,NEW.source,NEW.source_level,NEW.source_rule_id,NEW.source_event_id,NEW.earned_at)
   IS NOT DISTINCT FROM (OLD.player_id,OLD.item_id,OLD.source,OLD.source_level,OLD.source_rule_id,OLD.source_event_id,OLD.earned_at)
 THEN RETURN NEW;
 END IF;
 RAISE EXCEPTION 'earned items can only be acknowledged or erased' USING ERRCODE='insufficient_privilege';
END $$;
REVOKE ALL ON FUNCTION owned_item_guard() FROM PUBLIC;

CREATE FUNCTION souvenir_immutable() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' AND current_setting('app.erasure',true)='on' THEN RETURN OLD; END IF;
 RAISE EXCEPTION 'souvenir evidence is immutable' USING ERRCODE='insufficient_privilege';
END $$;
REVOKE ALL ON FUNCTION souvenir_immutable() FROM PUBLIC;
CREATE TRIGGER souvenir_receipt_immutable BEFORE UPDATE OR DELETE ON souvenir_receipt FOR EACH ROW EXECUTE FUNCTION souvenir_immutable();
ALTER TABLE souvenir_receipt ENABLE ALWAYS TRIGGER souvenir_receipt_immutable;
CREATE TRIGGER souvenir_receipt_truncate BEFORE TRUNCATE ON souvenir_receipt FOR EACH STATEMENT EXECUTE FUNCTION xp_append_only();
ALTER TABLE souvenir_receipt ENABLE ALWAYS TRIGGER souvenir_receipt_truncate;

CREATE FUNCTION souvenir_rule_guard() RETURNS trigger LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF OLD.status='draft' THEN RETURN OLD; END IF;
 ELSIF (NEW.id,NEW.organizer_id,NEW.event_id,NEW.item_id,NEW.created_at) IS NOT DISTINCT FROM
       (OLD.id,OLD.organizer_id,OLD.event_id,OLD.item_id,OLD.created_at) THEN
  IF OLD.status='draft' AND NEW.status IN ('draft','active') THEN RETURN NEW; END IF;
  IF OLD.status='active' AND NEW.status='stopped' AND
     (NEW.audience,NEW.category_id,NEW.rank_from,NEW.rank_to,NEW.activated_at) IS NOT DISTINCT FROM
     (OLD.audience,OLD.category_id,OLD.rank_from,OLD.rank_to,OLD.activated_at) THEN RETURN NEW; END IF;
 END IF;
 RAISE EXCEPTION 'souvenir promise is frozen' USING ERRCODE='SV409',DETAIL='souvenir_locked';
END $$;
REVOKE ALL ON FUNCTION souvenir_rule_guard() FROM PUBLIC;
CREATE TRIGGER souvenir_rule_guard BEFORE UPDATE OR DELETE ON souvenir_rule FOR EACH ROW EXECUTE FUNCTION souvenir_rule_guard();
ALTER TABLE souvenir_rule ENABLE ALWAYS TRIGGER souvenir_rule_guard;
CREATE TRIGGER souvenir_rule_truncate BEFORE TRUNCATE ON souvenir_rule FOR EACH STATEMENT EXECUTE FUNCTION xp_append_only();

CREATE FUNCTION souvenir_target_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE rule uuid := CASE WHEN TG_OP='DELETE' THEN OLD.rule_id ELSE NEW.rule_id END;
BEGIN
 IF EXISTS(SELECT 1 FROM souvenir_rule r WHERE r.id=rule AND r.status<>'draft') OR TG_OP='UPDATE' THEN
  RAISE EXCEPTION 'souvenir targets are frozen' USING ERRCODE='SV409',DETAIL='souvenir_locked';
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION souvenir_target_guard() FROM PUBLIC;
CREATE TRIGGER souvenir_target_guard BEFORE INSERT OR UPDATE OR DELETE ON souvenir_target FOR EACH ROW EXECUTE FUNCTION souvenir_target_guard();
ALTER TABLE souvenir_target ENABLE ALWAYS TRIGGER souvenir_target_guard;
CREATE TRIGGER souvenir_target_truncate BEFORE TRUNCATE ON souvenir_target FOR EACH STATEMENT EXECUTE FUNCTION xp_append_only();

CREATE FUNCTION souvenir_catalog_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME='level_item' THEN
  IF EXISTS(SELECT 1 FROM souvenir_rule r WHERE r.item_id=NEW.item_id) THEN
   RAISE EXCEPTION 'item already has a souvenir source' USING ERRCODE='23514';
  END IF;
 ELSIF TG_TABLE_NAME='souvenir_rule' THEN
  IF EXISTS(SELECT 1 FROM level_item l WHERE l.item_id=NEW.item_id) THEN
   RAISE EXCEPTION 'item already has a level source' USING ERRCODE='23514';
  END IF;
 ELSIF EXISTS(SELECT 1 FROM souvenir_rule r WHERE r.item_id=OLD.id AND r.status<>'draft') THEN
  RAISE EXCEPTION 'active souvenir content is frozen' USING ERRCODE='SV409',DETAIL='souvenir_locked';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION souvenir_catalog_guard() FROM PUBLIC;
CREATE TRIGGER souvenir_level_source BEFORE INSERT OR UPDATE ON level_item FOR EACH ROW EXECUTE FUNCTION souvenir_catalog_guard();
CREATE TRIGGER souvenir_rule_source BEFORE INSERT OR UPDATE ON souvenir_rule FOR EACH ROW EXECUTE FUNCTION souvenir_catalog_guard();
CREATE TRIGGER souvenir_item_content BEFORE UPDATE ON item FOR EACH ROW EXECUTE FUNCTION souvenir_catalog_guard();

CREATE FUNCTION souvenir_system_only() RETURNS void LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF NOT ranking_system() OR app_device_id() IS NOT NULL THEN
  RAISE EXCEPTION 'souvenirs run in system context only' USING ERRCODE='SV403';
 END IF;
 IF current_setting('transaction_isolation')<>'read committed' THEN
  RAISE EXCEPTION 'souvenirs require read committed' USING ERRCODE='SV403';
 END IF;
END $$;
REVOKE ALL ON FUNCTION souvenir_system_only() FROM PUBLIC;

CREATE FUNCTION souvenir_event(target uuid, writing boolean) RETURNS event
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE ev event;
BEGIN
 -- Identity and membership are checked independently of HTTP, including stale/forged contexts.
 IF app_player_id() IS NOT NULL OR app_device_id() IS NOT NULL OR app_is_admin() OR NOT EXISTS(
  SELECT 1 FROM organizer_member m JOIN staff_user s ON s.id=m.staff_user_id
  WHERE m.organizer_id=app_organizer_id() AND m.staff_user_id=app_staff_user_id()
    AND m.role IN ('owner','editor') AND s.status='active') THEN
  RAISE EXCEPTION 'no such event' USING ERRCODE='AN404';
 END IF;
 ev:=award_event_of(target);
 IF writing THEN
  SELECT * INTO ev FROM event e WHERE e.id=ev.id FOR NO KEY UPDATE;
  IF ev.status='archived' THEN RAISE EXCEPTION 'event archived' USING ERRCODE='SV409',DETAIL='event_archived'; END IF;
 END IF;
 RETURN ev;
END $$;
REVOKE ALL ON FUNCTION souvenir_event(uuid,boolean) FROM PUBLIC;

CREATE FUNCTION souvenir_enqueue(target uuid) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 INSERT INTO souvenir_work(event_id,enrollment_id)
 SELECT n.event_id,n.id FROM enrollment n JOIN player p ON p.id=n.player_id
 WHERE n.id=target AND n.joined_via IS DISTINCT FROM 'rehearsal' AND p.status='active'
   AND n.status='active' AND NOT n.waitlisted
   AND EXISTS(SELECT 1 FROM souvenir_rule r WHERE r.event_id=n.event_id AND r.status='active')
 ON CONFLICT(event_id,enrollment_id) DO UPDATE SET generation=souvenir_work.generation+1,ready_at=now()
$$;
REVOKE ALL ON FUNCTION souvenir_enqueue(uuid) FROM PUBLIC;

CREATE FUNCTION souvenir_on_fact() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 IF TG_TABLE_NAME='enrollment' THEN PERFORM souvenir_enqueue(NEW.id);
 ELSE PERFORM souvenir_enqueue(NEW.enrollment_id); END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION souvenir_on_fact() FROM PUBLIC;
CREATE TRIGGER souvenir_on_join AFTER INSERT OR UPDATE OF status,waitlisted ON enrollment FOR EACH ROW EXECUTE FUNCTION souvenir_on_fact();
CREATE TRIGGER souvenir_on_complete AFTER INSERT ON quest_completion FOR EACH ROW EXECUTE FUNCTION souvenir_on_fact();
CREATE TRIGGER souvenir_on_quiz AFTER UPDATE OF status ON quiz_attempt FOR EACH ROW WHEN(NEW.status='finished') EXECUTE FUNCTION souvenir_on_fact();
CREATE TRIGGER souvenir_on_game AFTER UPDATE OF status ON game_round FOR EACH ROW WHEN(NEW.status<>'open') EXECUTE FUNCTION souvenir_on_fact();

CREATE FUNCTION souvenir_rule_json(target uuid) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('id',r.id,'item',item_json(r.item_id),'audience',r.audience,'categoryId',r.category_id,
  'rankFrom',r.rank_from,'rankTo',r.rank_to,'status',r.status,'targetCount',cardinality(targets.ids),'targetIds',to_jsonb(targets.ids),
  'granted',(SELECT count(*) FROM souvenir_receipt s WHERE s.rule_id=r.id),'waitingForResults',
  r.audience='rank' AND r.status='active' AND NOT EXISTS(SELECT 1 FROM event_result er WHERE er.event_id=r.event_id))
 FROM souvenir_rule r CROSS JOIN LATERAL(SELECT ARRAY(
  SELECT q.id FROM quest q WHERE r.status='draft' AND r.audience IN ('category','all') AND q.event_id=r.event_id
    AND (r.audience='all' OR q.category_id=r.category_id) AND q.visible AND NOT q.flash
    AND NOT is_live_poll(q.type,q.type_config) AND NOT quest_lock_missed(q)
  UNION SELECT t.quest_id FROM souvenir_target t WHERE t.rule_id=r.id ORDER BY 1) AS ids) targets WHERE r.id=target
$$;
REVOKE ALL ON FUNCTION souvenir_rule_json(uuid) FROM PUBLIC;

CREATE FUNCTION souvenir_list(target uuid) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE ev event:=souvenir_event(target,false);
BEGIN
 RETURN jsonb_build_object('rules',coalesce((SELECT jsonb_agg(souvenir_rule_json(r.id) ORDER BY r.created_at,r.id)
  FROM souvenir_rule r WHERE r.event_id=ev.id),'[]'::jsonb),'archived',ev.status='archived',
  'due',(SELECT count(*) FROM souvenir_work w WHERE w.event_id=ev.id),
  'scanning',(SELECT count(*) FROM souvenir_scan s JOIN souvenir_rule r ON r.id=s.rule_id WHERE r.event_id=ev.id AND s.next_at<=now()),
  'failed',(SELECT count(*) FROM souvenir_work w WHERE w.event_id=ev.id AND w.error_code IS NOT NULL));
END $$;
REVOKE ALL ON FUNCTION souvenir_list(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION souvenir_list(uuid) TO questify_app;

CREATE FUNCTION souvenir_audit(ev event, action text, target uuid, request uuid) RETURNS void
 LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 INSERT INTO audit_log(actor_type,actor_id,organizer_id,event_id,action,target_type,target_id,after,request_id)
 VALUES('staff',app_staff_user_id(),ev.organizer_id,ev.id,action,'souvenir',target::text,
 jsonb_build_object('status',(SELECT status FROM souvenir_rule WHERE id=target)),request)
$$;
REVOKE ALL ON FUNCTION souvenir_audit(event,text,uuid,uuid) FROM PUBLIC;

CREATE FUNCTION souvenir_replay(ev event,operation text,body jsonb,request uuid) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE earlier souvenir_command; fingerprint text:=md5(operation||coalesce(body::text,'null'));
BEGIN
 IF request IS NULL THEN RAISE EXCEPTION 'request key required' USING ERRCODE='SV422'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('souvenir-command:'||request::text,0));
 SELECT * INTO earlier FROM souvenir_command c WHERE c.request_id=request;
 IF NOT FOUND THEN RETURN NULL; END IF;
 IF (earlier.event_id,earlier.staff_user_id,earlier.fingerprint) IS DISTINCT FROM (ev.id,app_staff_user_id(),fingerprint) THEN
  RAISE EXCEPTION 'idempotency conflict' USING ERRCODE='SV409',DETAIL='idempotency_conflict';
 END IF;
 RETURN earlier.result_id;
END $$;
REVOKE ALL ON FUNCTION souvenir_replay(event,text,jsonb,uuid) FROM PUBLIC;

CREATE FUNCTION souvenir_remember(ev event,operation text,body jsonb,request uuid,result uuid) RETURNS void
 LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 INSERT INTO souvenir_command(request_id,event_id,staff_user_id,fingerprint,result_id)
 VALUES(request,ev.id,app_staff_user_id(),md5(operation||coalesce(body::text,'null')),result)
$$;
REVOKE ALL ON FUNCTION souvenir_remember(event,text,jsonb,uuid,uuid) FROM PUBLIC;

CREATE FUNCTION souvenir_save(target_event uuid,target_rule uuid,body jsonb,request uuid) RETURNS uuid
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE ev event:=souvenir_event(target_event,true); r souvenir_rule; made uuid:=coalesce(target_rule,gen_random_uuid());
 chosen text; cat uuid:=nullif(body->>'categoryId','')::uuid; audience text:=body->>'audience'; replay uuid;
BEGIN
 replay:=souvenir_replay(ev,'save:'||coalesce(target_rule::text,'new'),body,request);
 IF replay IS NOT NULL THEN RETURN replay; END IF;
 IF audience IS NULL OR audience NOT IN ('joined','category','all','rank') OR body->>'kind' IS NULL
  OR body->>'kind' NOT IN ('frame','title','character') OR body#>>'{name,ar}' IS NULL OR body#>>'{name,en}' IS NULL THEN
  RAISE EXCEPTION 'invalid souvenir' USING ERRCODE='SV422';
 END IF;
 IF target_rule IS NULL THEN
  IF (SELECT count(*) FROM souvenir_rule sr WHERE sr.event_id=ev.id)>=100 THEN
   RAISE EXCEPTION 'souvenir limit reached' USING ERRCODE='SV409',DETAIL='limit_reached';
  END IF;
  chosen:='souvenir-'||replace(gen_random_uuid()::text,'-','');
 ELSE
  SELECT * INTO r FROM souvenir_rule sr WHERE sr.id=target_rule AND sr.event_id=ev.id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'no such souvenir' USING ERRCODE='AN404'; END IF;
  IF r.status<>'draft' THEN RAISE EXCEPTION 'souvenir frozen' USING ERRCODE='SV409',DETAIL='souvenir_locked'; END IF;
  chosen:=r.item_id;
  IF (SELECT kind FROM item WHERE id=chosen) IS DISTINCT FROM body->>'kind' THEN
   RAISE EXCEPTION 'item kind is immutable' USING ERRCODE='SV422';
  END IF;
 END IF;
 INSERT INTO item(id,kind,name_ar,name_en,visual_key)
 VALUES(chosen,body->>'kind',btrim(body#>>'{name,ar}'),btrim(body#>>'{name,en}'),body->>'visualKey')
 ON CONFLICT(id) DO UPDATE SET name_ar=EXCLUDED.name_ar,name_en=EXCLUDED.name_en,visual_key=EXCLUDED.visual_key;
 INSERT INTO souvenir_rule(id,organizer_id,event_id,item_id,audience,category_id,rank_from,rank_to)
 VALUES(made,ev.organizer_id,ev.id,chosen,audience,cat,(body->>'rankFrom')::integer,(body->>'rankTo')::integer)
 ON CONFLICT(id) DO UPDATE SET audience=EXCLUDED.audience,category_id=EXCLUDED.category_id,
 rank_from=EXCLUDED.rank_from,rank_to=EXCLUDED.rank_to;
 PERFORM souvenir_audit(ev,CASE WHEN target_rule IS NULL THEN 'souvenir.create' ELSE 'souvenir.update' END,made,request);
 PERFORM souvenir_remember(ev,'save:'||coalesce(target_rule::text,'new'),body,request,made);
 RETURN made;
END $$;
REVOKE ALL ON FUNCTION souvenir_save(uuid,uuid,jsonb,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION souvenir_save(uuid,uuid,jsonb,uuid) TO questify_app;

CREATE FUNCTION souvenir_action(target_event uuid,target_rule uuid,action text,request uuid,expected uuid[] DEFAULT NULL) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE ev event:=souvenir_event(target_event,true); r souvenir_rule;
BEGIN
 IF souvenir_replay(ev,action,jsonb_build_object('rule',target_rule,'targets',expected),request) IS NOT NULL THEN RETURN; END IF;
 SELECT * INTO r FROM souvenir_rule sr WHERE sr.id=target_rule AND sr.event_id=ev.id FOR NO KEY UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'no such souvenir' USING ERRCODE='AN404'; END IF;
 IF action='activate' AND r.status='draft' THEN
  IF r.audience='rank' AND EXISTS(SELECT 1 FROM event_result x WHERE x.event_id=ev.id) THEN
   RAISE EXCEPTION 'results final' USING ERRCODE='SV409',DETAIL='results_final';
  END IF;
  IF r.audience IN ('category','all') THEN
   INSERT INTO souvenir_target(rule_id,event_id,quest_id)
   SELECT r.id,ev.id,q.id FROM quest q WHERE q.event_id=ev.id AND (r.audience='all' OR q.category_id=r.category_id)
    AND q.visible AND NOT q.flash AND NOT is_live_poll(q.type,q.type_config) AND NOT quest_lock_missed(q);
   IF NOT FOUND THEN RAISE EXCEPTION 'no eligible quests' USING ERRCODE='SV409',DETAIL='souvenir_empty'; END IF;
   IF expected IS NOT NULL AND (ARRAY(SELECT t.quest_id FROM souvenir_target t WHERE t.rule_id=r.id ORDER BY t.quest_id))
      IS DISTINCT FROM (ARRAY(SELECT unnest(expected) ORDER BY 1)) THEN
    RAISE EXCEPTION 'souvenir targets changed' USING ERRCODE='SV409',DETAIL='souvenir_changed';
   END IF;
  END IF;
  UPDATE souvenir_rule SET status='active',activated_at=now() WHERE id=r.id;
  INSERT INTO souvenir_scan(rule_id) VALUES(r.id);
 ELSIF action='stop' AND r.status='active' THEN
  UPDATE souvenir_rule SET status='stopped',stopped_at=now() WHERE id=r.id;
  DELETE FROM souvenir_scan WHERE rule_id=r.id;
 ELSIF action='delete' AND r.status='draft' THEN
  DELETE FROM souvenir_target WHERE rule_id=r.id;
  DELETE FROM souvenir_rule WHERE id=r.id;
  DELETE FROM item WHERE id=r.item_id;
 ELSE RAISE EXCEPTION 'souvenir frozen' USING ERRCODE='SV409',DETAIL='souvenir_locked';
 END IF;
 PERFORM souvenir_audit(ev,'souvenir.'||action,r.id,request);
 PERFORM souvenir_remember(ev,action,jsonb_build_object('rule',target_rule,'targets',expected),request,r.id);
END $$;
REVOKE ALL ON FUNCTION souvenir_action(uuid,uuid,text,uuid,uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION souvenir_action(uuid,uuid,text,uuid,uuid[]) TO questify_app;

CREATE FUNCTION souvenir_request(target uuid,request uuid) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE ev event:=souvenir_event(target,true);
BEGIN
 IF souvenir_replay(ev,'process','{}',request) IS NOT NULL THEN RETURN; END IF;
 UPDATE souvenir_scan s SET cursor_id=NULL,next_at=now() FROM souvenir_rule r
 WHERE r.id=s.rule_id AND r.event_id=ev.id AND r.status='active';
 PERFORM souvenir_audit(ev,'souvenir.process',ev.id,request);
 PERFORM souvenir_remember(ev,'process','{}',request,ev.id);
END $$;
REVOKE ALL ON FUNCTION souvenir_request(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION souvenir_request(uuid,uuid) TO questify_app;

-- Bounded repair/backfill: mark up to 500 real members, retain a cursor, repeat completed scans every minute.
CREATE FUNCTION souvenir_scan_batch(only_event uuid) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE chosen souvenir_scan; ev uuid; members uuid[]; member uuid;
BEGIN
 PERFORM souvenir_system_only();
 SELECT s.* INTO chosen FROM souvenir_scan s JOIN souvenir_rule r ON r.id=s.rule_id
 WHERE r.status='active' AND s.next_at<=now() AND (only_event IS NULL OR r.event_id=only_event)
 ORDER BY s.next_at,s.rule_id FOR UPDATE OF s SKIP LOCKED LIMIT 1;
 IF NOT FOUND THEN RETURN 0; END IF;
 SELECT r.event_id INTO ev FROM souvenir_rule r WHERE r.id=chosen.rule_id;
 members:=ARRAY(SELECT n.id FROM enrollment n JOIN player p ON p.id=n.player_id
  WHERE n.event_id=ev AND n.joined_via IS DISTINCT FROM 'rehearsal' AND p.status='active'
   AND n.status='active' AND NOT n.waitlisted AND (chosen.cursor_id IS NULL OR n.id>chosen.cursor_id)
  ORDER BY n.id LIMIT 500);
 FOREACH member IN ARRAY members LOOP PERFORM souvenir_enqueue(member); END LOOP;
 UPDATE souvenir_scan SET cursor_id=CASE WHEN cardinality(members)=500 THEN members[500] END,
  next_at=CASE WHEN cardinality(members)=500 THEN now() ELSE now()+interval '1 minute' END WHERE rule_id=chosen.rule_id;
 RETURN cardinality(members);
END $$;
REVOKE ALL ON FUNCTION souvenir_scan_batch(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION souvenir_scan_batch(uuid) TO questify_app;

CREATE FUNCTION souvenir_claim_work(only_event uuid,page_size integer)
 RETURNS TABLE(event_id uuid,enrollment_id uuid,generation bigint,lease_token uuid)
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM souvenir_system_only();
 RETURN QUERY WITH due AS(SELECT w.event_id,w.enrollment_id FROM souvenir_work w
  WHERE w.ready_at<=now() AND (w.lease_until IS NULL OR w.lease_until<now())
   AND (only_event IS NULL OR w.event_id=only_event)
  ORDER BY w.ready_at,w.enrollment_id FOR UPDATE SKIP LOCKED LIMIT least(greatest(page_size,1),500))
 UPDATE souvenir_work w SET lease_token=gen_random_uuid(),lease_until=now()+interval '60 seconds',attempts=w.attempts+1
 FROM due d WHERE w.event_id=d.event_id AND w.enrollment_id=d.enrollment_id
 RETURNING w.event_id,w.enrollment_id,w.generation,w.lease_token;
END $$;
REVOKE ALL ON FUNCTION souvenir_claim_work(uuid,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION souvenir_claim_work(uuid,integer) TO questify_app;

CREATE FUNCTION souvenir_done(member uuid,target uuid) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT EXISTS(SELECT 1 FROM quest_completion c WHERE c.enrollment_id=member AND c.quest_id=target)
 OR EXISTS(SELECT 1 FROM quiz_attempt a WHERE a.enrollment_id=member AND a.quest_id=target AND a.status='finished')
 OR EXISTS(SELECT 1 FROM quest q WHERE q.id=target AND game_spent(member,q))
$$;
REVOKE ALL ON FUNCTION souvenir_done(uuid,uuid) FROM PUBLIC;

CREATE FUNCTION souvenir_evaluate(target uuid) RETURNS integer
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE who uuid; member enrollment; r souvenir_rule; made integer:=0; written integer;
BEGIN
 PERFORM souvenir_system_only();
 SELECT n.player_id INTO who FROM enrollment n WHERE n.id=target AND n.joined_via IS DISTINCT FROM 'rehearsal';
 IF who IS NULL THEN RETURN 0; END IF;
 -- SHARE, not KEY SHARE: a non-key admin status UPDATE must serialize with the entire grant.
 PERFORM 1 FROM player p WHERE p.id=who AND p.status='active' FOR SHARE;
 IF NOT FOUND THEN RETURN 0; END IF;
 SELECT * INTO member FROM enrollment n WHERE n.id=target FOR NO KEY UPDATE;
 IF member.player_id<>who OR member.status<>'active' OR member.waitlisted OR member.joined_via='rehearsal'
   OR NOT EXISTS(SELECT 1 FROM event e WHERE e.id=member.event_id AND event_status_now(e.status,e.starts_at,e.ends_at) IN ('live','ended','archived'))
 THEN RETURN 0; END IF;
 -- All rule locks precede XP. They do not lock event: confirm_results takes event then enrollment.
 PERFORM 1 FROM souvenir_rule sr WHERE sr.event_id=member.event_id AND sr.status='active' ORDER BY sr.id FOR SHARE;
 PERFORM 1 FROM player_xp x WHERE x.player_id=who FOR UPDATE;
 FOR r IN SELECT * FROM souvenir_rule sr WHERE sr.event_id=member.event_id AND sr.status='active' ORDER BY sr.id LOOP
  IF r.audience='rank' THEN
   CONTINUE WHEN NOT EXISTS(SELECT 1 FROM event_result er JOIN result_place rp ON rp.event_id=er.event_id
    WHERE er.event_id=member.event_id AND rp.enrollment_id=member.id AND rp.rank BETWEEN r.rank_from AND r.rank_to);
  ELSIF r.audience IN ('category','all') THEN
   CONTINUE WHEN EXISTS(SELECT 1 FROM staff_assignment a WHERE a.event_id=member.event_id AND a.player_id=who AND NOT a.can_play);
   CONTINUE WHEN NOT EXISTS(SELECT 1 FROM souvenir_target t WHERE t.rule_id=r.id)
    OR EXISTS(SELECT 1 FROM souvenir_target t WHERE t.rule_id=r.id AND NOT souvenir_done(member.id,t.quest_id));
  END IF;
  INSERT INTO souvenir_receipt(rule_id,event_id,item_id,player_id,enrollment_id)
   VALUES(r.id,r.event_id,r.item_id,who,member.id) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS written=ROW_COUNT;
  INSERT INTO player_item(player_id,item_id,source,source_rule_id,source_event_id,earned_at)
   SELECT who,r.item_id,'souvenir',r.id,r.event_id,s.earned_at FROM souvenir_receipt s
   WHERE s.rule_id=r.id AND s.player_id=who ON CONFLICT DO NOTHING;
  made:=made+written;
 END LOOP;
 RETURN made;
END $$;
REVOKE ALL ON FUNCTION souvenir_evaluate(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION souvenir_evaluate(uuid) TO questify_app;

CREATE FUNCTION souvenir_ack(target uuid,observed bigint,token uuid,failure text) RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM souvenir_system_only();
 IF failure IS NULL THEN
  DELETE FROM souvenir_work w WHERE w.enrollment_id=target AND w.generation=observed AND w.lease_token=token;
 END IF;
 UPDATE souvenir_work w SET lease_token=NULL,lease_until=NULL,error_code=left(failure,5),
  ready_at=CASE WHEN failure IS NULL THEN now() ELSE now()+make_interval(secs=>least(300,5*greatest(w.attempts,1))) END
 WHERE w.enrollment_id=target AND w.lease_token=token;
END $$;
REVOKE ALL ON FUNCTION souvenir_ack(uuid,bigint,uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION souvenir_ack(uuid,bigint,uuid,text) TO questify_app;

CREATE FUNCTION souvenir_health() RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 PERFORM souvenir_system_only();
 RETURN (SELECT jsonb_build_object('due',count(*),'failed',count(*) FILTER(WHERE error_code IS NOT NULL),
  'oldestAt',min(ready_at)) FROM souvenir_work);
END $$;
REVOKE ALL ON FUNCTION souvenir_health() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION souvenir_health() TO questify_app;

CREATE OR REPLACE FUNCTION result_depth(ev event) RETURNS integer
 LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
 SELECT greatest(10,coalesce((SELECT max(p.rank_to) FROM rank_prize p WHERE p.event_id=ev.id AND p.status='active' AND ev.rank_prizes),0),
  coalesce((SELECT max(r.rank_to) FROM souvenir_rule r WHERE r.event_id=ev.id AND r.status='active' AND r.audience='rank'),0))
$$;
REVOKE ALL ON FUNCTION result_depth(event) FROM PUBLIC;

DROP FUNCTION own_locker(timestamptz,text,integer);
CREATE FUNCTION own_locker(before_time timestamptz,before_item text,page_size integer)
 RETURNS TABLE(item jsonb,earned_at timestamptz,source_level smallint,source_event jsonb,seen boolean)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT item_json(o.item_id),o.earned_at,o.source_level,
  CASE WHEN o.source='souvenir' THEN jsonb_build_object('id',o.source_event_id,'name',jsonb_build_object(
   'ar',coalesce(e.name_ar,e.name_en,'فعالية سابقة'),'en',coalesce(e.name_en,e.name_ar,'Past event'))) END,o.seen_at IS NOT NULL
 FROM player_item o LEFT JOIN event e ON e.id=o.source_event_id
 WHERE o.player_id=profile_player() AND (before_time IS NULL OR (o.earned_at,o.item_id)<(before_time,before_item))
 ORDER BY o.earned_at DESC,o.item_id DESC LIMIT least(greatest(coalesce(page_size,30),1),101)
$$;
REVOKE ALL ON FUNCTION own_locker(timestamptz,text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION own_locker(timestamptz,text,integer) TO questify_app;


CREATE OR REPLACE FUNCTION erase_rows(me uuid, enrolled uuid[], key bytea) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM 1 FROM player_xp x WHERE x.player_id = me FOR UPDATE;
  DELETE FROM player_equipment WHERE player_id = me;
  PERFORM set_config('app.erasure','on',true);
  DELETE FROM player_item WHERE player_id = me;
  DELETE FROM souvenir_receipt WHERE player_id = me;
  DELETE FROM souvenir_work WHERE enrollment_id = ANY(enrolled);
  PERFORM set_config('app.erasure','',true);
  -- The append-only histories let a DELETE through under this flag only, for this transaction.
  PERFORM set_config('app.erasure', 'on', true);
  DELETE FROM username_history WHERE player_id = me;
  DELETE FROM player_acceptance WHERE player_id = me;
  PERFORM set_config('app.erasure', '', true);
  DELETE FROM player_fingerprint WHERE player_id = me;
  -- Open sign-in codes for the account's contacts (they hold the contact in clear).
  DELETE FROM player_login_challenge l
  WHERE l.contact_key = key
     OR l.contact IN (SELECT unnest(ARRAY[pc.phone_e164, pc.email]) FROM player_contact pc WHERE pc.player_id = me);
  DELETE FROM player_contact WHERE player_id = me;
  DELETE FROM player_contact_challenge WHERE player_id = me;
  DELETE FROM player_session WHERE player_id = me;
  DELETE FROM player_refresh WHERE player_id = me;
  DELETE FROM player_deletion_challenge WHERE player_id = me;
  DELETE FROM staff_assignment WHERE player_id = me;
  DELETE FROM ticket WHERE player_id = me;
  DELETE FROM join_answer WHERE enrollment_id = ANY (enrolled);
  DELETE FROM flag WHERE enrollment_id = ANY (enrolled);
  DELETE FROM completion_position WHERE enrollment_id = ANY (enrolled);
  DELETE FROM meeting m WHERE m.scanner_enrollment = ANY (enrolled) OR m.shown_enrollment = ANY (enrolled);
  DELETE FROM meet_pass p WHERE p.enrollment_id = ANY (enrolled);
  UPDATE quest_completion SET device_id = NULL WHERE enrollment_id = ANY (enrolled) AND device_id IS NOT NULL;
  UPDATE ledger_note t SET reason = NULL
  FROM ledger_entry l WHERE l.id = t.entry_id AND l.enrollment_id = ANY (enrolled) AND t.reason IS NOT NULL;
  UPDATE enrollment n
  SET status = CASE WHEN n.status IN ('active', 'pending') THEN 'left' ELSE n.status END,
      waitlisted = false, goal_reward_id = NULL, redeem_paused_at = NULL
  WHERE n.id = ANY (enrolled);
  UPDATE submission s
  SET body = NULL, reason = CASE WHEN s.reason_system THEN s.reason END, erased_at = now()
  WHERE s.enrollment_id = ANY (enrolled) AND s.erased_at IS NULL;
  DELETE FROM quest_vote WHERE enrollment_id = ANY (enrolled);
  DELETE FROM survey_response WHERE enrollment_id = ANY (enrolled);
  DELETE FROM category_bonus WHERE enrollment_id = ANY (enrolled);
  DELETE FROM category_reveal WHERE enrollment_id = ANY (enrolled);
  DELETE FROM quest_item_miss WHERE enrollment_id = ANY (enrolled);
  DELETE FROM passport_stamp WHERE enrollment_id = ANY (enrolled);
  DELETE FROM quiz_answer a USING quiz_attempt t WHERE t.id = a.attempt_id AND t.enrollment_id = ANY (enrolled);
  DELETE FROM game_round g WHERE g.enrollment_id = ANY (enrolled);
  UPDATE player
  SET status = 'deleted', deleted_at = now(), username = NULL, birth_year = NULL, avatar = 'falcon',
      my_qr_version = my_qr_version + 1
  WHERE id = me;
END $$;
REVOKE ALL ON FUNCTION erase_rows(uuid,uuid[],bytea) FROM PUBLIC;

-- A result-place fact is visible to workers only after confirmation commits the entire snapshot.
CREATE TRIGGER souvenir_on_results AFTER INSERT ON result_place FOR EACH ROW EXECUTE FUNCTION souvenir_on_fact();
