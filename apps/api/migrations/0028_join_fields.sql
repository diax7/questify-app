-- Join fields, the guest list, the email-domain lock and the welcome reward (T-212, ADR-145 to ADR-148). An event asks
-- up to five questions at the join (FR-129, FR-130); the answers are personal data and only that event's team and the
-- player themself read them (FR-131). A guest list of phones and emails invites people (FR-132, FR-133) and can be the
-- only way in (FR-134); email domains lock the join to verified company addresses (FR-135). Guests pass both locks and
-- skip a private event's approval (FR-1819). The welcome reward is a ledger entry, granted once per enrollment the first
-- time it becomes active, whoever makes it so (FR-136, FR-137).

-- ================================================================ the event's settings
-- Domains: the exclusion list's exact-domain shape (0019), at most 10, lower case, no NULLs. join_fields_version lets
-- the dashboard save the whole field list without overwriting a newer one (a stale save would delete answers).
ALTER TABLE event
  ADD COLUMN join_fields_version integer NOT NULL DEFAULT 0 CHECK (join_fields_version >= 0),
  ADD COLUMN guest_list_only boolean NOT NULL DEFAULT false,
  ADD COLUMN email_domains text[] NOT NULL DEFAULT '{}' CONSTRAINT event_email_domains_shape CHECK (
    cardinality(email_domains) <= 10
    AND array_position(email_domains, NULL) IS NULL
    AND length(array_to_string(email_domains, ' ')) <= 2600
    AND (cardinality(email_domains) = 0
         OR array_to_string(email_domains, ' ') ~
            '^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9-]{1,59})( ([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+([a-z]{2,63}|xn--[a-z0-9-]{1,59}))*$')),
  ADD COLUMN welcome_points integer CHECK (welcome_points BETWEEN 1 AND 100000);
GRANT UPDATE (join_fields_version, guest_list_only, email_domains, welcome_points) ON event TO questify_app;

-- Every member of an event gets the same welcome: the amount is fixed once anyone has joined or the event is live,
-- whichever comes first (a scheduled event takes joins). Joins read the event FOR SHARE, so a change and a first join
-- run one after the other, and this check sees a join that committed first. The owner connection is trusted.
CREATE FUNCTION event_welcome_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user <> 'questify_app' THEN
    RETURN NEW;
  END IF;
  IF event_status_now(OLD.status, OLD.starts_at, OLD.ends_at) IN ('live', 'ended', 'archived')
     OR EXISTS (SELECT 1 FROM enrollment n WHERE n.event_id = OLD.id) THEN
    RAISE EXCEPTION 'the welcome reward is fixed once players join or the event is live' USING ERRCODE = 'QE409';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION event_welcome_guard() FROM PUBLIC;
CREATE TRIGGER event_welcome_guard BEFORE UPDATE OF welcome_points ON event
  FOR EACH ROW WHEN (OLD.welcome_points IS DISTINCT FROM NEW.welcome_points)
  EXECUTE FUNCTION event_welcome_guard();

-- ================================================================ join fields (FR-129)
-- A custom field carries its own label; the others are the app's words. One of each kind but custom; at most five.
CREATE TABLE event_join_field (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id uuid NOT NULL,
  event_id     uuid NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('full_name', 'company', 'job_title', 'department', 'ticket_number', 'custom')),
  label_ar     text CHECK (length(label_ar) BETWEEN 1 AND 60),
  label_en     text CHECK (length(label_en) BETWEEN 1 AND 60),
  required     boolean NOT NULL DEFAULT false,
  position     smallint NOT NULL CHECK (position BETWEEN 0 AND 4),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, event_id),
  CHECK ((kind = 'custom') = (label_ar IS NOT NULL OR label_en IS NOT NULL)),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX event_join_field_kind_key ON event_join_field (event_id, kind) WHERE kind <> 'custom';
