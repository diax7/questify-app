-- Community quests (T-306b, F-101, ADR-222 to ADR-226; plan docs/plans/2026-10-24-t-306b-community-quests.md). A goal
-- counts what every player of the event does inside a window (points, completions or players) and pays the steps it
-- reaches. Nothing in the scan transaction touches a goal: the community tick settles each goal from the ledger in
-- its own transaction, up to the oldest open transaction of the roles that can write the ledger, and a payer pays the
-- frozen payee lists in batches. Deny by default: the five tables have row-level security forced, PUBLIC revoked and
-- no grant; every new function is closed to PUBLIC here, and only the system, team and player doors are granted.

-- ================================================================ the owner must see the API's transactions (ADR-224)
-- The settle point reads the `questify_app` sessions' xact_start through a definer owned by the migration owner, which
-- sees them only as a superuser or with questify_app's privileges. Nothing is granted here (CranL's owner and CI's are
-- superusers): a weaker owner stops the migration with this message, and `migrate --verify` checks the same.
DO $$
BEGIN
  IF NOT (SELECT r.rolsuper FROM pg_roles r WHERE r.rolname = current_user)
     AND NOT pg_has_role(current_user, 'questify_app', 'USAGE') THEN
    RAISE EXCEPTION 'the migration owner % can not read questify_app''s sessions', current_user
      USING HINT = 'Run the migrations as a superuser, or GRANT questify_app TO the owner (ADR-224).';
  END IF;
END $$;

-- ================================================================ the goal, its steps and what the tick keeps
-- One goal of an event. The tally columns are the tick's: `settled_until` is the settle point read so far (NULL until
-- the goal starts), `settled_value` the sum of the slices below it (points and completions), `progress` the cached
-- value shown (settled plus the open tail, or the contributor count for `players`). `final_at` is set once nothing is
-- left to settle or top up. Quests and categories a goal counts cannot be deleted (RESTRICT).
CREATE TABLE community_goal (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organizer_id  uuid NOT NULL,
  event_id      uuid NOT NULL,
  title_ar      text CHECK (char_length(title_ar) BETWEEN 1 AND 80),
  title_en      text CHECK (char_length(title_en) BETWEEN 1 AND 80),
  measure       text NOT NULL CHECK (measure IN ('points', 'completions', 'players')),
  quest_id      uuid,
  category_id   uuid,
  target        bigint NOT NULL,
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz NOT NULL,
  paid_to       text NOT NULL DEFAULT 'contributors' CHECK (paid_to IN ('contributors', 'everyone')),
  status        text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'running', 'reached', 'missed')),
  settled_until timestamptz,
  settled_value bigint NOT NULL DEFAULT 0,
  progress      bigint NOT NULL DEFAULT 0,
  progress_at   timestamptz,
  final_at      timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, event_id),
  CHECK (title_ar IS NOT NULL OR title_en IS NOT NULL),
  CHECK (quest_id IS NULL OR category_id IS NULL),
  CHECK (measure <> 'points' OR (quest_id IS NULL AND category_id IS NULL)),
  CHECK (target BETWEEN 1 AND CASE WHEN measure = 'points' THEN 1000000000 ELSE 1000000 END),
  CHECK (ends_at >= starts_at + interval '1 minute'),
  CHECK (final_at IS NULL OR status IN ('reached', 'missed')),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE CASCADE,
  FOREIGN KEY (quest_id, event_id) REFERENCES quest (id, event_id) ON DELETE RESTRICT,
  FOREIGN KEY (category_id, event_id) REFERENCES category (id, event_id) ON DELETE RESTRICT
);
CREATE INDEX community_goal_event_idx ON community_goal (event_id, starts_at);
CREATE INDEX community_goal_open_idx ON community_goal (starts_at) WHERE final_at IS NULL;
CREATE INDEX community_goal_quest_idx ON community_goal (quest_id) WHERE quest_id IS NOT NULL;
CREATE INDEX community_goal_category_idx ON community_goal (category_id) WHERE category_id IS NOT NULL;
ALTER TABLE community_goal ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_goal FORCE ROW LEVEL SECURITY;
REVOKE ALL ON community_goal FROM PUBLIC;

