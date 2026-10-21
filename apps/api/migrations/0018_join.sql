-- Joining an event (T-111): players join only through join_event, which checks the code, the event's state, its join
-- methods and its access type (ADR-024, ADR-105). Until now the enrollment policy let a signed-in player insert an
-- active enrollment for any event id, private ones included, and an organizer enroll any player in their own event
-- (and so read that player's row): both branches are dropped. Anonymous people browse public events and their quests
-- through definers that return named columns only (never a quest's type_config: an enter_code answer lives there).

-- ================================================================ no direct enrollment by the API's role
-- There is one role, questify_app, so the policy is what separates seats: only the platform admin may insert directly.
-- Players join through join_event below; organizers invite through their own definers when T-204 and T-218 add them.
DROP POLICY enrollment_insert ON enrollment;
CREATE POLICY enrollment_insert ON enrollment FOR INSERT TO questify_app
  WITH CHECK (app_is_admin());

-- What the player saw on the join card (FR-121) and how they came; NULL for enrollments made before this.
ALTER TABLE enrollment
  ADD COLUMN card_version text CHECK (card_version ~ '^[0-9]+(\.[0-9]+){0,2}$'),
  ADD COLUMN joined_via text CHECK (joined_via IN ('code', 'qr', 'link', 'public_list'));

-- ================================================================ joining
-- Outcomes: joined (a new or returning member), already (an active or pending member), not_found (an unknown code, a
-- draft or archived event: one answer, so a code tells nothing more), ended, method_off (the event turned that way of
-- joining off), not_allowed (removed or banned). Public and unlisted events make an active member; a private event a
-- pending one, for the owner to approve (ADR-105, T-218). The card's version is checked by the API (what is in force
-- lives in packages/shared); the database checks its form. The row is locked before the decision, so a rejoin cannot
-- race a ban, and two first joins at once make one row.
CREATE FUNCTION join_event(code text, via text, card text)
  RETURNS TABLE (outcome text, enrollment_id uuid, event_id uuid, status text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me uuid;
  target event;
  now_status text;
  row_found enrollment;
  joined_status text;
BEGIN
  SELECT p.id INTO me FROM player p WHERE p.id = app_player_id() AND p.status = 'active';
  IF me IS NULL THEN
    RAISE EXCEPTION 'not an active player' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF via IS NULL OR via NOT IN ('code', 'qr', 'link', 'public_list') THEN
    RAISE EXCEPTION 'unknown way of joining' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- No member without the card they accepted (ADR-089); its form is the column's CHECK.
  IF card IS NULL THEN
    RAISE EXCEPTION 'the join card version is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT e.* INTO target FROM event e WHERE lower(e.join_code) = lower(code) AND e.status NOT IN ('draft', 'archived');
  IF target.id IS NULL THEN
    RETURN QUERY SELECT 'not_found'::text, NULL::uuid, NULL::uuid, NULL::text;
    RETURN;
  END IF;
  -- The event's own state is checked before the player's membership: a removed player of an ended event hears
  -- "ended", which tells them nothing they could not see on the card.
  now_status := event_status_now(target.status, target.starts_at, target.ends_at);
  IF now_status NOT IN ('scheduled', 'live') THEN
    RETURN QUERY SELECT 'ended'::text, NULL::uuid, target.id, NULL::text;
    RETURN;
  END IF;
  IF NOT (via = ANY (target.join_methods)) THEN
    RETURN QUERY SELECT 'method_off'::text, NULL::uuid, target.id, NULL::text;
    RETURN;
  END IF;
  joined_status := CASE WHEN target.access = 'private' THEN 'pending' ELSE 'active' END;

  INSERT INTO enrollment AS en (organizer_id, event_id, player_id, status, card_version, joined_via)
  VALUES (target.organizer_id, target.id, me, joined_status, card, via)
  ON CONFLICT ON CONSTRAINT enrollment_event_id_player_id_key DO NOTHING
  RETURNING en.* INTO row_found;
  IF row_found.id IS NOT NULL THEN
    RETURN QUERY SELECT 'joined'::text, row_found.id, target.id, row_found.status;
    RETURN;
  END IF;

  SELECT en.* INTO row_found FROM enrollment en WHERE en.event_id = target.id AND en.player_id = me FOR UPDATE;
  IF row_found.status IN ('active', 'pending') THEN
    RETURN QUERY SELECT 'already'::text, row_found.id, target.id, row_found.status;
  ELSIF row_found.status = 'left' THEN
    -- A player who left may come back (T-208 narrows this); the card accepted last is the consent in force.
    UPDATE enrollment en SET status = joined_status, card_version = card, joined_via = via, joined_at = now()
    WHERE en.id = row_found.id;
    RETURN QUERY SELECT 'joined'::text, row_found.id, target.id, joined_status;
  ELSE
    RETURN QUERY SELECT 'not_allowed'::text, NULL::uuid, target.id, NULL::text;
  END IF;
END $$;
REVOKE ALL ON FUNCTION join_event(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION join_event(text, text, text) TO questify_app;

-- ================================================================ browsing before sign-in (FR-104, FR-111)
-- The public list: public events that list themselves, scheduled or live now, soonest first, by a keyset over
-- (starts_at, id); a scheduled or live event always has its times (event_times_once_active). The cursor is the last
-- event's id: its start time is read here, at full precision; an id that names no event starts from the first page
-- rather than answering an empty one. Never unlisted or private events.
CREATE FUNCTION public_events(after_id uuid, page integer)
  RETURNS TABLE (id uuid, join_code text, name_ar text, name_en text, venue_ar text, venue_en text, kind text,
                 timezone text, starts_at timestamptz, ends_at timestamptz, status_now text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT e.id, e.join_code, e.name_ar, e.name_en, e.venue_ar, e.venue_en, e.kind, e.timezone, e.starts_at, e.ends_at,
         event_status_now(e.status, e.starts_at, e.ends_at)
  FROM event e
  WHERE e.access = 'public' AND 'public_list' = ANY (e.join_methods)
    AND event_status_now(e.status, e.starts_at, e.ends_at) IN ('scheduled', 'live')
    AND (after_id IS NULL
         OR NOT EXISTS (SELECT 1 FROM event c WHERE c.id = after_id)
         OR (e.starts_at, e.id) > (SELECT c.starts_at, c.id FROM event c WHERE c.id = after_id))
  ORDER BY e.starts_at, e.id
  LIMIT least(greatest(page, 1), 100)
$$;
REVOKE ALL ON FUNCTION public_events(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_events(uuid, integer) TO questify_app;

-- One event by its code, for the join card: any access type (the code is the secret, FR-105), scheduled, live or
-- ended (the card says it has ended). Draft, archived and unknown codes return nothing.
CREATE FUNCTION public_event(code text)
  RETURNS TABLE (id uuid, join_code text, name_ar text, name_en text, venue_ar text, venue_en text, kind text,
                 timezone text, starts_at timestamptz, ends_at timestamptz, status_now text, access text,
                 join_methods text[])
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT e.id, e.join_code, e.name_ar, e.name_en, e.venue_ar, e.venue_en, e.kind, e.timezone, e.starts_at, e.ends_at,
         event_status_now(e.status, e.starts_at, e.ends_at), e.access, e.join_methods
  FROM event e
  WHERE lower(e.join_code) = lower(code) AND e.status NOT IN ('draft', 'archived')
$$;
REVOKE ALL ON FUNCTION public_event(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_event(text) TO questify_app;

-- An event's quests before sign-in: public and unlisted events only (a private event's quests need membership),
-- visible quests, named columns only. The API reads public_event first, so an unknown code is a 404, not an empty list.
CREATE FUNCTION public_event_quests(code text)
  RETURNS TABLE (category_id uuid, category_name_ar text, category_name_en text, category_position integer,
                 quest_id uuid, title_ar text, title_en text, description_ar text, description_en text,
                 type text, points integer, opens_at timestamptz, closes_at timestamptz, quest_position integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT c.id, c.name_ar, c.name_en, c.position, q.id, q.title_ar, q.title_en, q.description_ar, q.description_en,
         q.type, q.points, q.opens_at, q.closes_at, q.position
  FROM event e
  JOIN category c ON c.event_id = e.id
  JOIN quest q ON q.category_id = c.id AND q.event_id = e.id AND q.visible
  WHERE lower(e.join_code) = lower(code) AND e.status NOT IN ('draft', 'archived') AND e.access <> 'private'
  ORDER BY c.position, c.id, q.position, q.id
$$;
REVOKE ALL ON FUNCTION public_event_quests(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public_event_quests(text) TO questify_app;