CREATE INDEX event_join_field_event_idx ON event_join_field (event_id, position, id);
CREATE TRIGGER event_join_field_organizer BEFORE INSERT ON event_join_field
  FOR EACH ROW EXECUTE FUNCTION set_organizer_from_event();

-- The caps hold whoever writes and however many rows one statement adds (the API also counts under the event lock).
CREATE FUNCTION event_join_field_cap() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM event_join_field f WHERE f.event_id IN (SELECT a.event_id FROM added a)
             GROUP BY f.event_id HAVING count(*) > 5) THEN
    RAISE EXCEPTION 'an event has at most 5 join fields' USING ERRCODE = 'QF409';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION event_join_field_cap() FROM PUBLIC;
CREATE TRIGGER event_join_field_cap AFTER INSERT ON event_join_field
  REFERENCING NEW TABLE AS added FOR EACH STATEMENT EXECUTE FUNCTION event_join_field_cap();

ALTER TABLE event_join_field ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_join_field FORCE ROW LEVEL SECURITY;
REVOKE ALL ON event_join_field FROM PUBLIC;
-- The team edits; the kind never changes (an answer given to "company" must not become a "full name"). Players read
-- fields through the definers below only.
GRANT SELECT, DELETE ON event_join_field TO questify_app;
GRANT INSERT (event_id, kind, label_ar, label_en, required, position) ON event_join_field TO questify_app;
GRANT UPDATE (label_ar, label_en, required, position) ON event_join_field TO questify_app;
CREATE POLICY event_join_field_team ON event_join_field FOR ALL TO questify_app
  USING ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope())) OR app_is_admin())
  WITH CHECK ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope())) OR app_is_admin());

-- ================================================================ join answers (FR-130, FR-131)
-- Personal data: written only by the join definers, read by the event's team, the player and the platform admin.
-- A deleted field takes its answers; so does a deleted enrollment.
CREATE TABLE join_answer (
  enrollment_id uuid NOT NULL,
  field_id      uuid NOT NULL,
  organizer_id  uuid NOT NULL,
  event_id      uuid NOT NULL,
  value         text NOT NULL CHECK (length(value) BETWEEN 1 AND 200 AND value = btrim(value) AND value !~ '[[:cntrl:]]'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (enrollment_id, field_id),
  FOREIGN KEY (enrollment_id, event_id) REFERENCES enrollment (id, event_id) ON DELETE CASCADE,
  FOREIGN KEY (field_id, event_id) REFERENCES event_join_field (id, event_id) ON DELETE CASCADE,
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE CASCADE
);
CREATE INDEX join_answer_field_idx ON join_answer (field_id);
CREATE INDEX join_answer_event_idx ON join_answer (event_id);
ALTER TABLE join_answer ENABLE ROW LEVEL SECURITY;
ALTER TABLE join_answer FORCE ROW LEVEL SECURITY;
REVOKE ALL ON join_answer FROM PUBLIC;
GRANT SELECT ON join_answer TO questify_app;
CREATE POLICY join_answer_read ON join_answer FOR SELECT TO questify_app
  USING ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope()))
         OR app_is_admin()
         OR enrollment_id IN (SELECT n.id FROM enrollment n WHERE n.player_id = app_player_id()));