-- Up to 5 milestones and the goal step (threshold = target, is_goal). `points` pays the payee list; `moment` is the
-- organizer's real-world moment shown as a card; `nothing` shows "Reached!" only (FR-247). T-306c adds `unlock`.
CREATE TABLE community_step (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id  uuid NOT NULL,
  goal_id   uuid NOT NULL,
  threshold bigint NOT NULL CHECK (threshold >= 1),
  is_goal   boolean NOT NULL DEFAULT false,
  reward    text NOT NULL CHECK (reward IN ('points', 'moment', 'nothing')),
  points    integer CHECK (points BETWEEN 1 AND 100000),
  moment_ar text CHECK (char_length(moment_ar) BETWEEN 1 AND 280),
  moment_en text CHECK (char_length(moment_en) BETWEEN 1 AND 280),
  UNIQUE (goal_id, threshold),
  UNIQUE (id, event_id),
  CHECK ((reward = 'points') = (points IS NOT NULL)),
  CHECK ((reward = 'moment') = (moment_ar IS NOT NULL OR moment_en IS NOT NULL)),
  FOREIGN KEY (goal_id, event_id) REFERENCES community_goal (id, event_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX community_step_goal_key ON community_step (goal_id) WHERE is_goal;
ALTER TABLE community_step ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_step FORCE ROW LEVEL SECURITY;
REVOKE ALL ON community_step FROM PUBLIC;

-- A step reached, once: when and at what progress. Reached stays reached.
CREATE TABLE community_reach (
  step_id    uuid PRIMARY KEY,
  event_id   uuid NOT NULL,
  reached_at timestamptz NOT NULL,
  progress   bigint NOT NULL,
  FOREIGN KEY (step_id, event_id) REFERENCES community_step (id, event_id) ON DELETE RESTRICT
);
ALTER TABLE community_reach ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_reach FORCE ROW LEVEL SECURITY;
REVOKE ALL ON community_reach FROM PUBLIC;

-- Who took part (ADR-225): written from every committed row the tick reads, never removed; `first_at` is the oldest
-- counted row's time. No rehearsal account is ever one (rehearsal rows never count).
CREATE TABLE community_contributor (
  goal_id       uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  event_id      uuid NOT NULL,
  first_at      timestamptz NOT NULL,
  PRIMARY KEY (goal_id, enrollment_id),
  FOREIGN KEY (goal_id, event_id) REFERENCES community_goal (id, event_id) ON DELETE RESTRICT,
  FOREIGN KEY (enrollment_id, event_id) REFERENCES enrollment (id, event_id) ON DELETE RESTRICT
);
CREATE INDEX community_contributor_enrollment_idx ON community_contributor (enrollment_id);
ALTER TABLE community_contributor ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_contributor FORCE ROW LEVEL SECURITY;
REVOKE ALL ON community_contributor FROM PUBLIC;

-- Whom a reached points step pays, frozen at the reach (topped up with stragglers for `contributors`), and how it
-- ended: `paid` with its entry, or `skipped` with the reason the payer found.
CREATE TABLE community_payout (
  step_id       uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  event_id      uuid NOT NULL,
  status        text NOT NULL DEFAULT 'due' CHECK (status IN ('due', 'paid', 'skipped')),
  skip_reason   text CHECK (skip_reason IN ('inactive', 'no_play', 'results_final')),
  entry_id      bigint REFERENCES ledger_entry (id) ON DELETE RESTRICT,
  created_at    timestamptz NOT NULL DEFAULT now(),
  done_at       timestamptz,
  PRIMARY KEY (step_id, enrollment_id),
  CHECK ((status = 'skipped') = (skip_reason IS NOT NULL)),
  CHECK ((status = 'paid') = (entry_id IS NOT NULL)),
  CHECK ((status = 'due') = (done_at IS NULL)),
  FOREIGN KEY (step_id, event_id) REFERENCES community_step (id, event_id) ON DELETE RESTRICT,
  FOREIGN KEY (enrollment_id, event_id) REFERENCES enrollment (id, event_id) ON DELETE RESTRICT
);
CREATE INDEX community_payout_due_idx ON community_payout (step_id, enrollment_id) WHERE status = 'due';
CREATE INDEX community_payout_due_age_idx ON community_payout (created_at) WHERE status = 'due';
CREATE INDEX community_payout_due_event_idx ON community_payout (event_id) WHERE status = 'due';
CREATE INDEX community_payout_enrollment_idx ON community_payout (enrollment_id);
CREATE INDEX community_payout_entry_idx ON community_payout (entry_id) WHERE entry_id IS NOT NULL;
ALTER TABLE community_payout ENABLE ROW LEVEL SECURITY;
ALTER TABLE community_payout FORCE ROW LEVEL SECURITY;
REVOKE ALL ON community_payout FROM PUBLIC;

-- ================================================================ the ledger knows the community reward (ADR-223)
ALTER TABLE ledger_entry ADD COLUMN community_step_id uuid REFERENCES community_step (id) ON DELETE RESTRICT;
ALTER TABLE ledger_entry DROP CONSTRAINT ledger_entry_kind_check;
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_kind_check
  CHECK (kind IN ('quest', 'redeem', 'redeem_return', 'welcome', 'handover', 'award', 'removal', 'bonus',
                  'community'));
ALTER TABLE ledger_entry DROP CONSTRAINT ledger_entry_system_returns_only;
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_system_returns_only
  CHECK (actor <> 'system' OR kind IN ('redeem_return', 'welcome', 'bonus', 'community'));
-- A community reward names its step and nothing else; it moves the balance only while the shop is not closed. A
-- removal copies the step of the reward it reverses; no other kind names one.
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_community_shape
  CHECK (kind <> 'community' OR (community_step_id IS NOT NULL AND score_delta > 0
                                 AND balance_delta IN (0, score_delta) AND completion_id IS NULL
                                 AND quest_id IS NULL AND redemption_id IS NULL AND category_id IS NULL
                                 AND actor = 'system'));
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_community_kinds
  CHECK (community_step_id IS NULL OR kind IN ('community', 'removal'));
-- A second guard against paying one step twice to one player.
CREATE UNIQUE INDEX ledger_entry_community_key ON ledger_entry (community_step_id, enrollment_id)
  WHERE kind = 'community';
-- For the step's foreign-key check (a step is deleted only before its goal starts, so this stays empty then).
CREATE INDEX ledger_entry_community_step_idx ON ledger_entry (community_step_id) WHERE community_step_id IS NOT NULL;

-- As 0044, with the community reward: an operator not allowed to play earns none. The payer skips them first
-- (`no_play`), by this same test, so this guard never rolls a batch back.
CREATE OR REPLACE FUNCTION ledger_operator_play_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT NEW.rehearsal AND NEW.kind IN ('quest', 'redeem', 'award', 'bonus', 'community') AND EXISTS (
    SELECT 1 FROM enrollment e JOIN staff_assignment sa ON sa.event_id = e.event_id AND sa.player_id = e.player_id
    WHERE e.id = NEW.enrollment_id AND NOT sa.can_play) THEN
    RAISE EXCEPTION 'operators do not play the event they staff' USING ERRCODE = 'QP403';
  END IF;
  RETURN NEW;
END $$;

-- ================================================================ small rules (internal)
-- The event's own switch (`config.features.community`), on unless set false. The platform's is the API's.
CREATE FUNCTION community_on(ev event) RETURNS boolean
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce(ev.config -> 'features' -> 'community' <> 'false'::jsonb, true)
$$;
REVOKE ALL ON FUNCTION community_on(event) FROM PUBLIC;

-- Where a goal's window ends: its own end, or the event's when that is earlier.
CREATE FUNCTION community_close_at(goal_ends timestamptz, event_ends timestamptz) RETURNS timestamptz
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT least(goal_ends, coalesce(event_ends, 'infinity'::timestamptz))
$$;
REVOKE ALL ON FUNCTION community_close_at(timestamptz, timestamptz) FROM PUBLIC;

-- The system's seat: no player, staff, organizer or admin identity in the request (the API's ticks and the settle
-- route's payer run with an empty context). CS403 otherwise.
CREATE FUNCTION community_system_only() RETURNS void
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT ranking_system() THEN
    RAISE EXCEPTION 'community settling and paying run in the system context only' USING ERRCODE = 'CS403';
  END IF;
END $$;
REVOKE ALL ON FUNCTION community_system_only() FROM PUBLIC;

-- Settling reads the slice in a statement after the one that read pg_stat_activity, so it needs READ COMMITTED's
-- fresh snapshot per statement (CTO plan review 3): under REPEATABLE READ the snapshot could predate the session read.
CREATE FUNCTION community_read_committed() RETURNS void
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'community settling runs at READ COMMITTED only' USING ERRCODE = 'CI500';
  END IF;
END $$;
REVOKE ALL ON FUNCTION community_read_committed() FROM PUBLIC;

-- ================================================================ the settle point (ADR-224)
-- The pure rule: the earlier of `at` and the oldest open transaction's start; a session that could not be read
-- (`blind`) stops settling loudly, never read as "no transaction" (CV500 settle_blind).
CREATE FUNCTION settle_point_of(at timestamptz, starts timestamptz[], blind integer) RETURNS timestamptz
  LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
BEGIN
  IF blind > 0 THEN
    RAISE EXCEPTION 'the sessions of % ledger writers can not be read', blind
      USING ERRCODE = 'CV500', DETAIL = 'settle_blind';
  END IF;
  RETURN least(at, (SELECT min(s) FROM unnest(starts) s));
END $$;
REVOKE ALL ON FUNCTION settle_point_of(timestamptz, timestamptz[], integer) FROM PUBLIC;

-- The oldest open transaction's start among the client backends of this database that can write the ledger (the API's
-- role and the owner, this function's own role), this backend left out; infinity when none is open. pg_stat_activity
-- is read once per transaction (its snapshot is kept to the end), so every caller reads it before any slice. A
-- transaction's ledger rows carry its start as created_at, so every row of a transaction still open is at or above
-- this point. VOLATILE; internal.
CREATE FUNCTION community_settle_point() RETURNS timestamptz
  LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT settle_point_of('infinity'::timestamptz,
                         coalesce(array_agg(a.xact_start) FILTER (WHERE a.xact_start IS NOT NULL), '{}'),
                         (count(*) FILTER (WHERE a.state IS NULL))::integer)
  FROM pg_stat_activity a
  WHERE a.datname = current_database() AND a.backend_type = 'client backend' AND a.pid <> pg_backend_pid()
    AND a.usename IN ('questify_app', current_user)
$$;
REVOKE ALL ON FUNCTION community_settle_point() FROM PUBLIC;

-- ================================================================ counting (FR-243 to FR-245, ADR-222, ADR-225)
-- The goal's counted ledger rows created in [lower, upper), per enrollment: the oldest that makes a contributor, and
-- the value below `split` (settled) and from it (the tail). Rehearsal rows never count. Points: `quest` and `bonus`
-- entries' score; completions: `quest` entries of the quest, the category's quests (by each quest's current category)
-- or any quest, one each. A removal counts (as its negative score, or minus one) only when the entry it reverses is
-- counted: of a counted kind and filter, inside the window, not rehearsal. A contributor has a counted entry that is
-- not a removal (in a points goal, one that earned more than 0). Internal.
CREATE FUNCTION community_read_slice(goal community_goal, close_at timestamptz, lower timestamptz, upper timestamptz,
                                     split timestamptz)
  RETURNS TABLE (enrollment_id uuid, first_at timestamptz, settled bigint, tail bigint)
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  WITH counted AS (
    SELECT l.enrollment_id, l.created_at, l.kind,
           CASE WHEN goal.measure = 'points' THEN l.score_delta WHEN l.kind = 'removal' THEN -1 ELSE 1 END AS delta,
           l.kind <> 'removal' AND (goal.measure <> 'points' OR l.score_delta > 0) AS contributes
    FROM ledger_entry l
    LEFT JOIN ledger_entry r ON l.kind = 'removal' AND r.id = l.reverses
    LEFT JOIN quest q ON q.id = CASE WHEN l.kind = 'removal' THEN r.quest_id ELSE l.quest_id END
    WHERE l.event_id = goal.event_id AND l.created_at >= lower AND l.created_at < upper AND NOT l.rehearsal
      AND l.kind IN ('quest', 'bonus', 'removal')
      AND (l.kind <> 'removal' OR (NOT r.rehearsal AND r.created_at >= goal.starts_at AND r.created_at < close_at))
      AND CASE WHEN l.kind = 'removal' THEN r.kind ELSE l.kind END
          = ANY (CASE WHEN goal.measure = 'points' THEN ARRAY['quest', 'bonus'] ELSE ARRAY['quest'] END)
      AND (goal.measure = 'points' OR (goal.quest_id IS NULL AND goal.category_id IS NULL)
           OR q.id = goal.quest_id OR q.category_id = goal.category_id)
  )
  SELECT c.enrollment_id, min(c.created_at) FILTER (WHERE c.contributes),
         coalesce(sum(c.delta) FILTER (WHERE c.created_at < split), 0)::bigint,
         coalesce(sum(c.delta) FILTER (WHERE c.created_at >= split), 0)::bigint
  FROM counted c
  GROUP BY c.enrollment_id
$$;
REVOKE ALL ON FUNCTION community_read_slice(community_goal, timestamptz, timestamptz, timestamptz, timestamptz)
  FROM PUBLIC;

-- Freezes whom reached points steps pay (FR-248, FR-1620). `everyone`: every enrollment active at the reach (account
-- active, not rehearsal, not an operator who may not play), once, for the steps reached now. `contributors`: every
-- contributor whose first counted row is older than the step's reach; a step reached before this settle is topped up
-- with the contributors this settle added or moved (first_at at or above the last settle point), until the settle
-- point passes the reach. Both ON CONFLICT DO NOTHING. Internal.
CREATE FUNCTION community_freeze_payees(goal community_goal, fresh uuid[], old_until timestamptz) RETURNS void
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF goal.paid_to = 'everyone' THEN
    INSERT INTO community_payout (step_id, enrollment_id, event_id)
    SELECT s.id, n.id, goal.event_id
    FROM community_step s
    JOIN enrollment n ON n.event_id = goal.event_id AND n.status = 'active'
                    AND n.joined_via IS DISTINCT FROM 'rehearsal'
    JOIN player pl ON pl.id = n.player_id AND pl.status = 'active'
    WHERE s.id = ANY (fresh) AND s.reward = 'points'
      AND NOT EXISTS (SELECT 1 FROM staff_assignment sa
                      WHERE sa.event_id = goal.event_id AND sa.player_id = n.player_id AND NOT sa.can_play)
    ON CONFLICT DO NOTHING;
    RETURN;
  END IF;
  INSERT INTO community_payout (step_id, enrollment_id, event_id)
  SELECT s.id, c.enrollment_id, goal.event_id
  FROM community_step s
  JOIN community_reach r ON r.step_id = s.id
  JOIN community_contributor c ON c.goal_id = goal.id AND c.first_at < r.reached_at
  WHERE s.goal_id = goal.id AND s.reward = 'points' AND r.reached_at > old_until
    AND (s.id = ANY (fresh) OR c.first_at >= old_until)
  ON CONFLICT DO NOTHING;
END $$;
REVOKE ALL ON FUNCTION community_freeze_payees(community_goal, uuid[], timestamptz) FROM PUBLIC;

-- Settles one goal its caller holds FOR UPDATE, with the settle point `lag` behind now (30 s for the tick, none for the
-- owner's settle). A scheduled goal starts once its start passed, the switches allow it (`may_start` is the
-- platform's) and the event is live or ended; one that can no longer start is missed at its window's end. A running
-- goal reads [settled_until, upper) split at the settle point p: the slice below p is added to settled_value, the
-- tail above it shown only; upper is now, the window's end, or the goal step's reach once reached (CTO 4), so later
-- rows never move the bar. Steps newly at or under progress are reached (audited, payees frozen); reaching the goal
-- step finishes the goal (`reached`); p reaching the window's end finishes it `missed`. final_at is set once p passed
-- the goal step's reach or the window's end, whichever is first: every row that could top a payee list up was read.
-- One settle reads at most 10 minutes past the last settle point, so a backlog after an outage is caught up over several
-- ticks within the statement limit (CTO code review 3). A started goal whose event switch is off is finished as the
-- switch's trigger finishes it: a tick that read the old config may have started it while the trigger ran (CTO code
-- review 1). VOLATILE: each statement reads a fresh snapshot, taken after the settle point's session read. Internal.
CREATE FUNCTION settle_goal_at(goal community_goal, ev event, lag interval, may_start boolean) RETURNS text
  LANGUAGE plpgsql VOLATILE SET search_path = public, pg_temp AS $$
DECLARE
  close_at   timestamptz := community_close_at(goal.ends_at, ev.ends_at);
  p          timestamptz;
  old_until  timestamptz;
  goal_reach timestamptz;
  upper      timestamptz;
  tail       bigint;
  settled    bigint;
  shown      bigint;
  fresh      uuid[];
BEGIN
  IF goal.status = 'scheduled' THEN
    IF goal.starts_at <= now() AND may_start AND community_on(ev)
       AND event_status_now(ev.status, ev.starts_at, ev.ends_at) IN ('live', 'ended') THEN
      goal.status := 'running';
      goal.settled_until := goal.starts_at;
    ELSIF close_at <= now() THEN
      UPDATE community_goal g SET status = 'missed', final_at = now(), progress_at = now() WHERE g.id = goal.id;
      RETURN 'missed';
    ELSE
      RETURN 'scheduled';
    END IF;
  ELSIF NOT community_on(ev) THEN
    goal.status := CASE WHEN EXISTS (SELECT 1 FROM community_step s JOIN community_reach r ON r.step_id = s.id
                                     WHERE s.goal_id = goal.id AND s.is_goal) THEN 'reached' ELSE 'missed' END;
    UPDATE community_goal g SET status = goal.status, final_at = now(), progress_at = now() WHERE g.id = goal.id;
    RETURN goal.status;
  END IF;

  old_until := goal.settled_until;
  p := greatest(least(now() - lag, community_settle_point(), close_at, old_until + interval '10 minutes'), old_until);
  SELECT r.reached_at INTO goal_reach
  FROM community_step s JOIN community_reach r ON r.step_id = s.id WHERE s.goal_id = goal.id AND s.is_goal;
  upper := greatest(least(now(), close_at, coalesce(goal_reach, 'infinity'::timestamptz),
                          old_until + interval '10 minutes'), old_until);

  WITH slice AS MATERIALIZED (
    SELECT * FROM community_read_slice(goal, close_at, old_until, upper, least(p, upper))
  ), kept AS (
    INSERT INTO community_contributor AS c (goal_id, enrollment_id, event_id, first_at)
    SELECT goal.id, s.enrollment_id, goal.event_id, s.first_at FROM slice s WHERE s.first_at IS NOT NULL
    ON CONFLICT (goal_id, enrollment_id) DO UPDATE SET first_at = excluded.first_at
      WHERE excluded.first_at < c.first_at
    RETURNING 1
  )
  SELECT coalesce(sum(s.settled), 0), coalesce(sum(s.tail), 0) INTO settled, tail FROM slice s;

  IF goal.measure = 'players' THEN
    SELECT count(*) INTO shown FROM community_contributor c
    WHERE c.goal_id = goal.id AND (goal_reach IS NULL OR c.first_at < goal_reach);
  ELSE
    goal.settled_value := goal.settled_value + settled;
    shown := greatest(goal.settled_value + tail, 0);
  END IF;

  WITH made AS (
    INSERT INTO community_reach (step_id, event_id, reached_at, progress)
    SELECT s.id, goal.event_id, now(), shown FROM community_step s
    WHERE s.goal_id = goal.id AND s.threshold <= shown
      AND NOT EXISTS (SELECT 1 FROM community_reach r WHERE r.step_id = s.id)
    RETURNING step_id
  )
  SELECT coalesce(array_agg(made.step_id), '{}') INTO fresh FROM made;
  INSERT INTO audit_log (actor_type, organizer_id, event_id, action, target_type, target_id, after)
  SELECT 'system', goal.organizer_id, goal.event_id, 'community.step_reached', 'community_step', s.id::text,
         jsonb_build_object('goal', goal.id, 'threshold', s.threshold, 'progress', shown)
  FROM community_step s WHERE s.id = ANY (fresh) ORDER BY s.threshold;
  PERFORM community_freeze_payees(goal, fresh, old_until);

  IF goal_reach IS NULL AND EXISTS (SELECT 1 FROM community_step s WHERE s.id = ANY (fresh) AND s.is_goal) THEN
    goal_reach := now();
  END IF;
  IF goal_reach IS NOT NULL THEN
    goal.status := 'reached';
    goal.final_at := CASE WHEN p >= least(goal_reach, close_at) THEN now() END;
  ELSIF p >= close_at THEN
    goal.status := 'missed';
    goal.final_at := now();
  END IF;
  UPDATE community_goal g
  SET status = goal.status, settled_until = p, settled_value = goal.settled_value, progress = shown,
      progress_at = now(), final_at = goal.final_at
  WHERE g.id = goal.id;
  RETURN goal.status;
END $$;
REVOKE ALL ON FUNCTION settle_goal_at(community_goal, event, interval, boolean) FROM PUBLIC;

-- ================================================================ the community tick's doors (system context only)
-- The goals with work to do: not final, and the start passed or the window ended (a goal whose event ended before its
-- start is finished missed, so results never wait on it; CTO code review 2). Oldest first, at most 200 a tick.
CREATE FUNCTION community_tick_goals() RETURNS SETOF uuid
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM community_system_only();
  RETURN QUERY SELECT g.id FROM community_goal g JOIN event e ON e.id = g.event_id
               WHERE g.final_at IS NULL
                 AND (g.starts_at <= now() OR community_close_at(g.ends_at, e.ends_at) <= now())
               ORDER BY g.starts_at, g.id LIMIT 200;
END $$;
REVOKE ALL ON FUNCTION community_tick_goals() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION community_tick_goals() TO questify_app;

-- One settle of one goal, its own transaction (ADR-222): the go-live wipe first, then the goal FOR UPDATE SKIP LOCKED
-- ('busy' when another instance holds it or it is final), then settle_goal_at with the 30 s lag. Answers the goal's
-- status. READ COMMITTED only (CI500) and VOLATILE (CTO 3); CV500 settle_blind when a writer's session is unreadable.
CREATE FUNCTION settle_goal(target_goal uuid, may_start boolean) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  goal community_goal%ROWTYPE;
  ev   event%ROWTYPE;
BEGIN
  PERFORM community_system_only();
  PERFORM community_read_committed();
  PERFORM ensure_rehearsal_wiped(g.event_id) FROM community_goal g WHERE g.id = target_goal;
  SELECT g.* INTO goal FROM community_goal g WHERE g.id = target_goal AND g.final_at IS NULL FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN
    RETURN 'busy';
  END IF;
  SELECT e.* INTO ev FROM event e WHERE e.id = goal.event_id;
  RETURN settle_goal_at(goal, ev, interval '30 seconds', may_start);
END $$;
REVOKE ALL ON FUNCTION settle_goal(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION settle_goal(uuid, boolean) TO questify_app;

-- What the tick logs (ids and counts only): goals not final whose settle point is more than 2 minutes behind, due
-- payout rows older than 2 minutes, and the backend holding the settle point back (its pid and application name, CTO
-- 2: CranL's own admin sessions can be one).
CREATE FUNCTION community_health() RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM community_system_only();
  RETURN jsonb_build_object(
    'behind', coalesce((SELECT jsonb_agg(g.id ORDER BY g.id) FROM community_goal g
                        WHERE g.final_at IS NULL AND g.settled_until < now() - interval '2 minutes'), '[]'::jsonb),
    'stuckSteps', (SELECT count(DISTINCT p.step_id) FROM community_payout p
                   WHERE p.status = 'due' AND p.created_at < now() - interval '2 minutes'),
    'stuckRows', (SELECT count(*) FROM community_payout p
                  WHERE p.status = 'due' AND p.created_at < now() - interval '2 minutes'),
    'blocker', (SELECT jsonb_build_object('pid', a.pid, 'app', a.application_name) FROM pg_stat_activity a
                WHERE a.datname = current_database() AND a.backend_type = 'client backend'
                  AND a.pid <> pg_backend_pid() AND a.usename IN ('questify_app', current_user)
                  AND a.xact_start IS NOT NULL
                ORDER BY a.xact_start LIMIT 1));
END $$;
REVOKE ALL ON FUNCTION community_health() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION community_health() TO questify_app;

-- ================================================================ the payer (ADR-223)
-- Pays up to `size` due rows of one step, one transaction (system context only). With `only_event`, the go-live wipe
-- runs first; otherwise one unlocked read picks the step with the oldest due row and the wipe follows (harmless: no
-- payout row names a rehearsal account, CTO 7). Then the event FOR KEY SHARE (confirm_results takes it FOR UPDATE, so
-- the two serialise), the due rows in enrollment order SKIP LOCKED (only payers touch them), and the batch's
-- enrollments in one statement in id order before any other row lock (ADR-211). No item, no advisory lock, no XP.
-- Payable: the enrollment and account active, allowed to play, results not final; one `community` entry each (balance
-- 0 once the shop closed). Otherwise skipped with the reason. One ranking repair mark per batch.
CREATE FUNCTION pay_community_batch(size integer, only_event uuid)
  RETURNS TABLE (step_id uuid, paid integer, skipped integer)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  picked     community_payout%ROWTYPE;
  ev         event%ROWTYPE;
  amount     integer;
  ids        uuid[];
  balance_on boolean;
  final      boolean;
  n_paid     integer;
  n_skipped  integer;
BEGIN
  PERFORM community_system_only();
  IF only_event IS NOT NULL THEN
    PERFORM ensure_rehearsal_wiped(only_event);
  END IF;
  SELECT p.* INTO picked FROM community_payout p
  WHERE p.status = 'due' AND (only_event IS NULL OR p.event_id = only_event)
  ORDER BY p.created_at, p.step_id LIMIT 1;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF only_event IS NULL THEN
    PERFORM ensure_rehearsal_wiped(picked.event_id);
  END IF;
  SELECT e.* INTO ev FROM event e WHERE e.id = picked.event_id FOR KEY SHARE;
  ids := ARRAY(
    WITH taken AS (
      SELECT p.enrollment_id FROM community_payout p
      WHERE p.step_id = picked.step_id AND p.status = 'due'
      ORDER BY p.enrollment_id LIMIT least(greatest(coalesce(size, 500), 1), 1000)
      FOR UPDATE SKIP LOCKED
    )
    SELECT taken.enrollment_id FROM taken ORDER BY taken.enrollment_id);
  IF cardinality(ids) = 0 THEN
    RETURN;
  END IF;
  PERFORM 1 FROM enrollment n WHERE n.id = ANY (ids) ORDER BY n.id FOR NO KEY UPDATE;
  SELECT s.points INTO amount FROM community_step s WHERE s.id = picked.step_id;
  final := EXISTS (SELECT 1 FROM event_result x WHERE x.event_id = ev.id);
  balance_on := shop_state(ev.status, ev.starts_at, ev.ends_at, ev.shop_days_after) <> 'closed';

  WITH verdict AS (
    SELECT n.id,
           CASE WHEN final THEN 'results_final'
                WHEN n.status <> 'active' OR pl.status <> 'active' THEN 'inactive'
                WHEN EXISTS (SELECT 1 FROM staff_assignment sa
                             WHERE sa.event_id = n.event_id AND sa.player_id = n.player_id AND NOT sa.can_play)
                  THEN 'no_play' END AS why
    FROM enrollment n JOIN player pl ON pl.id = n.player_id
    WHERE n.id = ANY (ids)
  ), made AS (
    INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, actor,
                              community_step_id)
    SELECT ev.organizer_id, ev.id, v.id, 'community', amount, CASE WHEN balance_on THEN amount ELSE 0 END, 'system',
           picked.step_id
    FROM verdict v WHERE v.why IS NULL ORDER BY v.id
    RETURNING id, enrollment_id
  ), paid_rows AS (
    UPDATE community_payout p SET status = 'paid', entry_id = m.id, done_at = now()
    FROM made m WHERE p.step_id = picked.step_id AND p.enrollment_id = m.enrollment_id
    RETURNING 1
  ), skipped_rows AS (
    UPDATE community_payout p SET status = 'skipped', skip_reason = v.why, done_at = now()
    FROM verdict v WHERE v.why IS NOT NULL AND p.step_id = picked.step_id AND p.enrollment_id = v.id
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM paid_rows), (SELECT count(*) FROM skipped_rows) INTO n_paid, n_skipped;
  IF n_paid > 0 THEN
    PERFORM mark_ranking_repair(ev.id);
  END IF;
  RETURN QUERY SELECT picked.step_id, n_paid, n_skipped;
END $$;
REVOKE ALL ON FUNCTION pay_community_batch(integer, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pay_community_batch(integer, uuid) TO questify_app;

-- ================================================================ the builder (owners and editors)
-- Whether a goal is locked: its start passed (whatever the switches did with it).
CREATE FUNCTION community_started(goal community_goal) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT goal.status <> 'scheduled' OR goal.starts_at <= now()
$$;
REVOKE ALL ON FUNCTION community_started(community_goal) FROM PUBLIC;

-- A body's steps, the goal step first: threshold, is_goal, reward, points, moment texts. Internal.
CREATE FUNCTION community_body_steps(body jsonb)
  RETURNS TABLE (threshold bigint, is_goal boolean, reward text, points integer, moment_ar text, moment_en text)
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN x.i = 0 THEN (body ->> 'target')::bigint ELSE (x.step ->> 'threshold')::bigint END, x.i = 0,
         x.step -> 'reward' ->> 'kind', (x.step -> 'reward' ->> 'points')::integer,
         x.step -> 'reward' -> 'moment' ->> 'ar', x.step -> 'reward' -> 'moment' ->> 'en'
  FROM (SELECT 0::bigint AS i, jsonb_build_object('reward', body -> 'reward') AS step
        UNION ALL
        SELECT m.i, m.step FROM jsonb_array_elements(coalesce(body -> 'milestones', '[]'::jsonb))
                                WITH ORDINALITY AS m(step, i)) x
$$;
REVOKE ALL ON FUNCTION community_body_steps(jsonb) FROM PUBLIC;

-- The first locked field the body would change on a started goal, or NULL: only the titles and the moment texts may
-- change once a goal starts (GL409 goal_locked).
CREATE FUNCTION community_locked_field(goal community_goal, body jsonb, starts timestamptz, ends timestamptz)
  RETURNS text LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN body ->> 'measure' IS DISTINCT FROM goal.measure THEN 'measure'
    WHEN (body ->> 'questId')::uuid IS DISTINCT FROM goal.quest_id THEN 'questId'
    WHEN (body ->> 'categoryId')::uuid IS DISTINCT FROM goal.category_id THEN 'categoryId'
    WHEN (body ->> 'target')::bigint IS DISTINCT FROM goal.target THEN 'target'
    WHEN starts IS DISTINCT FROM goal.starts_at THEN 'startsAt'
    WHEN ends IS DISTINCT FROM goal.ends_at THEN 'endsAt'
    WHEN coalesce(body ->> 'paidTo', 'contributors') IS DISTINCT FROM goal.paid_to THEN 'paidTo'
    WHEN (SELECT jsonb_agg(jsonb_build_array(b.threshold, b.is_goal, b.reward, b.points) ORDER BY b.threshold)
          FROM community_body_steps(body) b)
         IS DISTINCT FROM
         (SELECT jsonb_agg(jsonb_build_array(s.threshold, s.is_goal, s.reward, s.points) ORDER BY s.threshold)
          FROM community_step s WHERE s.goal_id = goal.id) THEN 'steps'
  END
$$;
REVOKE ALL ON FUNCTION community_locked_field(community_goal, jsonb, timestamptz, timestamptz) FROM PUBLIC;

-- The window and step rules a new or not-yet-started goal must meet (CG422, DETAIL the field): at least 1 minute long, inside the event's start and end, steps at or under the target
-- (milestones below it) and at most 5 milestones. GL409 goal_limit past 20 goals, goal_overlap when another goal of
-- the event shares any of the window. Internal.
CREATE FUNCTION community_check_window(ev event, target_goal uuid, body jsonb, starts timestamptz, ends timestamptz)
  RETURNS void LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
BEGIN
  IF starts IS NULL OR (ev.starts_at IS NOT NULL AND starts < ev.starts_at) THEN
    RAISE EXCEPTION 'the start is before the event' USING ERRCODE = 'CG422', DETAIL = 'startsAt';
  END IF;
  IF ends IS NULL OR ends < starts + interval '1 minute' OR (ev.ends_at IS NOT NULL AND ends > ev.ends_at) THEN
    RAISE EXCEPTION 'the end is too soon or after the event' USING ERRCODE = 'CG422', DETAIL = 'endsAt';
  END IF;
  IF EXISTS (SELECT 1 FROM community_body_steps(body) b
             WHERE b.threshold IS NULL OR b.threshold < 1 OR b.threshold > (body ->> 'target')::bigint
                OR (NOT b.is_goal AND b.threshold = (body ->> 'target')::bigint))
     OR (SELECT count(*) FROM community_body_steps(body) b WHERE NOT b.is_goal) > 5 THEN
    RAISE EXCEPTION 'milestones sit below the target, at most 5' USING ERRCODE = 'CG422', DETAIL = 'milestones';
  END IF;
  IF target_goal IS NULL AND (SELECT count(*) FROM community_goal g WHERE g.event_id = ev.id) >= 20 THEN
    RAISE EXCEPTION 'an event has at most 20 community goals' USING ERRCODE = 'GL409', DETAIL = 'goal_limit';
  END IF;
  IF EXISTS (SELECT 1 FROM community_goal g
             WHERE g.event_id = ev.id AND g.id IS DISTINCT FROM target_goal
               AND tstzrange(g.starts_at, g.ends_at) && tstzrange(starts, ends)) THEN
    RAISE EXCEPTION 'another community goal runs at that time' USING ERRCODE = 'GL409', DETAIL = 'goal_overlap';
  END IF;
END $$;
REVOKE ALL ON FUNCTION community_check_window(event, uuid, jsonb, timestamptz, timestamptz) FROM PUBLIC;

-- Creates a goal (`target_goal` NULL) or replaces one wholesale with its steps before it starts; once it started only
-- the titles and moment texts change (GL409 goal_locked, HINT the field). Refused once the event ended or its results
-- exist (GL409 event_ended, CTO 5). The go-live wipe runs before any goal is read; goal writes of one event serialise
-- on pg_advisory_xact_lock(hashtextextended('community_goal:' || event, 0)). A start up to 60 s in the past is taken
-- as now. Times are kept to the millisecond, so the dashboard's read and write back match. Audited
-- `community.goal_create` / `community.goal_update`. AN404 outside the caller's events, GN404 no such goal.
CREATE FUNCTION save_community_goal(target_event uuid, target_goal uuid, body jsonb, request uuid) RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev     event := award_event_of(target_event);
  old    community_goal%ROWTYPE;
  saved  uuid;
  starts timestamptz := date_trunc('milliseconds', (body ->> 'startsAt')::timestamptz);
  ends   timestamptz := date_trunc('milliseconds', (body ->> 'endsAt')::timestamptz);
  field  text;
BEGIN
  PERFORM ensure_rehearsal_wiped(ev.id);
  PERFORM pg_advisory_xact_lock(hashtextextended('community_goal:' || ev.id, 0));
  IF target_goal IS NOT NULL THEN
    SELECT g.* INTO old FROM community_goal g WHERE g.id = target_goal AND g.event_id = ev.id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'no such community goal in this event' USING ERRCODE = 'GN404';
    END IF;
    IF community_started(old) THEN
      field := community_locked_field(old, body, starts, ends);
      IF field IS NOT NULL THEN
        RAISE EXCEPTION 'a started goal keeps everything but its texts' USING ERRCODE = 'GL409',
          DETAIL = 'goal_locked', HINT = field;
      END IF;
      UPDATE community_goal g SET title_ar = body -> 'title' ->> 'ar', title_en = body -> 'title' ->> 'en'
      WHERE g.id = old.id;
      UPDATE community_step s SET moment_ar = b.moment_ar, moment_en = b.moment_en
      FROM community_body_steps(body) b WHERE s.goal_id = old.id AND s.threshold = b.threshold;
      INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after,
                             request_id)
      VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'community.goal_update', 'community_goal',
              old.id::text, jsonb_build_object('texts', true), request);
      RETURN old.id;
    END IF;
  END IF;
  IF event_status_now(ev.status, ev.starts_at, ev.ends_at) IN ('ended', 'archived')
     OR EXISTS (SELECT 1 FROM event_result x WHERE x.event_id = ev.id) THEN
    RAISE EXCEPTION 'the event has ended' USING ERRCODE = 'GL409', DETAIL = 'event_ended';
  END IF;
  IF starts < date_trunc('milliseconds', now()) - interval '60 seconds' THEN
    RAISE EXCEPTION 'the start is more than a minute ago' USING ERRCODE = 'CG422', DETAIL = 'startsAt';
  END IF;
  starts := greatest(starts, date_trunc('milliseconds', now()));
  PERFORM community_check_window(ev, target_goal, body, starts, ends);

  IF target_goal IS NULL THEN
    INSERT INTO community_goal (organizer_id, event_id, title_ar, title_en, measure, quest_id, category_id, target,
                                starts_at, ends_at, paid_to)
    VALUES (ev.organizer_id, ev.id, body -> 'title' ->> 'ar', body -> 'title' ->> 'en', body ->> 'measure',
            (body ->> 'questId')::uuid, (body ->> 'categoryId')::uuid, (body ->> 'target')::bigint, starts, ends,
            coalesce(body ->> 'paidTo', 'contributors'))
    RETURNING id INTO saved;
  ELSE
    UPDATE community_goal g
    SET title_ar = body -> 'title' ->> 'ar', title_en = body -> 'title' ->> 'en', measure = body ->> 'measure',
        quest_id = (body ->> 'questId')::uuid, category_id = (body ->> 'categoryId')::uuid,
        target = (body ->> 'target')::bigint, starts_at = starts, ends_at = ends,
        paid_to = coalesce(body ->> 'paidTo', 'contributors')
    WHERE g.id = old.id;
    DELETE FROM community_step s WHERE s.goal_id = old.id;
    saved := old.id;
  END IF;
  INSERT INTO community_step (event_id, goal_id, threshold, is_goal, reward, points, moment_ar, moment_en)
  SELECT ev.id, saved, b.threshold, b.is_goal, b.reward, b.points, b.moment_ar, b.moment_en
  FROM community_body_steps(body) b;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after,
                         request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id,
          CASE WHEN target_goal IS NULL THEN 'community.goal_create' ELSE 'community.goal_update' END,
          'community_goal', saved::text,
          jsonb_build_object('measure', body ->> 'measure', 'target', (body ->> 'target')::bigint, 'startsAt', starts,
                             'endsAt', ends),
          request);
  RETURN saved;
END $$;
REVOKE ALL ON FUNCTION save_community_goal(uuid, uuid, jsonb, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION save_community_goal(uuid, uuid, jsonb, uuid) TO questify_app;

-- Deletes a goal before it starts (GL409 goal_started after). Audited `community.goal_delete`.
CREATE FUNCTION delete_community_goal(target_event uuid, target_goal uuid, request uuid) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev  event := award_event_of(target_event);
  old community_goal%ROWTYPE;
BEGIN
  PERFORM ensure_rehearsal_wiped(ev.id);
  PERFORM pg_advisory_xact_lock(hashtextextended('community_goal:' || ev.id, 0));
  SELECT g.* INTO old FROM community_goal g WHERE g.id = target_goal AND g.event_id = ev.id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such community goal in this event' USING ERRCODE = 'GN404';
  END IF;
  IF community_started(old) THEN
    RAISE EXCEPTION 'a started goal stays' USING ERRCODE = 'GL409', DETAIL = 'goal_started';
  END IF;
  DELETE FROM community_goal g WHERE g.id = old.id;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before,
                         request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'community.goal_delete', 'community_goal',
          old.id::text, jsonb_build_object('measure', old.measure, 'target', old.target), request);
END $$;
REVOKE ALL ON FUNCTION delete_community_goal(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION delete_community_goal(uuid, uuid, uuid) TO questify_app;

-- The event's goals for its team, by start: each with its steps, their reach and payout counts, progress and status.
CREATE FUNCTION community_goals(target_event uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'id', g.id, 'title', jsonb_build_object('ar', g.title_ar, 'en', g.title_en), 'measure', g.measure,
      'questId', g.quest_id, 'categoryId', g.category_id, 'target', g.target, 'startsAt', g.starts_at,
      'endsAt', g.ends_at, 'closesAt', community_close_at(g.ends_at, ev.ends_at), 'paidTo', g.paid_to,
      'status', g.status, 'progress', g.progress, 'progressAt', g.progress_at, 'finalAt', g.final_at,
      'started', community_started(g),
      'steps', (SELECT jsonb_agg(jsonb_build_object(
                  'threshold', s.threshold, 'isGoal', s.is_goal, 'reward', s.reward, 'points', s.points,
                  'moment', CASE WHEN s.reward = 'moment' THEN jsonb_build_object('ar', s.moment_ar, 'en', s.moment_en) END,
                  'reachedAt', r.reached_at,
                  'due', (SELECT count(*) FROM community_payout p WHERE p.step_id = s.id AND p.status = 'due'),
                  'paid', (SELECT count(*) FROM community_payout p WHERE p.step_id = s.id AND p.status = 'paid'),
                  'skipped', (SELECT count(*) FROM community_payout p WHERE p.step_id = s.id AND p.status = 'skipped'))
                  ORDER BY s.threshold)
                FROM community_step s LEFT JOIN community_reach r ON r.step_id = s.id WHERE s.goal_id = g.id))
      ORDER BY g.starts_at, g.id)
    FROM community_goal g WHERE g.event_id = ev.id), '[]'::jsonb);
