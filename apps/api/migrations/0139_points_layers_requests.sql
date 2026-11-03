-- Feature layers, part 2 (T-711b, FR-1826, FR-1827; plan docs/plans/2026-11-03-t-711b-points-layers.md; ADR-540 to ADR-546,
-- Q-500 to Q-503). A Questify admin's per-organizer override (0136) now also reaches `boosts`, `community`, `meetSomeone` and
-- `miniGames`, and an event's owner records an "Ask Questify" request for an add-on.
--
-- The override acts exactly where the platform switch acts (ADR-540): on new things, never on running ones. So `boosts_on`,
-- `community_on`, `boost_in_force`, `pay_completion` and `settle_goal_at` are untouched (no new work in a quest scan).
-- `games_on` and `meet_on` read `feature_enabled` (their doors are the "new" point; ADR-541). The community settle decides
-- "may start" per goal from the organizer's platform layer (ADR-542): `settle_goal(uuid)` and `settle_community(uuid, uuid)`
-- replace the versions that took a boolean, which are dropped (the old API's tick fails for the seconds of a deploy and the
-- next tick catches up; RUNBOOK). The boost-start push and notice wait for the layer too (plan review MAJOR 1): a boost
-- saved earlier still pays once its window opens, but nobody is told of a feature the app hides.
--
-- `feature_request`: ids, one add-on key, a status and times; no text, names or contact fields. The owner writes it only
-- through `request_feature`; an admin reads and closes it (Allow is the add-on unlock, Decline its own route) under the
-- admin policies; the organizer's members read their own organizer's rows. `requested_by` and `decided_by` are staff ids
-- with no foreign key (the audit log names them too).
--
-- Deny by default: forced row-level security, nothing for PUBLIC on the table or any new function, the one door granted to
-- questify_app. No lock is added to a payment (ADR-546). Migrations 0138 and earlier untouched.
SET LOCAL lock_timeout = '10s';
-- Lock order up front: the foreign-key targets of the new table (scans only take row locks on them), then the override table
-- for its CHECK (a few rows per organizer; readers queue for milliseconds).
LOCK TABLE event IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE organizer IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE organizer_feature_override IN ACCESS EXCLUSIVE MODE;

-- ================================================================ the four points-path features become overridable (ADR-544)
-- Equals `isOrganizerOverridable` over the registry (16 keys); `test/db/feature-layers.int.test.ts` compares the two.
ALTER TABLE organizer_feature_override
  DROP CONSTRAINT organizer_feature_override_feature_check,
  ADD CONSTRAINT organizer_feature_override_feature_check CHECK (feature IN (
    'agenda', 'bigScreen', 'boosts', 'cheers', 'community', 'flashQuests', 'helpDesk', 'maps', 'meetSomeone', 'miniGames',
    'polls', 'questRatings', 'ranking', 'rankingToday', 'shareQuests', 'shop'));

-- ================================================================ the doors of a round and a meet (ADR-541)
-- 0050's and 0049's rules with the platform part read through the organizer: the event's switch and the platform as its
-- organizer sees it. An unknown event stays true (the doors refuse it themselves, as before).
CREATE OR REPLACE FUNCTION games_on(target_event uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT feature_enabled(e, 'miniGames') FROM event e WHERE e.id = target_event), true)
$$;

CREATE OR REPLACE FUNCTION meet_on(target_event uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT feature_enabled(e, 'meetSomeone') FROM event e WHERE e.id = target_event), true)
$$;

-- ================================================================ the community settle decides "may start" itself (ADR-542)
DROP FUNCTION settle_goal(uuid, boolean);
DROP FUNCTION settle_community(uuid, boolean, uuid);

-- 0114's settle_goal; "may start" is the goal's organizer's platform layer, read once per call.
CREATE FUNCTION settle_goal(target_goal uuid) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  goal community_goal%ROWTYPE;
  ev   event%ROWTYPE;
BEGIN
  PERFORM community_system_only();
  PERFORM community_read_committed();
  IF EXISTS (SELECT 1 FROM community_goal g WHERE g.id = target_goal AND event_suspended(g.event_id)) THEN
    RETURN 'busy';
  END IF;
  PERFORM ensure_rehearsal_wiped(g.event_id) FROM community_goal g WHERE g.id = target_goal;
  SELECT g.* INTO goal FROM community_goal g WHERE g.id = target_goal AND g.final_at IS NULL FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
    RETURN 'busy';
  END IF;
  SELECT e.* INTO ev FROM event e WHERE e.id = goal.event_id;
  RETURN settle_goal_at(goal, ev, interval '30 seconds', platform_feature_on(ev.organizer_id, 'community'));