-- ================================================================ the guest list (FR-132)
-- Phones are the Saudi mobiles sign-in takes; emails lower case. At most 10 000 an event. Who added an entry is the
-- staff user of the request (the audit entry keeps only counts: a contact is personal data).
CREATE TABLE event_guest (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id uuid NOT NULL,
  event_id     uuid NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('phone', 'email')),
  value        text NOT NULL,
  created_by   uuid DEFAULT app_staff_user_id() REFERENCES staff_user (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (event_id, kind, value),
  CHECK (kind <> 'phone' OR value ~ '^\+9665[0-9]{8}$'),
  CHECK (kind <> 'email' OR (value = lower(value) AND length(value) <= 254 AND value ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE CASCADE
);
-- Invitations are found from the player's contact: by kind and value first.
CREATE INDEX event_guest_contact_idx ON event_guest (kind, value);
CREATE INDEX event_guest_event_idx ON event_guest (event_id, created_at, id);
CREATE TRIGGER event_guest_organizer BEFORE INSERT ON event_guest
  FOR EACH ROW EXECUTE FUNCTION set_organizer_from_event();

CREATE FUNCTION event_guest_cap() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM event_guest g WHERE g.event_id IN (SELECT a.event_id FROM added a)
             GROUP BY g.event_id HAVING count(*) > 10000) THEN
    RAISE EXCEPTION 'an event''s guest list holds at most 10000 entries' USING ERRCODE = 'QG409';
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION event_guest_cap() FROM PUBLIC;
CREATE TRIGGER event_guest_cap AFTER INSERT ON event_guest
  REFERENCING NEW TABLE AS added FOR EACH STATEMENT EXECUTE FUNCTION event_guest_cap();

ALTER TABLE event_guest ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_guest FORCE ROW LEVEL SECURITY;
REVOKE ALL ON event_guest FROM PUBLIC;
GRANT SELECT, DELETE ON event_guest TO questify_app;
GRANT INSERT (event_id, kind, value) ON event_guest TO questify_app;
CREATE POLICY event_guest_team ON event_guest FOR ALL TO questify_app
  USING ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope())) OR app_is_admin())
  WITH CHECK ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope())) OR app_is_admin());

-- Whether one of the player's verified identifiers (ADR-075) is on the event's guest list. Called by definers only.
CREATE FUNCTION player_invited(target_event uuid, target_player uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM player_contact pc JOIN event_guest g ON g.event_id = target_event
    WHERE pc.player_id = target_player
      AND ((g.kind = 'phone' AND g.value = pc.phone_e164) OR (g.kind = 'email' AND g.value = pc.email)))
$$;
REVOKE ALL ON FUNCTION player_invited(uuid, uuid) FROM PUBLIC;

-- ================================================================ the welcome reward in the ledger (FR-136, FR-137)
ALTER TABLE ledger_entry DROP CONSTRAINT ledger_entry_kind_check;
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_kind_check
  CHECK (kind IN ('quest', 'redeem', 'redeem_return', 'welcome'));
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_welcome_shape
  CHECK (kind <> 'welcome' OR (score_delta > 0 AND score_delta = balance_delta AND completion_id IS NULL
                               AND quest_id IS NULL AND redemption_id IS NULL AND actor = 'system'));
ALTER TABLE ledger_entry DROP CONSTRAINT ledger_entry_system_returns_only;
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_system_returns_only
  CHECK (actor <> 'system' OR kind IN ('redeem_return', 'welcome'));
-- One welcome per enrollment, whatever path makes it active, as often as it does.
CREATE UNIQUE INDEX ledger_entry_welcome_key ON ledger_entry (enrollment_id) WHERE kind = 'welcome';

-- Grants the welcome when an enrollment becomes active: a join, an invited join, the owner's approval (T-218) or a
-- lifted ban. The amount is the event's at that moment; a repeat does nothing. The ranking copy is marked here.
CREATE FUNCTION grant_welcome() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  amount integer;
  made bigint;
BEGIN
  IF NEW.status <> 'active' OR (TG_OP = 'UPDATE' AND OLD.status = 'active') THEN
    RETURN NULL;
  END IF;
  SELECT e.welcome_points INTO amount FROM event e WHERE e.id = NEW.event_id;
  IF amount IS NULL THEN
    RETURN NULL;
  END IF;
  INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor)
  VALUES (NEW.organizer_id, NEW.event_id, NEW.id, 'welcome', amount, amount, 'system')
  ON CONFLICT (enrollment_id) WHERE kind = 'welcome' DO NOTHING
  RETURNING id INTO made;
  IF made IS NOT NULL THEN
    INSERT INTO ranking_repair (event_id) VALUES (NEW.event_id)
    ON CONFLICT (event_id) DO UPDATE SET marked_at = now();
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION grant_welcome() FROM PUBLIC;
CREATE TRIGGER enrollment_welcome AFTER INSERT OR UPDATE OF status ON enrollment
  FOR EACH ROW EXECUTE FUNCTION grant_welcome();

