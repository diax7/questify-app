-- T-402; drain old erasures before XP writers and reached rows. No CASCADE or deployed migration edits.
SET LOCAL lock_timeout = '10s';
LOCK TABLE player IN EXCLUSIVE MODE;
LOCK TABLE player_xp IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE level_reached IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE item (
 id text PRIMARY KEY CHECK(id ~ '^[a-z][a-z0-9-]{0,63}$'),
 kind text NOT NULL CHECK(kind IN ('character','frame','title')),
 name_ar text NOT NULL CHECK(length(btrim(name_ar)) BETWEEN 1 AND 60),
 name_en text NOT NULL CHECK(length(btrim(name_en)) BETWEEN 1 AND 60),
 visual_key text, created_at timestamptz NOT NULL DEFAULT now(),
 CHECK(kind='title' OR visual_key IS NOT NULL),
 CHECK((kind='title' AND visual_key IS NULL) OR (kind='character' AND visual_key='chest') OR
       (kind='frame' AND visual_key ~ '^frame-(0[1-9]|1[0-4])$'))
);
CREATE TABLE level_item (
 level smallint PRIMARY KEY REFERENCES xp_level(level) CHECK(level >= 2),
 item_id text NOT NULL UNIQUE REFERENCES item(id), UNIQUE(level,item_id)
);
CREATE TABLE player_item (
 player_id uuid NOT NULL REFERENCES player_xp(player_id), item_id text NOT NULL REFERENCES item(id),
 source text NOT NULL DEFAULT 'level' CHECK(source='level'), source_level smallint NOT NULL,
 earned_at timestamptz NOT NULL, seen_at timestamptz,
 PRIMARY KEY(player_id,item_id), UNIQUE(player_id,source_level),
 FOREIGN KEY(player_id,source_level) REFERENCES level_reached(player_id,level),
 FOREIGN KEY(source_level,item_id) REFERENCES level_item(level,item_id)
);
CREATE INDEX player_item_page ON player_item(player_id,earned_at DESC,item_id DESC);
CREATE TABLE player_equipment (
 player_id uuid PRIMARY KEY REFERENCES player_xp(player_id), character_id text, frame_id text, title_id text,
 updated_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(player_id,character_id) REFERENCES player_item(player_id,item_id),
 FOREIGN KEY(player_id,frame_id) REFERENCES player_item(player_id,item_id),
 FOREIGN KEY(player_id,title_id) REFERENCES player_item(player_id,item_id)
);
ALTER TABLE item ENABLE ROW LEVEL SECURITY;
ALTER TABLE item FORCE ROW LEVEL SECURITY;
REVOKE ALL ON item FROM PUBLIC,questify_app;
ALTER TABLE level_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE level_item FORCE ROW LEVEL SECURITY;
REVOKE ALL ON level_item FROM PUBLIC,questify_app;
ALTER TABLE player_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_item FORCE ROW LEVEL SECURITY;
REVOKE ALL ON player_item FROM PUBLIC,questify_app;
ALTER TABLE player_equipment ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_equipment FORCE ROW LEVEL SECURITY;
REVOKE ALL ON player_equipment FROM PUBLIC,questify_app;