END $$;
REVOKE ALL ON FUNCTION settle_goal(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION settle_goal(uuid) TO questify_app;

-- 0053's settle_community; "may start" is the event's organizer's platform layer, read once before the loop.
CREATE FUNCTION settle_community(target_event uuid, request uuid) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev        event := award_event_of(target_event);
  goal      community_goal%ROWTYPE;
  before    timestamptz;
  settled   integer := 0;
  may_start boolean;
BEGIN
  IF NOT app_is_owner(ev.organizer_id) THEN
    RAISE EXCEPTION 'only the owner settles community goals' USING ERRCODE = 'CO403';
  END IF;
  PERFORM community_read_committed();
  PERFORM ensure_rehearsal_wiped(ev.id);
  SELECT e.* INTO ev FROM event e WHERE e.id = ev.id;
  may_start := platform_feature_on(ev.organizer_id, 'community');
  PERFORM set_config('lock_timeout', '2000', true);
  FOR goal IN SELECT g.* FROM community_goal g
              WHERE g.event_id = ev.id AND g.final_at IS NULL AND community_close_at(g.ends_at, ev.ends_at) <= now()
              ORDER BY g.id FOR UPDATE LOOP
    -- Each settle reads at most 10 minutes: settle again while the settle point moves, until the goal is final.
    LOOP
      before := goal.settled_until;
      PERFORM settle_goal_at(goal, ev, interval '0', may_start);
      SELECT g.* INTO goal FROM community_goal g WHERE g.id = goal.id;
      EXIT WHEN goal.final_at IS NOT NULL OR goal.settled_until IS NOT DISTINCT FROM before;
    END LOOP;
    IF goal.final_at IS NULL THEN
      RAISE EXCEPTION 'a transaction from the goal''s window is still open' USING ERRCODE = 'CS409',
        DETAIL = 'community_settling';
    END IF;
    settled := settled + 1;
  END LOOP;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after,
                         request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'community.settle', 'event', ev.id::text,
          jsonb_build_object('goals', settled), request);
  RETURN settled;
END $$;
REVOKE ALL ON FUNCTION settle_community(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION settle_community(uuid, uuid) TO questify_app;

-- ================================================================ the boost-start push waits for the layer (review MAJOR 1)
-- 0078's trigger body with `feature_enabled(e, 'boosts')` (the event's switch and the platform as the organizer sees it) in
-- place of `boosts_on(e)`. The trigger itself is unchanged.
CREATE OR REPLACE FUNCTION push_on_boost_start() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM notice_create('boost_start', NEW.organizer_id, NEW.event_id, NULL,
                        jsonb_build_object('boost', NEW.id, 'category', NEW.category_id),
                        jsonb_build_object('event', push_names(e.name_ar, e.name_en),
                                           'category', push_names(c.name_ar, c.name_en)),
                        'boost:' || NEW.id, NEW.ends_at)
  FROM event e JOIN category c ON c.id = NEW.category_id
  WHERE e.id = NEW.event_id AND feature_enabled(e, 'boosts') AND coalesce(c.opens_at <= now(), true)
    AND category_community_lock(c.id) IS NULL;
  RETURN NULL;
END $$;

-- 0078's due scan, the same change: a boost whose window opened while the layer was Off is pushed if the layer comes back On
-- while it still runs.
CREATE OR REPLACE FUNCTION push_due_boost(lim integer) RETURNS integer
  LANGUAGE sql SET search_path = public, pg_temp AS $$
  WITH due AS (
    SELECT b.id, b.organizer_id, b.event_id, b.category_id, b.ends_at
    FROM boost b JOIN event e ON e.id = b.event_id JOIN category c ON c.id = b.category_id
    WHERE b.starts_at <= now() AND b.starts_at > now() - interval '1440 minutes' AND b.ends_at > now()
      AND feature_enabled(e, 'boosts') AND coalesce(c.opens_at <= now(), true) AND category_community_lock(c.id) IS NULL
      AND NOT EXISTS (SELECT 1 FROM notice nt WHERE nt.dedupe = 'boost:' || b.id)
    ORDER BY b.starts_at, b.id
    LIMIT push_due_boost.lim)
  SELECT count(notice_create('boost_start', due.organizer_id, due.event_id, NULL,
                             jsonb_build_object('boost', due.id, 'category', due.category_id),
                             jsonb_build_object('event', push_names(e.name_ar, e.name_en),
                                                'category', push_names(c.name_ar, c.name_en)),
                             'boost:' || due.id, due.ends_at))::integer
  FROM due JOIN event e ON e.id = due.event_id JOIN category c ON c.id = due.category_id