-- ================================================================ joining, with answers and the locks
ALTER TABLE enrollment DROP CONSTRAINT enrollment_joined_via_check;
ALTER TABLE enrollment ADD CONSTRAINT enrollment_joined_via_check
  CHECK (joined_via IN ('code', 'qr', 'link', 'public_list', 'operator', 'invite'));

-- The event's fields as the card shows them, in order.
CREATE FUNCTION event_join_fields_json(target uuid) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('id', f.id, 'kind', f.kind, 'labelAr', f.label_ar,
                                               'labelEn', f.label_en, 'required', f.required)
                            ORDER BY f.position, f.id), '[]'::jsonb)
  FROM event_join_field f WHERE f.event_id = target
$$;
REVOKE ALL ON FUNCTION event_join_fields_json(uuid) FROM PUBLIC;

-- Checks the answers against the event's fields: an object of field id to text, trimmed, 1 to 200 characters, no
-- control characters; every required field answered; an optional one left out rather than blank. A key that is not
-- one of this event's fields is refused. JA422 with DETAIL `shape` or `field:<id>`.
CREATE FUNCTION check_join_answers(target uuid, answers jsonb) RETURNS void
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
       OR item.value #>> '{}' ~ '[[:cntrl:]]' THEN
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
REVOKE ALL ON FUNCTION check_join_answers(uuid, jsonb) FROM PUBLIC;

-- The decision both ways of joining share. The caller has found the event and holds it FOR SHARE. Outcomes as in 0018
-- plus invite_only (FR-134) and domain_required (FR-135); `welcome` is the points this join granted (0 when none).
-- Order: the event's state, the way in (an invitation is its own way, so join methods do not apply to it), the
-- player's membership (a member is never refused by a lock added later; banned and removed stay out), the locks
-- (a guest passes both), the answers. A guest joins active even in a private event (FR-1819).
CREATE FUNCTION join_core(target event, me uuid, via text, card text, answers jsonb)
  RETURNS TABLE (outcome text, enrollment_id uuid, event_id uuid, status text, welcome integer)
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  row_found enrollment;
  invited boolean;
  joined_status text;
  made uuid;
  had_welcome boolean := false;
  granted integer;