END $$;
REVOKE ALL ON FUNCTION community_goals(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION community_goals(uuid) TO questify_app;

-- ================================================================ Settle and pay now (the owner, CTO 5)
-- Settles every goal of the event that is not final and whose window ended, with no lag: each FOR UPDATE (waits under
-- a 2 s lock timeout, then 503 busy), settled again and again (10 minutes a settle) up to the oldest open
-- transaction. A goal still not final then had a transaction from its window open: CS409 community_settling (the dashboard retries after 5 s). The owner only (CO403).
-- READ COMMITTED only. Audited `community.settle`. The API then pays in the system context.
CREATE FUNCTION settle_community(target_event uuid, may_start boolean, request uuid) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev      event := award_event_of(target_event);
  goal    community_goal%ROWTYPE;
  before  timestamptz;
  settled integer := 0;
BEGIN
  IF NOT app_is_owner(ev.organizer_id) THEN
    RAISE EXCEPTION 'only the owner settles community goals' USING ERRCODE = 'CO403';
  END IF;
  PERFORM community_read_committed();
  PERFORM ensure_rehearsal_wiped(ev.id);
  SELECT e.* INTO ev FROM event e WHERE e.id = ev.id;
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
REVOKE ALL ON FUNCTION settle_community(uuid, boolean, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION settle_community(uuid, boolean, uuid) TO questify_app;

-- What still holds the results back: goals not final and due payout rows. For confirm_results and the team.
CREATE FUNCTION community_pending(target_event uuid) RETURNS TABLE (goals bigint, due bigint)
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT (SELECT count(*) FROM community_goal g WHERE g.event_id = target_event AND g.final_at IS NULL),
         (SELECT count(*) FROM community_payout p WHERE p.event_id = target_event AND p.status = 'due')
$$;
REVOKE ALL ON FUNCTION community_pending(uuid) FROM PUBLIC;

-- The team's view of the same, for the results page (owners and editors).
CREATE FUNCTION community_paying(target_event uuid) RETURNS TABLE (goals bigint, due bigint)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN QUERY SELECT * FROM community_pending(ev.id);
END $$;
REVOKE ALL ON FUNCTION community_paying(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION community_paying(uuid) TO questify_app;

-- ================================================================ the event switch (ADR-226)
-- Turning `features.community` off for an event finishes its running goals at once: reached if the goal step was
-- reached, else missed. Steps already reached still pay; nothing is topped up, so a contributor whose row was still
-- in flight is not paid (CTO 4). Scheduled goals stay scheduled and do not start while it is off. Lock order: the
-- event (this update), then the goals; the tick never locks the event and the payer's KEY SHARE does not block a
-- config update.
CREATE FUNCTION event_community_off() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE community_goal g
  SET status = CASE WHEN EXISTS (SELECT 1 FROM community_step s JOIN community_reach r ON r.step_id = s.id
                                 WHERE s.goal_id = g.id AND s.is_goal) THEN 'reached' ELSE 'missed' END,
      final_at = now()
  WHERE g.event_id = NEW.id AND g.final_at IS NULL AND g.status <> 'scheduled';
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION event_community_off() FROM PUBLIC;
CREATE TRIGGER event_community_off AFTER UPDATE OF config ON event FOR EACH ROW
  WHEN (NEW.config -> 'features' -> 'community' = 'false'::jsonb
        AND OLD.config -> 'features' -> 'community' IS DISTINCT FROM 'false'::jsonb)
  EXECUTE FUNCTION event_community_off();

-- ================================================================ results wait for the payer (CTO 5)
-- As 0041, plus: after the not_ended check, under the event lock, RF409 community_paying while a goal of the event is
-- not final or a payout row is due (HINT the counts as JSON). The payer's KEY SHARE on the event serialises with this.
CREATE OR REPLACE FUNCTION confirm_results(target_event uuid, expected uuid[], request uuid) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev  event := award_event_of(target_event);
  now_places uuid[];
  due        quiz_attempt%ROWTYPE;
  finished   boolean := false;
  pending    record;
BEGIN
  IF NOT app_is_owner(ev.organizer_id) THEN
    RETURN 'not_owner';
  END IF;
  IF expected IS NULL OR array_position(expected, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'the places seen are required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM ensure_rehearsal_wiped(ev.id);
  SELECT * INTO ev FROM event e WHERE e.id = ev.id FOR UPDATE;
  IF EXISTS (SELECT 1 FROM event_result x WHERE x.event_id = ev.id) THEN
    RETURN 'replayed';
  END IF;
  IF event_status_now(ev.status, ev.starts_at, ev.ends_at) <> 'ended' THEN
    RAISE EXCEPTION 'results are confirmed after the event ends' USING ERRCODE = 'RF409', DETAIL = 'not_ended';
  END IF;
  SELECT * INTO pending FROM community_pending(ev.id);
  IF pending.goals > 0 OR pending.due > 0 THEN
    RAISE EXCEPTION 'community rewards are still being paid' USING ERRCODE = 'RF409', DETAIL = 'community_paying',
      HINT = jsonb_build_object('goals', pending.goals, 'due', pending.due)::text;
  END IF;
  -- Quizzes still open pay what they earned before the places freeze (T-302); a change commits and is reported.
  FOR due IN SELECT a.* FROM quiz_attempt a WHERE a.event_id = ev.id AND a.status = 'open' ORDER BY a.id LOOP
    PERFORM 1 FROM enrollment n WHERE n.id = due.enrollment_id FOR NO KEY UPDATE;
    SELECT * INTO due FROM quiz_attempt a WHERE a.id = due.id FOR UPDATE;
    CONTINUE WHEN due.status <> 'open';
    UPDATE quiz_attempt a SET swept = true WHERE a.id = due.id RETURNING * INTO due;
    finished := finish_quiz(due) = 'paid' OR finished;
  END LOOP;
  now_places := ARRAY(SELECT c.enrollment_id FROM current_places(ev) c ORDER BY c.rank);
  IF finished AND now_places <> expected THEN
    PERFORM mark_ranking_repair(ev.id);
    RETURN 'results_changed';
  END IF;
  IF now_places <> expected THEN
    RAISE EXCEPTION 'the places changed' USING ERRCODE = 'RF409', DETAIL = 'results_changed';
  END IF;

  INSERT INTO event_result (event_id, organizer_id, confirmed_by) VALUES (ev.id, ev.organizer_id, app_staff_user_id());
  INSERT INTO result_place (event_id, rank, enrollment_id, score, score_version, open_flags, rank_prize_id)
  SELECT ev.id, c.rank, c.enrollment_id, c.score, c.score_version,
         (SELECT count(*) FROM flag f WHERE f.enrollment_id = c.enrollment_id AND f.status = 'open'),
         prize_for_rank(ev, c.rank)
  FROM current_places(ev) c;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, after,
                         request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'event.results_confirmed', 'event', ev.id::text,
          jsonb_build_object('places', cardinality(now_places),
                             'flagged', (SELECT count(*) FROM result_place x WHERE x.event_id = ev.id AND x.open_flags > 0)),
          request);
  RETURN 'confirmed';
END $$;

-- ================================================================ removing a community reward
-- As 0047, with a `community` credit removable: its removal copies the step, so the reward reads as removed.
CREATE OR REPLACE FUNCTION remove_award(target_event uuid, target_entry bigint, reason text, request_key text,
                                        request uuid)
  RETURNS TABLE (entry_id bigint, score_delta bigint, balance_delta bigint, replayed boolean, item text)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev       event := award_event_of(target_event);
  me       uuid := app_staff_user_id();
  credit   ledger_entry%ROWTYPE;
  enrolled enrollment%ROWTYPE;
  earlier  manual_award_key%ROWTYPE;
  given    redemption%ROWTYPE;
  why      text;
  take_s   bigint;
  take_b   bigint;
  made     bigint;
  st       text;
BEGIN
  IF request_key IS NULL OR length(request_key) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'an idempotency key is required' USING ERRCODE = 'AK422';
  END IF;
  PERFORM ensure_rehearsal_wiped(ev.id);
  SELECT k.* INTO earlier FROM manual_award_key k
  WHERE k.event_id = ev.id AND k.staff_user_id = me AND k.idempotency_key = request_key;
  IF FOUND THEN
    IF earlier.kind <> 'removal' OR earlier.reverses <> target_entry THEN
      RAISE EXCEPTION 'this key was used for another removal' USING ERRCODE = 'AK422';
    END IF;
    SELECT l.* INTO credit FROM ledger_entry l WHERE l.id = earlier.reverses;
    given := credit_item(credit);
    RETURN QUERY SELECT l.id, l.score_delta, l.balance_delta, true, credit_item_state(given)
      FROM ledger_entry l WHERE l.id = earlier.entry_id;
    RETURN;
  END IF;

  -- The event first, then the enrollment (confirm_results takes the event FOR UPDATE): a confirm in flight waits
  -- for this removal to commit, or this removal sees the frozen results.
  PERFORM 1 FROM event e WHERE e.id = ev.id FOR KEY SHARE;
  IF EXISTS (SELECT 1 FROM event_result x WHERE x.event_id = ev.id) THEN
    RAISE EXCEPTION 'the results are final' USING ERRCODE = 'RF409', DETAIL = 'results_final';
  END IF;
  why := clean_reason(reason);
  SELECT l.* INTO credit FROM ledger_entry l WHERE l.id = target_entry AND l.event_id = ev.id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such entry in this event' USING ERRCODE = 'AE404';
  END IF;
  IF credit.kind NOT IN ('quest', 'award', 'welcome', 'bonus', 'community') THEN
    RAISE EXCEPTION 'only an award can be removed' USING ERRCODE = 'AT422';
  END IF;
  st := event_status_now(ev.status, ev.starts_at, ev.ends_at);
  IF (CASE WHEN credit.rehearsal THEN st NOT IN ('draft', 'scheduled') ELSE st NOT IN ('live', 'ended') END) THEN
    RAISE EXCEPTION 'the event is not live or ended' USING ERRCODE = 'AS409';
  END IF;
  SELECT n.* INTO enrolled FROM enrollment n WHERE n.id = credit.enrollment_id FOR NO KEY UPDATE;
  IF EXISTS (SELECT 1 FROM ledger_entry l WHERE l.reverses = credit.id AND l.kind = 'removal') THEN
    RAISE EXCEPTION 'already removed' USING ERRCODE = 'AD409';
  END IF;
  take_s := least(credit.score_delta, enrolled.score);
  take_b := least(credit.balance_delta, enrolled.balance);
  IF (take_s < credit.score_delta OR take_b < credit.balance_delta)
     AND EXISTS (SELECT 1 FROM redemption d
                 WHERE d.enrollment_id = enrolled.id AND d.status = 'reserved' AND d.price > 0) THEN
    RAISE EXCEPTION 'cancel the player''s reserved prize first' USING ERRCODE = 'AO409';
  END IF;

  INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, completion_id,
                            quest_id, category_id, community_step_id, actor, staff_user_id, reverses)
  VALUES (ev.organizer_id, ev.id, enrolled.id, 'removal', -take_s, -take_b, credit.completion_id, credit.quest_id,
          credit.category_id, credit.community_step_id, 'staff', me, credit.id)
  RETURNING id INTO made;
  INSERT INTO ledger_note (entry_id, organizer_id, event_id, reason) VALUES (made, ev.organizer_id, ev.id, why);
  INSERT INTO manual_award_key (event_id, staff_user_id, idempotency_key, kind, enrollment_id, reverses, entry_id)
  VALUES (ev.id, me, request_key, 'removal', enrolled.id, credit.id, made);
  IF credit.kind = 'quest' THEN
    UPDATE submission s SET status = 'removed', reason = why, removed_at = now(), seen_at = coalesce(s.seen_at, now())
    WHERE s.completion_id = credit.completion_id AND s.status = 'approved';
  END IF;
  given := credit_item(credit);
  IF given.status = 'reserved' THEN
    PERFORM end_reservation(given.id, 'cancelled', 'removal', 'staff', NULL);
    given := credit_item(credit);
  END IF;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before, after,
                         request_id)
  VALUES ('staff', me, ev.organizer_id, ev.id, 'event.award_removed', 'ledger_entry', credit.id::text,
          jsonb_build_object('score', enrolled.score, 'balance', enrolled.balance),
          jsonb_build_object('entry', made, 'score', enrolled.score - take_s, 'balance', enrolled.balance - take_b,
                             'item', credit_item_state(given)),
          request);
  PERFORM mark_ranking_repair(ev.id);
  RETURN QUERY SELECT made, -take_s, -take_b, false, credit_item_state(given);
END $$;

-- As 0047; a community reward (and its removal) is named by its goal's title.
CREATE OR REPLACE FUNCTION member_activity(target uuid, before_id bigint, page integer)
  RETURNS TABLE (id bigint, at timestamptz, kind text, score_delta bigint, balance_delta bigint, quest_id uuid,
                 title_ar text, title_en text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH me AS (
    SELECT n.id FROM enrollment n JOIN player p ON p.id = n.player_id
    WHERE n.event_id = target AND n.player_id = app_player_id() AND n.status = 'active' AND p.status = 'active'
  )
  SELECT l.id, l.created_at, l.kind, l.score_delta, l.balance_delta, l.quest_id,
         coalesce(q.title_ar, r.name_ar, k.name_ar, i.name_ar, g.name_ar, cg.title_ar),
         coalesce(q.title_en, r.name_en, k.name_en, i.name_en, g.name_en, cg.title_en)
  FROM me
  JOIN ledger_entry l ON l.enrollment_id = me.id
  LEFT JOIN quest q ON q.id = l.quest_id
  LEFT JOIN redemption d ON d.id = l.redemption_id
  LEFT JOIN reward r ON r.id = d.reward_id
  LEFT JOIN rank_prize k ON k.id = d.rank_prize_id
  LEFT JOIN quest_item i ON i.id = d.quest_item_id
  LEFT JOIN category g ON g.id = l.category_id
  LEFT JOIN community_step cs ON cs.id = l.community_step_id
  LEFT JOIN community_goal cg ON cg.id = cs.goal_id
  WHERE before_id IS NULL OR l.id < before_id
  ORDER BY l.id DESC
  LIMIT least(greatest(coalesce(page, 25), 1), 100)
$$;

-- As 0047; a community reward is removable and named by its goal's title.
CREATE OR REPLACE FUNCTION member_ledger(target_event uuid, target_enrollment uuid, before_id bigint, page integer)
  RETURNS TABLE (id bigint, at timestamptz, kind text, score_delta bigint, balance_delta bigint, quest_id uuid,
                 title_ar text, title_en text, reason text, by_operator text, by_staff text, reverses bigint,
                 removable boolean, removed boolean)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN QUERY
  SELECT l.id, l.created_at, l.kind, l.score_delta, l.balance_delta, l.quest_id,
         coalesce(q.title_ar, w.name_ar, k.name_ar, i.name_ar, g.name_ar, cg.title_ar),
         coalesce(q.title_en, w.name_en, k.name_en, i.name_en, g.name_en, cg.title_en),
         coalesce(n.reason, b.reason),
         op.username, su.email, l.reverses,
         l.kind IN ('quest', 'award', 'welcome', 'bonus', 'community')
           AND NOT EXISTS (SELECT 1 FROM ledger_entry x WHERE x.reverses = l.id),
         EXISTS (SELECT 1 FROM ledger_entry x WHERE x.reverses = l.id)
  FROM ledger_entry l
  LEFT JOIN ledger_note n ON n.entry_id = l.id
  LEFT JOIN bulk_award b ON b.id = n.bulk_id
  LEFT JOIN quest q ON q.id = l.quest_id
  LEFT JOIN redemption d ON d.id = l.redemption_id
  LEFT JOIN reward w ON w.id = d.reward_id
  LEFT JOIN rank_prize k ON k.id = d.rank_prize_id
  LEFT JOIN quest_item i ON i.id = d.quest_item_id
  LEFT JOIN category g ON g.id = l.category_id
  LEFT JOIN community_step cs ON cs.id = l.community_step_id
  LEFT JOIN community_goal cg ON cg.id = cs.goal_id
  LEFT JOIN player op ON op.id = l.operator_id
  LEFT JOIN staff_user su ON su.id = l.staff_user_id
  WHERE l.event_id = ev.id AND l.enrollment_id = target_enrollment AND (before_id IS NULL OR l.id < before_id)
  ORDER BY l.id DESC
  LIMIT least(greatest(coalesce(page, 50), 1), 100);
END $$;

-- ================================================================ where it shows (FR-250)
-- The member's community card: the goal running now, or the latest one finished in the last 30 minutes, while the
-- event is live or ended and its switch is on; NULL otherwise. Read from the cached columns and key lookups only.
CREATE FUNCTION member_community(ev event, enrolled_id uuid) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'goalId', g.id, 'title', jsonb_build_object('ar', g.title_ar, 'en', g.title_en), 'measure', g.measure,
    'target', g.target, 'progress', g.progress, 'status', g.status, 'paidTo', g.paid_to,
    'endsAt', community_close_at(g.ends_at, ev.ends_at),
    'steps', (SELECT jsonb_agg(jsonb_build_object(
                'threshold', s.threshold, 'isGoal', s.is_goal,
                'reward', jsonb_strip_nulls(jsonb_build_object(
                  'kind', s.reward, 'points', s.points,
                  'moment', CASE WHEN s.reward = 'moment'
                                 THEN jsonb_build_object('ar', s.moment_ar, 'en', s.moment_en) END)),
                'reachedAt', r.reached_at, 'mine', p.status) ORDER BY s.threshold)
              FROM community_step s
              LEFT JOIN community_reach r ON r.step_id = s.id
              LEFT JOIN community_payout p ON p.step_id = s.id AND p.enrollment_id = enrolled_id
              WHERE s.goal_id = g.id),
    'contributed', EXISTS (SELECT 1 FROM community_contributor c WHERE c.goal_id = g.id AND c.enrollment_id = enrolled_id))
  FROM community_goal g
  WHERE g.event_id = ev.id AND g.settled_until IS NOT NULL
    AND (g.final_at IS NULL OR g.final_at > now() - interval '30 minutes')
    AND event_status_now(ev.status, ev.starts_at, ev.ends_at) IN ('live', 'ended') AND community_on(ev)
  ORDER BY g.starts_at DESC
  LIMIT 1
$$;
REVOKE ALL ON FUNCTION member_community(event, uuid) FROM PUBLIC;

-- As 0052, with `community` (member_community) for the calling active member.
CREATE OR REPLACE FUNCTION live_state(target uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  enrolled enrollment%ROWTYPE;
  ev       event%ROWTYPE;
  playing  boolean;
BEGIN
  SELECT n.* INTO enrolled FROM enrollment n JOIN player p ON p.id = n.player_id AND p.status = 'active'
  WHERE n.event_id = target AND n.player_id = app_player_id() AND n.status = 'active';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('polls', '[]'::jsonb, 'closed', '[]'::jsonb, 'community', NULL);
  END IF;
  SELECT * INTO ev FROM event e WHERE e.id = target;
  IF NOT polls_shown(ev) THEN
    RETURN jsonb_build_object('polls', '[]'::jsonb, 'closed', '[]'::jsonb, 'community', NULL);
  END IF;
  playing := play_phase(ev, enrolled) IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM staff_assignment sa WHERE sa.event_id = target AND sa.player_id = enrolled.player_id AND NOT sa.can_play);
  RETURN jsonb_build_object(
    'polls', coalesce((
      SELECT jsonb_agg(jsonb_build_object('questId', q.id, 'closesAt', least(q.closes_at, ev.ends_at))
                       ORDER BY q.opens_at, q.id)
      FROM quest q JOIN category c ON c.id = q.category_id
      WHERE playing AND q.event_id = target AND q.type = 'vote' AND q.type_config ? 'live' AND q.visible
        AND q.opens_at <= now() AND q.closes_at > now() AND (ev.ends_at IS NULL OR ev.ends_at > now())
        AND sees_category(enrolled.id, c) AND category_lock(q, enrolled.id) IS NULL
        AND NOT EXISTS (SELECT 1 FROM quest_completion qc WHERE qc.enrollment_id = enrolled.id AND qc.quest_id = q.id)),
      '[]'::jsonb),
    'closed', coalesce((
      SELECT jsonb_agg(jsonb_build_object('questId', q.id) ORDER BY q.closes_at, q.id)
      FROM quest q JOIN category c ON c.id = q.category_id
      WHERE q.event_id = target AND q.type = 'vote' AND q.type_config ? 'live' AND q.visible
        AND q.type_config -> 'live' ->> 'results' = 'at_close'
        AND least(q.closes_at, ev.ends_at) <= now() AND least(q.closes_at, ev.ends_at) > now() - interval '15 minutes'
        AND sees_category(enrolled.id, c)),
      '[]'::jsonb),
    'community', member_community(ev, enrolled.id));
END $$;

-- Replaces event_has_open_poll: whether the event has a live poll open now or closed in the last 15 minutes, or a
-- community goal to show (running, or finished in the last 30 minutes), for the API's 3-second cache. Names nothing.
DROP FUNCTION event_has_open_poll(uuid);
CREATE FUNCTION event_has_live(target uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM quest q
                 WHERE q.event_id = target AND q.type = 'vote' AND q.type_config ? 'live' AND q.visible
                   AND q.closes_at > now() - interval '15 minutes')
      OR EXISTS (SELECT 1 FROM community_goal g
                 WHERE g.event_id = event_has_live.target AND g.settled_until IS NOT NULL
                   AND (g.final_at IS NULL OR g.final_at > now() - interval '30 minutes'))
$$;
REVOKE ALL ON FUNCTION event_has_live(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION event_has_live(uuid) TO questify_app;