$$;

-- 0080's rule with the same change for the boost kind: a notice written before the layer went Off is not sent after.
CREATE OR REPLACE FUNCTION notice_audience_ok(nt notice, member enrollment) RETURNS boolean
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  ev     event;
  target uuid;
BEGIN
  IF nt.id IS NULL THEN
    RETURN false;
  ELSIF nt.kind = 'streak_reminder' THEN
    RETURN push_streak_open(nt);
  ELSIF nt.kind = 'invitation' THEN
    SELECT e.* INTO ev FROM event e WHERE e.id = nt.event_id;
    RETURN member.id IS NULL AND invitation_event_ok(ev, true) IS NULL;
  ELSIF nt.kind NOT IN ('flash_quest', 'boost_start', 'poll_sent', 'community_step', 'category_open', 'event_soon',
                        'shop_closing', 'category_hint') THEN
    RETURN true;
  ELSIF member.id IS NULL THEN
    RETURN false;
  END IF;
  SELECT e.* INTO ev FROM event e
  WHERE e.id = nt.event_id
    AND NOT EXISTS (SELECT 1 FROM staff_assignment sa
                    WHERE sa.event_id = e.id AND sa.player_id = member.player_id AND NOT sa.can_play);
  IF NOT FOUND THEN
    RETURN false;
  ELSIF nt.kind = 'category_hint' THEN
    RETURN push_hint_ok(nt, member);
  ELSIF nt.kind = 'shop_closing' THEN
    RETURN push_shop_open(nt, ev, member);
  ELSIF nt.kind IN ('flash_quest', 'boost_start', 'category_open') AND NOT push_category_opened(nt) THEN
    RETURN false;
  ELSIF nt.kind IN ('flash_quest', 'category_open') THEN
    RETURN true;
  ELSIF nt.kind = 'poll_sent' THEN
    IF NOT polls_shown(ev) THEN
      RETURN false;
    END IF;
    target := push_ref(nt.refs, 'quest');
    RETURN NOT EXISTS (SELECT 1 FROM quest_completion qc WHERE qc.enrollment_id = member.id AND qc.quest_id = target);
  ELSIF nt.kind = 'boost_start' THEN
    IF NOT feature_enabled(ev, 'boosts') THEN
      RETURN false;
    END IF;
    target := push_ref(nt.refs, 'boost');
    RETURN EXISTS (SELECT 1 FROM boost b
                   WHERE b.id = target AND b.event_id = ev.id AND b.ends_at > now()
                     AND b.rehearsal = (member.joined_via IS NOT DISTINCT FROM 'rehearsal'));
  ELSIF nt.kind = 'event_soon' THEN
    RETURN nt.dedupe = 'event_soon:' || ev.id || ':' || push_instant(ev.starts_at);
  END IF;
  RETURN community_on(ev);  -- community_step, the last kind left
END $$;

-- ================================================================ the recorded Ask Questify request (FR-1827, ADR-545)
-- The add-ons an owner may ask for: the registry's gated features, here for the door and in the table's CHECK below (a CHECK
-- runs as the writer, who holds no EXECUTE on an internal function); `test/db/feature-layers-points.int.test.ts` compares
-- both with the registry.
CREATE FUNCTION feature_request_addon(k text) RETURNS boolean
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$ SELECT k IN ('bigScreen') $$;
REVOKE ALL ON FUNCTION feature_request_addon(text) FROM PUBLIC;

CREATE TABLE feature_request (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id uuid NOT NULL REFERENCES organizer (id) ON DELETE CASCADE,
  event_id     uuid NOT NULL REFERENCES event (id) ON DELETE CASCADE,
  feature      text NOT NULL CHECK (feature IN ('bigScreen')),
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'allowed', 'declined')),
  requested_by uuid NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_by   uuid,
  decided_at   timestamptz,
  CHECK ((status = 'open') = (decided_at IS NULL)),
  CHECK (decided_by IS NULL OR decided_at IS NOT NULL)
);
-- One open request per event and add-on; the console's queue by age; the owner's latest per add-on.
CREATE UNIQUE INDEX feature_request_open_idx ON feature_request (event_id, feature) WHERE status = 'open';
CREATE INDEX feature_request_queue_idx ON feature_request (requested_at, id) WHERE status = 'open';
CREATE INDEX feature_request_event_idx ON feature_request (event_id, feature, requested_at DESC);
CREATE INDEX feature_request_organizer_idx ON feature_request (organizer_id);
ALTER TABLE feature_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE feature_request FORCE ROW LEVEL SECURITY;