BEGIN
  IF event_status_now(target.status, target.starts_at, target.ends_at) NOT IN ('scheduled', 'live') THEN
    RETURN QUERY SELECT 'ended'::text, NULL::uuid, target.id, NULL::text, 0;
    RETURN;
  END IF;
  IF via <> 'invite' AND NOT (via = ANY (target.join_methods)) THEN
    RETURN QUERY SELECT 'method_off'::text, NULL::uuid, target.id, NULL::text, 0;
    RETURN;
  END IF;
  SELECT en.* INTO row_found FROM enrollment en WHERE en.event_id = target.id AND en.player_id = me FOR UPDATE;
  -- A pending requester the organizer has since put on the guest list goes on in without approval (FR-1819).
  IF row_found.status = 'active' OR (row_found.status = 'pending' AND NOT player_invited(target.id, me)) THEN
    RETURN QUERY SELECT 'already'::text, row_found.id, target.id, row_found.status, 0;
    RETURN;
  END IF;
  IF row_found.status IN ('banned', 'removed') THEN
    RETURN QUERY SELECT 'not_allowed'::text, NULL::uuid, target.id, NULL::text, 0;
    RETURN;
  END IF;
  invited := player_invited(target.id, me);
  IF target.guest_list_only AND NOT invited THEN
    RETURN QUERY SELECT 'invite_only'::text, NULL::uuid, target.id, NULL::text, 0;
    RETURN;
  END IF;
  IF cardinality(target.email_domains) > 0 AND NOT invited AND NOT EXISTS (
       SELECT 1 FROM player_contact pc
       WHERE pc.player_id = me AND split_part(pc.email, '@', 2) = ANY (target.email_domains)) THEN
    RETURN QUERY SELECT 'domain_required'::text, NULL::uuid, target.id, NULL::text, 0;
    RETURN;
  END IF;
  PERFORM check_join_answers(target.id, coalesce(answers, '{}'::jsonb));
  joined_status := CASE WHEN target.access = 'private' AND NOT invited THEN 'pending' ELSE 'active' END;

  IF row_found.id IS NULL THEN
    INSERT INTO enrollment AS en (organizer_id, event_id, player_id, status, card_version, joined_via)
    VALUES (target.organizer_id, target.id, me, joined_status, card, via)
    ON CONFLICT ON CONSTRAINT enrollment_event_id_player_id_key DO NOTHING
    RETURNING en.id INTO made;
    IF made IS NULL THEN
      -- A first join of the same player committed meanwhile: that one stands.
      SELECT en.* INTO row_found FROM enrollment en WHERE en.event_id = target.id AND en.player_id = me;
      RETURN QUERY SELECT 'already'::text, row_found.id, target.id, row_found.status, 0;
      RETURN;
    END IF;
  ELSE
    -- A player who left comes back; the card and answers given now are the consent in force.
    had_welcome := EXISTS (SELECT 1 FROM ledger_entry l WHERE l.enrollment_id = row_found.id AND l.kind = 'welcome');
    UPDATE enrollment en SET status = joined_status, card_version = card, joined_via = via, joined_at = now()
    WHERE en.id = row_found.id;
    made := row_found.id;
    DELETE FROM join_answer a WHERE a.enrollment_id = made;
  END IF;
  INSERT INTO join_answer (enrollment_id, field_id, organizer_id, event_id, value)
  SELECT made, a.key::uuid, target.organizer_id, target.id, a.value #>> '{}'
  FROM jsonb_each(coalesce(answers, '{}'::jsonb)) a;

  granted := 0;
  IF NOT had_welcome THEN
    SELECT l.score_delta::integer INTO granted FROM ledger_entry l WHERE l.enrollment_id = made AND l.kind = 'welcome';
  END IF;
  RETURN QUERY SELECT 'joined'::text, made, target.id, joined_status, coalesce(granted, 0);
END $$;
REVOKE ALL ON FUNCTION join_core(event, uuid, text, text, jsonb) FROM PUBLIC;

-- By code, QR, link or the public list (0018), now with the answers. The event row is read FOR SHARE: a change of
-- its welcome amount waits for the join, and the join sees the amount in force.
DROP FUNCTION join_event(text, text, text);
CREATE FUNCTION join_event(code text, via text, card text, answers jsonb DEFAULT '{}'::jsonb)
  RETURNS TABLE (outcome text, enrollment_id uuid, event_id uuid, status text, welcome integer)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me uuid;
  target event;
BEGIN
  SELECT p.id INTO me FROM player p WHERE p.id = app_player_id() AND p.status = 'active';
  IF me IS NULL THEN
    RAISE EXCEPTION 'not an active player' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF via IS NULL OR via NOT IN ('code', 'qr', 'link', 'public_list') THEN
    RAISE EXCEPTION 'unknown way of joining' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF card IS NULL THEN
    RAISE EXCEPTION 'the join card version is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT e.* INTO target FROM event e
  WHERE lower(e.join_code) = lower(code) AND e.status NOT IN ('draft', 'archived')
  FOR SHARE;
  IF target.id IS NULL THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::uuid, NULL::text, 0;
    RETURN;
  END IF;
  RETURN QUERY SELECT * FROM join_core(target, me, via, card, answers);
