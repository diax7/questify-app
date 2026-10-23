-- Targeting (T-220, FR-1708, ADR-170 to ADR-173): a category or a reward may be limited to the players whose answer
-- to a choice field is one of chosen options, or whose guest entry carries one of chosen tags. Players outside the
-- audience do not see the item, cannot complete its quests and cannot reserve or pin the reward. Fails closed: a field
-- or an option a rule or an answer names cannot go. Rehearsal enrollments see everything.

-- ================================================================ choice fields (ADR-171)
-- 2 to 20 options, each {id, ar, en}: a short id, a label in at least one language (1 to 60 characters, trimmed).
CREATE FUNCTION join_options_valid(options jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_typeof(options) = 'array'
    AND jsonb_array_length(options) BETWEEN 2 AND 20
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(options) o
      WHERE jsonb_typeof(o) <> 'object'
         OR EXISTS (SELECT 1 FROM jsonb_object_keys(o) k WHERE k NOT IN ('id', 'ar', 'en'))
         OR jsonb_typeof(o -> 'id') IS DISTINCT FROM 'string'
         OR o ->> 'id' !~ '^[a-z0-9]{1,12}$'
         OR coalesce(o ->> 'ar', o ->> 'en') IS NULL
         OR EXISTS (SELECT 1 FROM (VALUES (o -> 'ar'), (o -> 'en')) AS l(label)
                    WHERE l.label IS NOT NULL AND jsonb_typeof(l.label) <> 'null'
                      AND (jsonb_typeof(l.label) <> 'string'
                           OR length(l.label #>> '{}') NOT BETWEEN 1 AND 60
                           OR l.label #>> '{}' <> btrim(l.label #>> '{}')
                           OR l.label #>> '{}' ~ '[[:cntrl:]]')))
    AND (SELECT count(DISTINCT o ->> 'id') FROM jsonb_array_elements(options) o) = jsonb_array_length(options)
$$;

-- A pure check: the team's writes evaluate it in the constraint below.
REVOKE ALL ON FUNCTION join_options_valid(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION join_options_valid(jsonb) TO questify_app;

ALTER TABLE event_join_field ADD COLUMN options jsonb;
ALTER TABLE event_join_field ADD CONSTRAINT event_join_field_options_shape
  CHECK (options IS NULL OR (kind = 'custom' AND join_options_valid(options)));
GRANT INSERT (options), UPDATE (options) ON event_join_field TO questify_app;

-- ================================================================ guest tags (ADR-172)
-- One optional tag an entry, matched case-insensitively. Personal context: never in the audit or an error.
ALTER TABLE event_guest ADD COLUMN tag text
  CHECK (tag IS NULL OR (length(tag) BETWEEN 1 AND 30 AND tag = btrim(tag) AND tag !~ '[[:cntrl:]]'));
CREATE INDEX event_guest_tag_idx ON event_guest (event_id, lower(tag)) WHERE tag IS NOT NULL;
GRANT INSERT (tag), UPDATE (tag) ON event_guest TO questify_app;

-- ================================================================ the rules (ADR-170)
-- Written only by set_audience (no column grant). The field key is NO ACTION, so a draft event's delete cascades
-- through its fields and these rows in one statement, while deleting one targeted field is refused.
ALTER TABLE category
  ADD COLUMN audience_kind text CHECK (audience_kind IN ('answer', 'tag')),
  ADD COLUMN audience_field_id uuid,
  ADD COLUMN audience_values text[],
  ADD CONSTRAINT category_audience_shape CHECK (
    (audience_kind IS NULL AND audience_field_id IS NULL AND audience_values IS NULL)
    OR (audience_kind = 'answer' AND audience_field_id IS NOT NULL AND cardinality(audience_values) BETWEEN 1 AND 20)
    OR (audience_kind = 'tag' AND audience_field_id IS NULL AND cardinality(audience_values) BETWEEN 1 AND 20)),
  ADD CONSTRAINT category_audience_field_fkey
    FOREIGN KEY (audience_field_id, event_id) REFERENCES event_join_field (id, event_id);
CREATE INDEX category_audience_field_idx ON category (audience_field_id) WHERE audience_field_id IS NOT NULL;

ALTER TABLE reward
  ADD COLUMN audience_kind text CHECK (audience_kind IN ('answer', 'tag')),
  ADD COLUMN audience_field_id uuid,
  ADD COLUMN audience_values text[],
  ADD CONSTRAINT reward_audience_shape CHECK (
    (audience_kind IS NULL AND audience_field_id IS NULL AND audience_values IS NULL)
    OR (audience_kind = 'answer' AND audience_field_id IS NOT NULL AND cardinality(audience_values) BETWEEN 1 AND 20)
    OR (audience_kind = 'tag' AND audience_field_id IS NULL AND cardinality(audience_values) BETWEEN 1 AND 20)),
  ADD CONSTRAINT reward_audience_field_fkey
    FOREIGN KEY (audience_field_id, event_id) REFERENCES event_join_field (id, event_id);
CREATE INDEX reward_audience_field_idx ON reward (audience_field_id) WHERE audience_field_id IS NOT NULL;

-- ================================================================ options in use (review 1, ADR-173)
-- Options are set only while the field has no answers; afterwards labels change and options are added, but an option
-- an answer or a rule names cannot be removed, nor all options cleared. QT409 with DETAIL answers or rules.
CREATE FUNCTION event_join_field_options_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  removed text[];
BEGIN
  IF OLD.options IS NULL AND NEW.options IS NOT NULL
     AND EXISTS (SELECT 1 FROM join_answer a WHERE a.field_id = OLD.id) THEN
    RAISE EXCEPTION 'this field already has answers' USING ERRCODE = 'QT409', DETAIL = 'answers';
  END IF;
  SELECT coalesce(array_agg(o ->> 'id'), '{}') INTO removed
  FROM jsonb_array_elements(coalesce(OLD.options, '[]'::jsonb)) o
  WHERE NOT coalesce(NEW.options, '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('id', o ->> 'id'));
  IF cardinality(removed) = 0 THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM join_answer a WHERE a.field_id = OLD.id AND a.value = ANY (removed)) THEN
    RAISE EXCEPTION 'an answer names this option' USING ERRCODE = 'QT409', DETAIL = 'answers';
  END IF;
  IF EXISTS (SELECT 1 FROM category c WHERE c.audience_field_id = OLD.id
             AND (NEW.options IS NULL OR c.audience_values && removed))
     OR EXISTS (SELECT 1 FROM reward r WHERE r.audience_field_id = OLD.id
                AND (NEW.options IS NULL OR r.audience_values && removed)) THEN
    RAISE EXCEPTION 'a targeting rule names this option' USING ERRCODE = 'QT409', DETAIL = 'rules';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION event_join_field_options_guard() FROM PUBLIC;
CREATE TRIGGER event_join_field_options_guard BEFORE UPDATE OF options ON event_join_field
  FOR EACH ROW WHEN (OLD.options IS DISTINCT FROM NEW.options) EXECUTE FUNCTION event_join_field_options_guard();

-- ================================================================ who is in an audience
-- True for no rule and for a rehearsal enrollment; else the member's answer is one of the options, or one of the
-- guest entries matching their phone or email carries one of the tags (case-insensitive). Called by definers only.
CREATE FUNCTION in_audience(member uuid, rule_kind text, rule_field uuid, rule_values text[]) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT rule_kind IS NULL
    OR EXISTS (SELECT 1 FROM enrollment n WHERE n.id = member AND n.joined_via = 'rehearsal')
    OR (rule_kind = 'answer' AND EXISTS (
          SELECT 1 FROM join_answer a
          WHERE a.enrollment_id = member AND a.field_id = rule_field AND a.value = ANY (rule_values)))
    OR (rule_kind = 'tag' AND EXISTS (
          SELECT 1 FROM enrollment n
          JOIN player_contact pc ON pc.player_id = n.player_id
          JOIN event_guest g ON g.event_id = n.event_id
            AND ((g.kind = 'phone' AND g.value = pc.phone_e164) OR (g.kind = 'email' AND g.value = pc.email))
          WHERE n.id = member AND g.tag IS NOT NULL
            AND lower(g.tag) IN (SELECT lower(v) FROM unnest(rule_values) v)))
$$;
REVOKE ALL ON FUNCTION in_audience(uuid, text, uuid, text[]) FROM PUBLIC;

-- As 0028, plus each field's options (null for a free-text field).
CREATE OR REPLACE FUNCTION event_join_fields_json(target uuid) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'kind', f.kind, 'labelAr', f.label_ar,
                                               'labelEn', f.label_en, 'required', f.required,
                                               'options', f.options)
                            ORDER BY f.position, f.id), '[]'::jsonb)
  FROM event_join_field f WHERE f.event_id = target
$$;

-- As 0028, plus: a choice field's answer is one of its option ids (ADR-171).
CREATE OR REPLACE FUNCTION check_join_answers(target uuid, answers jsonb) RETURNS void
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  item record;
  missing uuid;
BEGIN
  IF jsonb_typeof(answers) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'join answers must be an object' USING ERRCODE = 'JA422', DETAIL = 'shape';
  END IF;
  FOR item IN SELECT a.key, a.value FROM jsonb_each(answers) a LOOP
    IF NOT EXISTS (SELECT 1 FROM event_join_field f WHERE f.event_id = target AND f.id::text = item.key)
       OR jsonb_typeof(item.value) <> 'string'
       OR length(item.value #>> '{}') NOT BETWEEN 1 AND 200
       OR item.value #>> '{}' <> btrim(item.value #>> '{}')
       OR item.value #>> '{}' ~ '[[:cntrl:]]'
       OR EXISTS (SELECT 1 FROM event_join_field f
                  WHERE f.event_id = target AND f.id::text = item.key AND f.options IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(f.options) o
                                    WHERE o ->> 'id' = item.value #>> '{}')) THEN
      RAISE EXCEPTION 'a join answer is not valid' USING ERRCODE = 'JA422', DETAIL = 'field:' || item.key;
    END IF;
  END LOOP;
  SELECT f.id INTO missing FROM event_join_field f
  WHERE f.event_id = target AND f.required AND NOT answers ? f.id::text
  ORDER BY f.position, f.id LIMIT 1;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'a required join answer is missing' USING ERRCODE = 'JA422', DETAIL = 'field:' || missing;
  END IF;
END $$;

-- As 0036, except that a returning player keeps the answers they gave before and only adds missing ones, so
-- leaving and rejoining cannot move them into another audience (T-220 review).
CREATE OR REPLACE FUNCTION join_write(target event, me uuid, row_found enrollment, joined_status text, on_list boolean, via text,
                           card text, answers jsonb)
  RETURNS TABLE (outcome text, enrollment_id uuid, event_id uuid, status text, welcome integer, waitlisted boolean)
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  made uuid;
  existing enrollment;
  had_welcome boolean := false;
  granted integer;
BEGIN
  IF row_found.id IS NULL THEN
    INSERT INTO enrollment AS en (organizer_id, event_id, player_id, status, card_version, joined_via, waitlisted)
    VALUES (target.organizer_id, target.id, me, joined_status, card, via, on_list)
    ON CONFLICT ON CONSTRAINT enrollment_event_id_player_id_key DO NOTHING
    RETURNING en.id INTO made;
    IF made IS NULL THEN
      SELECT en.* INTO existing FROM enrollment en WHERE en.event_id = target.id AND en.player_id = me;
      IF existing.joined_via = 'rehearsal' THEN
        RETURN QUERY SELECT 'rehearsing'::text, NULL::uuid, target.id, NULL::text, 0, false;
        RETURN;
      END IF;
      RETURN QUERY SELECT 'already'::text, existing.id, target.id, existing.status, 0, existing.waitlisted;
      RETURN;
    END IF;
  ELSE
    had_welcome := EXISTS (SELECT 1 FROM ledger_entry l WHERE l.enrollment_id = row_found.id AND l.kind = 'welcome');
    UPDATE enrollment en SET status = joined_status, waitlisted = on_list, card_version = card, joined_via = via,
                             joined_at = now()
    WHERE en.id = row_found.id;
    made := row_found.id;
  END IF;
  INSERT INTO join_answer (enrollment_id, field_id, organizer_id, event_id, value)
  SELECT made, a.key::uuid, target.organizer_id, target.id, a.value #>> '{}'
  FROM jsonb_each(coalesce(answers, '{}'::jsonb)) a
  ON CONFLICT ON CONSTRAINT join_answer_pkey DO NOTHING;
  granted := 0;
  IF NOT had_welcome THEN
    SELECT l.score_delta::integer INTO granted FROM ledger_entry l WHERE l.enrollment_id = made AND l.kind = 'welcome';
  END IF;
  RETURN QUERY SELECT 'joined'::text, made, target.id, joined_status, coalesce(granted, 0), on_list;
END $$;

-- As 0026, without the categories the member is outside the audience of.
CREATE OR REPLACE FUNCTION member_event_quests(target uuid)
  RETURNS TABLE (category_id uuid, category_name_ar text, category_name_en text, category_position integer,
                 quest_id uuid, title_ar text, title_en text, description_ar text, description_en text,
                 type text, points integer, repeat_cap integer, opens_at timestamptz, closes_at timestamptz,
                 quest_position integer, done integer, earned bigint, verification text[])
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH me AS (
    SELECT n.id FROM enrollment n JOIN player p ON p.id = n.player_id
    WHERE n.event_id = target AND n.player_id = app_player_id() AND n.status = 'active' AND p.status = 'active'
  )
  SELECT c.id, c.name_ar, c.name_en, c.position, q.id, q.title_ar, q.title_en, q.description_ar, q.description_en,
         q.type, q.points, q.repeat_cap, q.opens_at, q.closes_at, q.position,
         (SELECT count(*)::int FROM quest_completion qc WHERE qc.enrollment_id = me.id AND qc.quest_id = q.id),
         (SELECT coalesce(sum(l.score_delta), 0)::bigint FROM ledger_entry l
          WHERE l.enrollment_id = me.id AND l.quest_id = q.id),
         q.verification
  FROM me
  JOIN category c ON c.event_id = target
    AND in_audience(me.id, c.audience_kind, c.audience_field_id, c.audience_values)
  JOIN quest q ON q.category_id = c.id AND q.event_id = target AND q.visible
  ORDER BY c.position, c.id, q.position, q.id
$$;

-- As 0018, without targeted categories (no one is signed in to match them).
CREATE OR REPLACE FUNCTION public_event_quests(code text)
  RETURNS TABLE (category_id uuid, category_name_ar text, category_name_en text, category_position integer,
                 quest_id uuid, title_ar text, title_en text, description_ar text, description_en text,
                 type text, points integer, opens_at timestamptz, closes_at timestamptz, quest_position integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.id, c.name_ar, c.name_en, c.position, q.id, q.title_ar, q.title_en, q.description_ar, q.description_en,
         q.type, q.points, q.opens_at, q.closes_at, q.position
  FROM event e
  JOIN category c ON c.event_id = e.id AND c.audience_kind IS NULL
  JOIN quest q ON q.category_id = c.id AND q.event_id = e.id AND q.visible
  WHERE lower(e.join_code) = lower(code) AND e.status NOT IN ('draft', 'archived') AND e.access <> 'private'
  ORDER BY c.position, c.id, q.position, q.id
$$;

-- As 0029, without the rewards the member is outside the audience of.
CREATE OR REPLACE FUNCTION shop_rewards(target uuid)
  RETURNS TABLE (id uuid, kind text, name_ar text, name_en text, description_ar text, description_en text,
                 price integer, stock_left integer, per_player_limit integer, opens_at timestamptz,
                 closes_at timestamptz, section text, tag_new boolean, tag_limited boolean, popular boolean,
                 held_by_me integer)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  popular_floor CONSTANT integer := 3;
  popular_count CONSTANT integer := 3;
  mine          uuid;
BEGIN
  SELECT n.id INTO mine FROM enrollment n JOIN player p ON p.id = n.player_id
  WHERE n.event_id = target AND n.player_id = app_player_id() AND n.status = 'active' AND p.status = 'active';
  IF mine IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY
  WITH taken AS (
    SELECT d.reward_id FROM redemption d
    WHERE d.event_id = target AND d.status NOT IN ('cancelled', 'expired')
    GROUP BY d.reward_id HAVING count(*) >= popular_floor
    ORDER BY count(*) DESC, d.reward_id LIMIT popular_count
  )
  SELECT r.id, r.kind, r.name_ar, r.name_en, r.description_ar, r.description_en, r.price,
         r.stock_total - r.units_out, r.per_player_limit, r.opens_at, r.closes_at, r.section, r.tag_new,
         r.tag_limited, EXISTS (SELECT 1 FROM taken t WHERE t.reward_id = r.id),
         (SELECT count(*)::integer FROM redemption d
          WHERE d.enrollment_id = mine AND d.reward_id = r.id AND d.status NOT IN ('cancelled', 'expired'))
  FROM reward r
  WHERE r.event_id = target AND r.status = 'active'
    AND in_audience(mine, r.audience_kind, r.audience_field_id, r.audience_values)
  ORDER BY r.position, r.id;
END $$;

-- As 0033; a reward outside the member's audience is not in their shop, so it cannot be pinned.
CREATE OR REPLACE FUNCTION set_goal(target_event uuid, target_reward uuid) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  mine uuid;
BEGIN
  IF target_reward IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM reward r JOIN enrollment n ON n.event_id = r.event_id AND n.player_id = app_player_id()
       WHERE r.id = target_reward AND r.event_id = target_event AND r.status = 'active'
         AND in_audience(n.id, r.audience_kind, r.audience_field_id, r.audience_values)) THEN
    RAISE EXCEPTION 'no such reward in this event' USING ERRCODE = 'RN404';
  END IF;
  UPDATE enrollment n SET goal_reward_id = target_reward
  FROM player p
  WHERE p.id = n.player_id AND n.event_id = target_event AND n.player_id = app_player_id() AND n.status = 'active'
    AND p.status = 'active'
  RETURNING n.id INTO mine;
  IF mine IS NULL THEN
    RAISE EXCEPTION 'not a member of this event' USING ERRCODE = 'RN404';
  END IF;
  RETURN target_reward;
END $$;

-- As 0032, plus: a quest of a category the member is outside the audience of is not open to them (QN403
-- not_for_you), whoever records it (the player, an operator's My QR scan, the team's quest award).
CREATE OR REPLACE FUNCTION record_completion(target uuid, who uuid, proof_method text, proof_version integer,
                                             typed_code text, request_key text, device uuid, operator uuid,
                                             staff uuid, reason text, expected_event uuid)
  RETURNS TABLE (completion_id bigint, points bigint, occurrence integer, score bigint, balance bigint,
                 replayed boolean)
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  quest_row     quest%ROWTYPE;
  group_row     category%ROWTYPE;
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
  SELECT * INTO group_row FROM category c WHERE c.id = quest_row.category_id;
  IF NOT in_audience(enrolled.id, group_row.audience_kind, group_row.audience_field_id,
                     group_row.audience_values) THEN
    RAISE EXCEPTION 'quest not open' USING ERRCODE = 'QN403', DETAIL = 'not_for_you';
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

-- As 0034, plus: a reward outside the member's audience does not exist for them (RN404). A replay still answers.
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
    IF earlier.reward_id IS DISTINCT FROM target THEN
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
  IF item.status <> 'active'
     OR NOT in_audience(enrolled.id, item.audience_kind, item.audience_field_id, item.audience_values) THEN
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

-- ================================================================ setting a rule (ADR-170, review 5)
-- The owner or an editor in scope sets or clears the rule of a category or a reward of the event. The event row is
-- taken FOR NO KEY UPDATE, the lock the join field save takes, so the options checked here cannot change before the
-- commit. Outcomes: changed, unchanged, not_found, archived, invalid (a field without options, an option or a tag that
-- is not valid, no values, more than 20). Audited with ids and counts only, never a tag.
CREATE FUNCTION set_audience(target_event uuid, item_kind text, item uuid, rule_kind text, rule_field uuid,
                             rule_values text[], request uuid)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event;
  field event_join_field;
  wanted text[];
  before_kind text;
  before_field uuid;
  before_values text[];
BEGIN
  IF item_kind IS NULL OR item_kind NOT IN ('category', 'reward') THEN
    RAISE EXCEPTION 'item_kind must be category or reward' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT e.* INTO ev FROM event e
  WHERE e.id = target_event AND e.organizer_id = app_organizer_id() AND in_event_scope(e.id, app_event_scope())
  FOR NO KEY UPDATE;
  IF ev.id IS NULL THEN
    RETURN 'not_found';
  END IF;
  IF item_kind = 'category' THEN
    SELECT c.audience_kind, c.audience_field_id, c.audience_values INTO before_kind, before_field, before_values
    FROM category c WHERE c.id = item AND c.event_id = ev.id FOR UPDATE;
  ELSE
    SELECT r.audience_kind, r.audience_field_id, r.audience_values INTO before_kind, before_field, before_values
    FROM reward r WHERE r.id = item AND r.event_id = ev.id FOR UPDATE;
  END IF;
  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;
  IF ev.status = 'archived' THEN
    RETURN 'archived';
  END IF;
  IF rule_kind IS NULL THEN
    IF rule_field IS NOT NULL OR rule_values IS NOT NULL THEN
      RETURN 'invalid';
    END IF;
  ELSIF rule_kind = 'answer' THEN
    SELECT f.* INTO field FROM event_join_field f WHERE f.id = rule_field AND f.event_id = ev.id;
    IF field.options IS NULL THEN
      RETURN 'invalid';
    END IF;
    SELECT array_agg(DISTINCT v ORDER BY v) INTO wanted FROM unnest(rule_values) v;
    IF coalesce(cardinality(wanted), 0) NOT BETWEEN 1 AND 20 OR EXISTS (
         SELECT 1 FROM unnest(wanted) v
         WHERE NOT field.options @> jsonb_build_array(jsonb_build_object('id', v))) THEN
      RETURN 'invalid';
    END IF;
  ELSIF rule_kind = 'tag' THEN
    SELECT array_agg(DISTINCT lower(v) ORDER BY lower(v)) INTO wanted FROM unnest(rule_values) v;
    IF rule_field IS NOT NULL OR coalesce(cardinality(wanted), 0) NOT BETWEEN 1 AND 20 OR EXISTS (
         SELECT 1 FROM unnest(wanted) v
         WHERE v IS NULL OR length(v) NOT BETWEEN 1 AND 30 OR v <> btrim(v) OR v ~ '[[:cntrl:]]') THEN
      RETURN 'invalid';
    END IF;
  ELSE
    RETURN 'invalid';
  END IF;
  IF before_kind IS NOT DISTINCT FROM rule_kind AND before_field IS NOT DISTINCT FROM rule_field
     AND before_values IS NOT DISTINCT FROM wanted THEN
    RETURN 'unchanged';
  END IF;
  IF item_kind = 'category' THEN
    UPDATE category SET audience_kind = rule_kind, audience_field_id = rule_field, audience_values = wanted
    WHERE id = item;
  ELSE
    UPDATE reward SET audience_kind = rule_kind, audience_field_id = rule_field, audience_values = wanted
    WHERE id = item;
  END IF;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before, after,
                         request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, item_kind || '.audience', item_kind, item::text,
          jsonb_build_object('kind', before_kind, 'fieldId', before_field, 'values', cardinality(before_values)),
          jsonb_build_object('kind', rule_kind, 'fieldId', rule_field, 'values', cardinality(wanted)), request);
  RETURN 'changed';
END $$;
REVOKE ALL ON FUNCTION set_audience(uuid, text, uuid, text, uuid, text[], uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_audience(uuid, text, uuid, text, uuid, text[], uuid) TO questify_app;

-- How many of the event's members (active, not rehearsal) each targeted category and reward reaches now, for its
-- owner and editors in scope. Counts only: who matches stays in the database.
CREATE FUNCTION audience_counts(target uuid)
  RETURNS TABLE (item_kind text, item_id uuid, members integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH ev AS (
    SELECT e.id FROM event e
    WHERE e.id = target AND e.organizer_id = app_organizer_id() AND in_event_scope(e.id, app_event_scope())
  ), rules AS (
    SELECT 'category'::text AS kind, c.id, c.audience_kind, c.audience_field_id, c.audience_values
    FROM category c JOIN ev ON c.event_id = ev.id WHERE c.audience_kind IS NOT NULL
    UNION ALL
    SELECT 'reward', r.id, r.audience_kind, r.audience_field_id, r.audience_values
    FROM reward r JOIN ev ON r.event_id = ev.id WHERE r.audience_kind IS NOT NULL
  )
  SELECT rules.kind, rules.id,
         (SELECT count(*)::integer FROM enrollment n
          WHERE n.event_id = target AND n.status = 'active' AND n.joined_via IS DISTINCT FROM 'rehearsal'
            AND in_audience(n.id, rules.audience_kind, rules.audience_field_id, rules.audience_values))
  FROM rules
$$;
REVOKE ALL ON FUNCTION audience_counts(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION audience_counts(uuid) TO questify_app;