-- A member of the organizer (its own rows only: not every caller who can see a public event) and an admin read; an admin
-- closes (the unlock and the decline run as the admin in TypeScript). Nobody inserts or deletes but through the door and the
-- event's or organizer's own deletion.
CREATE POLICY feature_request_read ON feature_request FOR SELECT TO questify_app
  USING (app_admin_id() IS NOT NULL OR organizer_id = app_organizer_id());
CREATE POLICY feature_request_close ON feature_request FOR UPDATE TO questify_app
  USING (app_admin_id() IS NOT NULL AND status = 'open')
  WITH CHECK (app_admin_id() IS NOT NULL AND status IN ('allowed', 'declined'));
GRANT SELECT ON feature_request TO questify_app;
GRANT UPDATE (status, decided_by, decided_at) ON feature_request TO questify_app;

-- The owner asks Questify for an add-on of one of the organizer's events. RQ404 no such event of the caller's organizer,
-- RQ403 not its owner, RQ422 not an add-on, RQ409 already unlocked, RQ429 within 24 hours of a decline (HINT: when asking is
-- allowed again). A repeat while one is open answers that row (`created` false) and writes nothing. Audited
-- `feature_request.create` with ids and the key only.
CREATE FUNCTION request_feature(target_event uuid, wanted text, request uuid)
  RETURNS TABLE (id uuid, status text, requested_at timestamptz, created boolean)
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
#variable_conflict use_column
DECLARE
  me       uuid := app_staff_user_id();
  ev       event%ROWTYPE;
  made     feature_request%ROWTYPE;
  declined timestamptz;
BEGIN
  SELECT e.* INTO ev FROM event e WHERE e.id = target_event;
  IF NOT FOUND OR me IS NULL OR ev.organizer_id IS DISTINCT FROM app_organizer_id() THEN
    RAISE EXCEPTION 'no such event' USING ERRCODE = 'RQ404';
  ELSIF NOT app_is_owner(ev.organizer_id) THEN
    RAISE EXCEPTION 'only the owner asks Questify' USING ERRCODE = 'RQ403';
  ELSIF wanted IS NULL OR NOT feature_request_addon(wanted) THEN
    RAISE EXCEPTION 'not an add-on' USING ERRCODE = 'RQ422';
  ELSIF EXISTS (SELECT 1 FROM event_entitlement x WHERE x.event_id = ev.id AND x.feature = wanted) THEN
    RAISE EXCEPTION 'already unlocked' USING ERRCODE = 'RQ409';
  END IF;
  SELECT r.* INTO made FROM feature_request r WHERE r.event_id = ev.id AND r.feature = wanted AND r.status = 'open';
  IF FOUND THEN
    RETURN QUERY SELECT made.id, made.status, made.requested_at, false;
    RETURN;
  END IF;
  SELECT max(r.decided_at) INTO declined FROM feature_request r
  WHERE r.event_id = ev.id AND r.feature = wanted AND r.status = 'declined';
  IF declined > now() - interval '24 hours' THEN
    RAISE EXCEPTION 'declined in the last 24 hours' USING ERRCODE = 'RQ429',
      HINT = to_char((declined + interval '24 hours') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"');
  END IF;
  INSERT INTO feature_request (organizer_id, event_id, feature, requested_by)
  VALUES (ev.organizer_id, ev.id, wanted, me)
  ON CONFLICT (event_id, feature) WHERE status = 'open' DO NOTHING
  RETURNING * INTO made;
  IF NOT FOUND THEN
    -- Another call of the same owner opened it in the same instant: answer that row.
    SELECT r.* INTO made FROM feature_request r WHERE r.event_id = ev.id AND r.feature = wanted AND r.status = 'open';
    RETURN QUERY SELECT made.id, made.status, made.requested_at, false;
    RETURN;
  END IF;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after, request_id)
  VALUES ('staff', me, ev.organizer_id, ev.id, 'feature_request.create', 'feature_request', made.id::text,
          jsonb_build_object('feature', wanted), request);
  RETURN QUERY SELECT made.id, made.status, made.requested_at, true;
END $$;
REVOKE ALL ON FUNCTION request_feature(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION request_feature(uuid, text, uuid) TO questify_app;