END $$;
REVOKE ALL ON FUNCTION join_event(text, text, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION join_event(text, text, text, jsonb) TO questify_app;

-- An invited person joins without a code (FR-133). An event that is not theirs to be invited to is not_found: one
-- answer, so an id tells nothing about events the caller is not on the list of.
CREATE FUNCTION join_invited(target uuid, card text, answers jsonb DEFAULT '{}'::jsonb)
  RETURNS TABLE (outcome text, enrollment_id uuid, event_id uuid, status text, welcome integer)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me uuid;
  found_event event;
BEGIN
  SELECT p.id INTO me FROM player p WHERE p.id = app_player_id() AND p.status = 'active';
  IF me IS NULL THEN
    RAISE EXCEPTION 'not an active player' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF card IS NULL THEN
    RAISE EXCEPTION 'the join card version is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT e.* INTO found_event FROM event e WHERE e.id = target AND e.status NOT IN ('draft', 'archived') FOR SHARE;
  IF found_event.id IS NULL OR NOT player_invited(found_event.id, me) THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::uuid, NULL::text, 0;
    RETURN;
  END IF;
  RETURN QUERY SELECT * FROM join_core(found_event, me, 'invite', card, answers);
END $$;
REVOKE ALL ON FUNCTION join_invited(uuid, text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION join_invited(uuid, text, jsonb) TO questify_app;

-- ================================================================ what the card and the invitations show
-- The join rules of an event by its code, for anyone holding the code (the card, FR-130): the fields, the locks and
-- the welcome amount. Never the guest list or anything counted from it.
CREATE FUNCTION public_event_join_rules(code text)
  RETURNS TABLE (guest_list_only boolean, email_domains text[], welcome_points integer, fields jsonb)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT e.guest_list_only, e.email_domains, e.welcome_points, event_join_fields_json(e.id)
  FROM event e
  WHERE lower(e.join_code) = lower(code) AND e.status NOT IN ('draft', 'archived')
$$;
REVOKE ALL ON FUNCTION public_event_join_rules(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_event_join_rules(text) TO questify_app;

-- The signed-in player's invitations (FR-133): scheduled or live events whose guest list holds one of their verified
-- identifiers and that they are not in (a player who left is invited again), soonest first, at most 20. No join code.
CREATE FUNCTION my_invitations()
  RETURNS TABLE (id uuid, name_ar text, name_en text, venue_ar text, venue_en text, kind text, timezone text,
                 starts_at timestamptz, ends_at timestamptz, status_now text, access text, email_domains text[],
                 welcome_points integer, fields jsonb)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH me AS (
    SELECT pc.phone_e164, pc.email, p.id FROM player p JOIN player_contact pc ON pc.player_id = p.id
    WHERE p.id = app_player_id() AND p.status = 'active'
  )
  SELECT e.id, e.name_ar, e.name_en, e.venue_ar, e.venue_en, e.kind, e.timezone, e.starts_at, e.ends_at,
         event_status_now(e.status, e.starts_at, e.ends_at), e.access, e.email_domains, e.welcome_points,
         event_join_fields_json(e.id)
  FROM me
  JOIN event e ON e.id IN (
    SELECT g.event_id FROM event_guest g
    WHERE (g.kind = 'phone' AND g.value = me.phone_e164) OR (g.kind = 'email' AND g.value = me.email))
  WHERE event_status_now(e.status, e.starts_at, e.ends_at) IN ('scheduled', 'live')
    AND NOT EXISTS (SELECT 1 FROM enrollment n WHERE n.event_id = e.id AND n.player_id = me.id
                    AND n.status NOT IN ('left', 'pending'))
  ORDER BY e.starts_at, e.id
  LIMIT 20
$$;
REVOKE ALL ON FUNCTION my_invitations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION my_invitations() TO questify_app;