CREATE FUNCTION item_json(target text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('id',i.id,'kind',i.kind,'name',jsonb_build_object('ar',i.name_ar,'en',i.name_en),
 'visualKey',i.visual_key) FROM item i WHERE i.id=target
$$;
REVOKE ALL ON FUNCTION item_json(text) FROM PUBLIC;
CREATE FUNCTION item_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.kind IS DISTINCT FROM OLD.kind THEN
  RAISE EXCEPTION 'item identity is immutable' USING ERRCODE='insufficient_privilege';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION item_identity_guard() FROM PUBLIC;
CREATE TRIGGER item_identity_guard BEFORE UPDATE ON item FOR EACH ROW EXECUTE FUNCTION item_identity_guard();
ALTER TABLE item ENABLE ALWAYS TRIGGER item_identity_guard;
CREATE FUNCTION owned_item_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  IF current_setting('app.erasure',true)='on' THEN RETURN OLD; END IF;
 ELSIF (NEW.player_id,NEW.item_id,NEW.source,NEW.source_level,NEW.earned_at) IS NOT DISTINCT FROM
       (OLD.player_id,OLD.item_id,OLD.source,OLD.source_level,OLD.earned_at) THEN RETURN NEW;
 END IF;
 RAISE EXCEPTION 'earned items can only be acknowledged or erased' USING ERRCODE='insufficient_privilege';
END $$;
REVOKE ALL ON FUNCTION owned_item_guard() FROM PUBLIC;
CREATE TRIGGER owned_item_guard BEFORE UPDATE OR DELETE ON player_item FOR EACH ROW EXECUTE FUNCTION owned_item_guard();
ALTER TABLE player_item ENABLE ALWAYS TRIGGER owned_item_guard;
CREATE TRIGGER player_item_no_truncate BEFORE TRUNCATE ON player_item FOR EACH STATEMENT EXECUTE FUNCTION xp_append_only();
ALTER TABLE player_item ENABLE ALWAYS TRIGGER player_item_no_truncate;

CREATE FUNCTION grant_level_item() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE chosen text;
BEGIN
 SELECT m.item_id INTO chosen FROM level_item m WHERE m.level=NEW.level;
 IF chosen IS NULL THEN RAISE EXCEPTION 'level reward mapping is missing' USING ERRCODE='23514'; END IF;
 INSERT INTO player_item(player_id,item_id,source_level,earned_at)
 VALUES(NEW.player_id,chosen,NEW.level,NEW.reached_at) ON CONFLICT DO NOTHING;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION grant_level_item() FROM PUBLIC;
CREATE TRIGGER grant_level_item AFTER INSERT ON level_reached FOR EACH ROW EXECUTE FUNCTION grant_level_item();
CREATE FUNCTION profile_player() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT p.id FROM player p WHERE p.id=app_player_id() AND p.status='active'
$$;
REVOKE ALL ON FUNCTION profile_player() FROM PUBLIC;
CREATE FUNCTION own_equipment() RETURNS TABLE(equipment jsonb,next_reward jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('character',item_json(e.character_id),'frame',item_json(e.frame_id),'title',item_json(e.title_id)),item_json(m.item_id)
 FROM player_xp x LEFT JOIN player_equipment e ON e.player_id=x.player_id LEFT JOIN level_item m ON m.level=x.level+1
 WHERE x.player_id=profile_player()
$$;
REVOKE ALL ON FUNCTION own_equipment() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION own_equipment() TO questify_app;
CREATE FUNCTION own_locker(before_time timestamptz,before_item text,page_size integer)
RETURNS TABLE(item jsonb,earned_at timestamptz,source_level smallint,seen boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT item_json(o.item_id),o.earned_at,o.source_level,o.seen_at IS NOT NULL FROM player_item o
 WHERE o.player_id=profile_player() AND (before_time IS NULL OR (o.earned_at,o.item_id)<(before_time,before_item))
 ORDER BY o.earned_at DESC,o.item_id DESC LIMIT least(greatest(coalesce(page_size,30),1),101)
$$;
REVOKE ALL ON FUNCTION own_locker(timestamptz,text,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION own_locker(timestamptz,text,integer) TO questify_app;
CREATE FUNCTION equip_player(changes jsonb) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE who uuid; slot text; chosen text; old player_equipment%ROWTYPE;
BEGIN
 SELECT p.id INTO who FROM player p WHERE p.id=app_player_id() AND p.status='active' FOR UPDATE;
 IF who IS NULL THEN RAISE EXCEPTION 'active player required' USING ERRCODE='PI401'; END IF;
 IF changes ? 'avatar' AND changes ? 'characterId' THEN RAISE EXCEPTION 'conflicting character choices' USING ERRCODE='PI422'; END IF;
 IF changes ? 'avatar' AND (changes->>'avatar' IS NULL OR changes->>'avatar' NOT IN ('falcon','fox','camel','owl','lantern','explorer-hat')) THEN
  RAISE EXCEPTION 'unknown starter' USING ERRCODE='PI422';
 END IF;
 FOREACH slot IN ARRAY ARRAY['character','frame','title'] LOOP
  chosen:=changes->>(slot||'Id');
  IF chosen IS NOT NULL AND NOT EXISTS(SELECT 1 FROM player_item o JOIN item i ON i.id=o.item_id
    WHERE o.player_id=who AND o.item_id=chosen AND i.kind=slot) THEN
   RAISE EXCEPTION 'item is not owned in that slot' USING ERRCODE='PI422';
  END IF;
 END LOOP;
 SELECT * INTO old FROM player_equipment e WHERE e.player_id=who;
 IF changes ? 'avatar' THEN UPDATE player SET avatar=changes->>'avatar' WHERE id=who; END IF;
 INSERT INTO player_equipment(player_id,character_id,frame_id,title_id)
 VALUES(who,CASE WHEN changes ? 'avatar' THEN NULL WHEN changes ? 'characterId' THEN changes->>'characterId' ELSE old.character_id END,
 CASE WHEN changes ? 'frameId' THEN changes->>'frameId' ELSE old.frame_id END,
 CASE WHEN changes ? 'titleId' THEN changes->>'titleId' ELSE old.title_id END)
 ON CONFLICT(player_id) DO UPDATE SET character_id=EXCLUDED.character_id,frame_id=EXCLUDED.frame_id,title_id=EXCLUDED.title_id,updated_at=now()
 WHERE (player_equipment.character_id,player_equipment.frame_id,player_equipment.title_id) IS DISTINCT FROM
       (EXCLUDED.character_id,EXCLUDED.frame_id,EXCLUDED.title_id);
END $$;
REVOKE ALL ON FUNCTION equip_player(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION equip_player(jsonb) TO questify_app;
REVOKE UPDATE(avatar) ON player FROM questify_app;
CREATE FUNCTION see_owned_items(ids text[]) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE who uuid;
BEGIN
 SELECT p.id INTO who FROM player p WHERE p.id=app_player_id() AND p.status='active' FOR KEY SHARE;
 IF who IS NULL THEN RAISE EXCEPTION 'active player required' USING ERRCODE='PI401'; END IF;
 PERFORM 1 FROM player_item o WHERE o.player_id=who AND o.item_id=ANY(ids) ORDER BY o.item_id FOR UPDATE;
 UPDATE player_item o SET seen_at=now() WHERE o.player_id=who AND o.item_id=ANY(ids) AND o.seen_at IS NULL;
END $$;
REVOKE ALL ON FUNCTION see_owned_items(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION see_owned_items(text[]) TO questify_app;
CREATE FUNCTION public_player_profile(chosen_name text) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT jsonb_build_object('username',p.username,'character',coalesce(item_json(e.character_id),jsonb_build_object('starter',p.avatar)),
 'frame',item_json(e.frame_id),'title',item_json(e.title_id),
 'level',jsonb_build_object('number',x.level,'title',jsonb_build_object('ar',t.name_ar,'en',t.name_en)))
 FROM player p JOIN player_xp x ON x.player_id=p.id LEFT JOIN player_equipment e ON e.player_id=p.id
 LEFT JOIN LATERAL level_title_of(x.level) t ON true
 WHERE profile_player() IS NOT NULL AND username_fold(p.username)=username_fold(chosen_name) AND p.status='active'
$$;
REVOKE ALL ON FUNCTION public_player_profile(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_player_profile(text) TO questify_app;
CREATE FUNCTION own_level_items(completion bigint) RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT coalesce(jsonb_agg(item_json(o.item_id) ORDER BY r.level),'[]'::jsonb)
 FROM level_reached r JOIN xp_entry x ON x.id=r.xp_entry_id JOIN ledger_entry l ON l.id=x.ledger_entry_id
 JOIN player_item o ON o.player_id=r.player_id AND o.source_level=r.level
 WHERE r.player_id=profile_player() AND l.completion_id=completion AND l.kind='quest'
$$;
REVOKE ALL ON FUNCTION own_level_items(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION own_level_items(bigint) TO questify_app;

INSERT INTO item(id,kind,name_ar,name_en,visual_key) VALUES ('level-2','frame','إطار الدرب','Trail frame','frame-01');
INSERT INTO level_item(level,item_id) VALUES (2,'level-2');

INSERT INTO item(id,kind,name_ar,name_en,visual_key) VALUES ('level-3','title','رفيق الدرب','Trail companion',NULL);
INSERT INTO level_item(level,item_id) VALUES (3,'level-3');

INSERT INTO item(id,kind,name_ar,name_en,visual_key) VALUES ('level-4','character','صندوق الكنز','Treasure chest','chest');
INSERT INTO level_item(level,item_id) VALUES (4,'level-4');

INSERT INTO item(id,kind,name_ar,name_en,visual_key) VALUES ('level-5','title','دليل الواحة','Oasis guide',NULL);
INSERT INTO level_item(level,item_id) VALUES (5,'level-5');

INSERT INTO item(id,kind,name_ar,name_en,visual_key) VALUES ('level-6','frame','إطار الواحة','Oasis frame','frame-02');
INSERT INTO level_item(level,item_id) VALUES (6,'level-6');

INSERT INTO item(id,kind,name_ar,name_en,visual_key) VALUES ('level-7','title','حارس الكنز','Treasure keeper',NULL);
INSERT INTO level_item(level,item_id) VALUES (7,'level-7');

INSERT INTO item(id,kind,name_ar,name_en,visual_key) VALUES ('level-8','frame','إطار الكنز','Treasure frame','frame-03');
INSERT INTO level_item(level,item_id) VALUES (8,'level-8');

INSERT INTO item(id,kind,name_ar,name_en,visual_key) VALUES ('level-9','title','رحالة الصحراء','Desert traveler',NULL);
INSERT INTO level_item(level,item_id) VALUES (9,'level-9');

INSERT INTO item(id,kind,name_ar,name_en,visual_key) VALUES ('level-10','frame','إطار الصحراء','Desert frame','frame-04');
INSERT INTO level_item(level,item_id) VALUES (10,'level-10');

INSERT INTO item(id,kind,name_ar,name_en,visual_key) VALUES ('level-11','title','مستكشف الأفق','Horizon explorer',NULL);
INSERT INTO level_item(level,item_id) VALUES (11,'level-11');

INSERT INTO item(id,kind,name_ar,name_en,visual_key) VALUES ('level-12','frame','إطار الأفق','Horizon frame','frame-05');
INSERT INTO level_item(level,item_id) VALUES (12,'level-12');

INSERT INTO item(id,kind,name_ar,name_en,visual_key) VALUES ('level-13','title','قائد القافلة','Caravan leader',NULL);
INSERT INTO level_item(level,item_id) VALUES (13,'level-13');

INSERT INTO item(id,kind,name_ar,name_en,visual_key) VALUES ('level-14','frame','إطار القافلة','Caravan frame','frame-06');
INSERT INTO level_item(level,item_id) VALUES (14,'level-14');

INSERT INTO item(id,kind,name_ar,name_en,visual_key) VALUES ('level-15','title','جامع الجواهر','Gem collector',NULL);
INSERT INTO level_item(level,item_id) VALUES (15,'level-15');

INSERT INTO item(id,kind,name_ar,name_en,visual_key) VALUES ('level-16','frame','إطار الجوهرة','Gem frame','frame-07');
INSERT INTO level_item(level,item_id) VALUES (16,'level-16');

INSERT INTO item(id,kind,name_ar,name_en,visual_key) VALUES ('level-17','title','متسلق القمم','Summit climber',NULL);
INSERT INTO level_item(level,item_id) VALUES (17,'level-17');

INSERT INTO item(id,kind,name_ar,name_en,visual_key) VALUES ('level-18','frame','إطار القمة','Summit frame','frame-08');
INSERT INTO level_item(level,item_id) VALUES (18,'level-18');

INSERT INTO item(id,kind,name_ar,name_en,visual_key) VALUES ('level-19','title','متتبع النجوم','Star tracker',NULL);
INSERT INTO level_item(level,item_id) VALUES (19,'level-19');

INSERT INTO item(id,kind,name_ar,name_en,visual_key) VALUES ('level-20','frame','إطار النجمة','Star frame','frame-09');
INSERT INTO level_item(level,item_id) VALUES (20,'level-20');

INSERT INTO item(id,kind,name_ar,name_en,visual_key) VALUES ('level-21','title','راوي الرحلات','Journey teller',NULL);
INSERT INTO level_item(level,item_id) VALUES (21,'level-21');

INSERT INTO item(id,kind,name_ar,name_en,visual_key) VALUES ('level-22','frame','إطار الرحلة','Journey frame','frame-10');
INSERT INTO level_item(level,item_id) VALUES (22,'level-22');

INSERT INTO item(id,kind,name_ar,name_en,visual_key) VALUES ('level-23','title','صاحب العزيمة','Steadfast adventurer',NULL);
INSERT INTO level_item(level,item_id) VALUES (23,'level-23');

INSERT INTO item(id,kind,name_ar,name_en,visual_key) VALUES ('level-24','frame','إطار البطل','Champion frame','frame-11');
INSERT INTO level_item(level,item_id) VALUES (24,'level-24');

INSERT INTO item(id,kind,name_ar,name_en,visual_key) VALUES ('level-25','title','حامل التاج','Crown bearer',NULL);
INSERT INTO level_item(level,item_id) VALUES (25,'level-25');

INSERT INTO item(id,kind,name_ar,name_en,visual_key) VALUES ('level-26','frame','إطار التاج','Crown frame','frame-12');
INSERT INTO level_item(level,item_id) VALUES (26,'level-26');

INSERT INTO item(id,kind,name_ar,name_en,visual_key) VALUES ('level-27','title','راوي الأساطير','Legend teller',NULL);
INSERT INTO level_item(level,item_id) VALUES (27,'level-27');

INSERT INTO item(id,kind,name_ar,name_en,visual_key) VALUES ('level-28','frame','إطار الأسطورة','Legend frame','frame-13');
INSERT INTO level_item(level,item_id) VALUES (28,'level-28');

INSERT INTO item(id,kind,name_ar,name_en,visual_key) VALUES ('level-29','title','سيد المغامرة','Adventure master',NULL);
INSERT INTO level_item(level,item_id) VALUES (29,'level-29');

INSERT INTO item(id,kind,name_ar,name_en,visual_key) VALUES ('level-30','frame','إطار المغامرة','Adventure frame','frame-14');
INSERT INTO level_item(level,item_id) VALUES (30,'level-30');

CREATE OR REPLACE FUNCTION erase_rows(me uuid, enrolled uuid[], key bytea) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM 1 FROM player_xp x WHERE x.player_id = me FOR UPDATE;
  DELETE FROM player_equipment WHERE player_id = me;
  PERFORM set_config('app.erasure','on',true);
  DELETE FROM player_item WHERE player_id = me;
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

DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM xp_level l WHERE l.level>1 AND NOT EXISTS(SELECT 1 FROM level_item m WHERE m.level=l.level)) THEN
  RAISE EXCEPTION 'level reward mapping is incomplete' USING ERRCODE='23514';
 END IF;
END $$;
CREATE FUNCTION backfill_level_items() RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=public,pg_temp AS $$
 INSERT INTO player_item(player_id,item_id,source_level,earned_at)
 SELECT r.player_id,m.item_id,r.level,r.reached_at FROM level_reached r
 JOIN player p ON p.id=r.player_id AND p.status<>'deleted' JOIN level_item m ON m.level=r.level
 ON CONFLICT DO NOTHING
$$;
REVOKE ALL ON FUNCTION backfill_level_items() FROM PUBLIC;
SELECT backfill_level_items();

DROP FUNCTION ranking_rows(uuid, uuid[]);
CREATE FUNCTION ranking_rows(target uuid, ids uuid[])
  RETURNS TABLE (enrollment_id uuid, username text, avatar text, equipment jsonb, ranked boolean)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF ranking_reader_enrollment(target) IS NULL THEN
    RAISE EXCEPTION 'not an active player of the event' USING ERRCODE = 'QR403';
  END IF;
  RETURN QUERY
    SELECT e.id, CASE WHEN rule.ok THEN p.username END, CASE WHEN rule.ok THEN p.avatar END, CASE WHEN rule.ok THEN jsonb_build_object('character',item_json(eq.character_id),'frame',item_json(eq.frame_id),'title',item_json(eq.title_id)) END, rule.ok
    FROM enrollment e JOIN player p ON p.id = e.player_id LEFT JOIN player_equipment eq ON eq.player_id = p.id, LATERAL (SELECT ranking_eligible(e) AS ok) rule
    WHERE e.id = ANY (ids) AND e.event_id = target;
END $$;
REVOKE ALL ON FUNCTION ranking_rows(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ranking_rows(uuid, uuid[]) TO questify_app;

DROP FUNCTION ranking_top(uuid, integer);
CREATE FUNCTION ranking_top(target uuid, size integer)
  RETURNS TABLE (enrollment_id uuid, username text, avatar text, equipment jsonb, score bigint, score_version bigint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH reader AS MATERIALIZED (SELECT ranking_reader_enrollment(target) AS id)
  SELECT r.id, p.username, p.avatar, jsonb_build_object('character',item_json(eq.character_id),'frame',item_json(eq.frame_id),'title',item_json(eq.title_id)), r.score, r.score_version
  FROM reader, ranked_enrollments(target) r JOIN player p ON p.id = r.player_id LEFT JOIN player_equipment eq ON eq.player_id = p.id
  WHERE reader.id IS NOT NULL AND r.ranked
  ORDER BY r.score DESC, r.score_version ASC
  LIMIT least(greatest(size, 0), 100)
$$;
REVOKE ALL ON FUNCTION ranking_top(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ranking_top(uuid, integer) TO questify_app;

DROP FUNCTION ranking_day_top(uuid, integer);
CREATE FUNCTION ranking_day_top(target uuid, size integer)
  RETURNS TABLE (enrollment_id uuid, username text, avatar text, equipment jsonb, score bigint, score_version bigint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH reader AS MATERIALIZED (SELECT ranking_reader_enrollment(target) AS id)
  SELECT r.id, p.username, p.avatar, jsonb_build_object('character',item_json(eq.character_id),'frame',item_json(eq.frame_id),'title',item_json(eq.title_id)), r.score, r.score_version
  FROM reader, event ev,
       LATERAL ranked_day(target, event_day(now(), ev)) r JOIN player p ON p.id = r.player_id LEFT JOIN player_equipment eq ON eq.player_id = p.id
  WHERE reader.id IS NOT NULL AND ev.id = target AND r.ranked
  ORDER BY r.score DESC, r.score_version ASC
  LIMIT least(greatest(size, 0), 100)
$$;
REVOKE ALL ON FUNCTION ranking_day_top(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ranking_day_top(uuid, integer) TO questify_app;
