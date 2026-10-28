-- T-501e: the owed event pushes (FR-1102, FR-246; plan docs/plans/2026-10-28-t-501e-event-pushes.md on the T-501 plan's
-- "Owed pushes" rows 7 to 12; ADR-354). Each kind is a `notice_kind` row of the event class; each producer calls only
-- notice_create (one insert: an unknown kind inserts nothing and raises nothing, so a broken kind can never roll a door
-- back): a row trigger with a WHEN on quest (a flash quest's launch, a live poll's send) and boost (a boost that starts
-- at once), a statement trigger with a transition table on community_reach (the community tick's steps), and four due
-- scans added to push_due() (a scheduled flash quest's start, a boost's start, a category's opening, the event starting
-- soon). What each kind may name and who it reaches are checked at fan-out and again at the claim (notice_audience_ok
-- restated; notice_status_ok restated so a live or ended event reaches real members only). No EXCEPTION block anywhere.
-- Deny by default: every function is closed to PUBLIC in the group that creates it and none is newly granted (push_due
-- keeps 0077's grant); the trigger functions are definers, so a trigger that could not insert its notice never undoes
-- the door. sees_category, flash_shown, member_sees_quest, notice_reward_seen and notice_visible are restated with the
-- same rules in PL/pgSQL, so the per-member checks keep their plans (ADR-354 (5)), and push_fan_out_batch takes 1,000
-- enrollments a call instead of 2,000 (ADR-354 (9)). Migrations 0077 and earlier untouched.
SET LOCAL lock_timeout = '10s';
-- Three tables gain a trigger (SHARE ROW EXCLUSIVE) and three a due-scan index; taken up front, categories before the
-- quests and boosts that name them.
LOCK TABLE category IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE quest IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE boost IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE community_reach IN SHARE ROW EXCLUSIVE MODE;

-- The due scans' ranges: scheduled flash quests by their opening, boosts by their start, categories by their opening
-- (the event's start already has event_due_to_start, 0009); an event's earlier notices of a kind, which a moved start or
-- opening is compared with (ADR-354 (10)).
CREATE INDEX quest_flash_due ON quest (opens_at) WHERE flash AND visible AND flash_launched_at IS NULL;
CREATE INDEX boost_starts_idx ON boost (starts_at);
CREATE INDEX category_opens_idx ON category (opens_at) WHERE opens_at IS NOT NULL;
CREATE INDEX notice_event_kind ON notice (event_id, kind) WHERE audience = 'event';

-- ================================================================ the kinds (ADR-354)
-- Event class (priority 1). Topics: announcements for a flash quest, a boost, a live poll and a category's opening;
-- community for a milestone; reminders for the event starting soon (a `before_start` kind: real members before the
-- start). Each push's expiry is also capped by what it announces (the quest's close, the boost's end, the start).
INSERT INTO notice_kind (kind, class, topic, membership, before_start, priority, ttl) VALUES
  ('flash_quest', 'event', 'announcements', 'active', false, 1, interval '24 hours'),
  ('boost_start', 'event', 'announcements', 'active', false, 1, interval '24 hours'),
  ('poll_sent', 'event', 'announcements', 'active', false, 1, interval '24 hours'),
  ('community_step', 'event', 'community', 'active', false, 1, interval '2 hours'),
  ('category_open', 'event', 'announcements', 'active', false, 1, interval '2 hours'),
  ('event_soon', 'event', 'reminders', 'active', true, 1, interval '1 hour');

-- ================================================================ helpers (internal: no grant)
-- A moment as whole microseconds since the epoch, for once-only markers: the same text in every session and zone.
CREATE FUNCTION push_instant(at timestamptz) RETURNS text
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT ((extract(epoch FROM at) * 1000000)::bigint)::text
$$;
REVOKE ALL ON FUNCTION push_instant(timestamptz) FROM PUBLIC;

-- ================================================================ per-member checks that keep their plans (ADR-354 (5))
-- The fan-out and the claim check every member one call at a time. A SQL function with a SET clause is planned again at
-- every call when another function's query calls it (its cache lives in that query's executor state), and so is every
-- such function nested inside it: sees_category planned in_audience again for each member, which made a live poll's
-- fan-out to 50,000 members take 336 s (one call of 2,000 up to 14.8 s, over the API's 5 s statement limit). The checks
-- below are PL/pgSQL calling those functions in plain expressions, whose state lasts the transaction, and keep queries
-- free of them. sees_category, flash_shown, member_sees_quest, notice_reward_seen and notice_visible are restated with
-- the same rules (every reader of the first two gains the same speed); the DB suites that cover hidden and targeted
-- categories, flash windows and the push store's visibility run against these bodies.

-- As 0046: in the category's audience, and not hidden or found by the member.
CREATE OR REPLACE FUNCTION sees_category(member uuid, cat category) RETURNS boolean
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
BEGIN
  IF cat.audience_kind IS NOT NULL
     AND NOT in_audience(member, cat.audience_kind, cat.audience_field_id, cat.audience_values) THEN
    RETURN false;
  ELSIF NOT cat.hidden THEN
    RETURN true;
  END IF;
  RETURN EXISTS (SELECT 1 FROM category_reveal r WHERE r.enrollment_id = member AND r.category_id = cat.id);
END $$;
REVOKE ALL ON FUNCTION sees_category(uuid, category) FROM PUBLIC;

-- As 0055: any quest that is not flash; a flash quest only inside its window, with the switches on, and a launched one
-- only while the event's sent polls may be shown. Callers check `visible` themselves.
CREATE OR REPLACE FUNCTION flash_shown(quest_row quest) RETURNS boolean
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  ev event;
BEGIN
  IF NOT quest_row.flash THEN
    RETURN true;
  ELSIF NOT coalesce(quest_row.opens_at <= now() AND quest_row.closes_at > now(), false) THEN
    RETURN false;
  END IF;
  SELECT e.* INTO ev FROM event e WHERE e.id = quest_row.event_id;
  RETURN FOUND AND flash_on(ev) AND (quest_row.flash_launched_at IS NULL OR polls_shown(ev));
END $$;
REVOKE ALL ON FUNCTION flash_shown(quest) FROM PUBLIC;

-- As 0076 (member_event_quests' listing rule plus its window: the quest visible, opened and not closed, shown as a
-- flash quest, its category seen by a member of its event), one step at a time; flash_shown only for a flash quest
-- (any other is shown).
CREATE OR REPLACE FUNCTION member_sees_quest(member uuid, target uuid) RETURNS boolean
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  q quest;
  c category;
BEGIN
  SELECT x.* INTO q FROM quest x WHERE x.id = target;
  IF NOT FOUND OR NOT q.visible OR coalesce(q.opens_at > now(), false) OR coalesce(q.closes_at <= now(), false) THEN
    RETURN false;
  END IF;
  SELECT x.* INTO c FROM category x
  WHERE x.id = q.category_id AND x.event_id = q.event_id
    AND EXISTS (SELECT 1 FROM enrollment n WHERE n.id = member AND n.event_id = q.event_id);
  IF NOT FOUND OR (q.flash AND NOT flash_shown(q)) THEN
    RETURN false;
  END IF;
  -- A category with no audience that is not hidden is seen by every member: no call for the usual case.
  RETURN (c.audience_kind IS NULL AND NOT c.hidden) OR sees_category(member, c);
END $$;
REVOKE ALL ON FUNCTION member_sees_quest(uuid, uuid) FROM PUBLIC;

-- As 0076: a reward an event notice names reaches only the members in its audience; a personal notice names the
-- player's own reward and needs nothing more.
CREATE OR REPLACE FUNCTION notice_reward_seen(nt notice, member enrollment) RETURNS boolean
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  target uuid;
  r      reward;
BEGIN
  IF NOT nt.refs ? 'reward' OR nt.audience <> 'event' THEN
    RETURN true;
  END IF;
  target := push_ref(nt.refs, 'reward');
  SELECT x.* INTO r FROM reward x WHERE x.id = target AND x.event_id = nt.event_id;
  RETURN FOUND AND in_audience(member.id, r.audience_kind, r.audience_field_id, r.audience_values);
END $$;
REVOKE ALL ON FUNCTION notice_reward_seen(notice, enrollment) FROM PUBLIC;

-- As 0076 (plan § Review 7, ADR-347 (2)): event notices name a category by sees_category, a quest by
-- member_sees_quest, a reward by its audience; personal and promotional notices name what the player acted on, checked
-- by the category (or the quest's category) only. A named reference that is malformed or not in the event hides it.
CREATE OR REPLACE FUNCTION notice_visible(nt notice, member enrollment) RETURNS boolean
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  target uuid;
  cat    category;
BEGIN
  IF nt.refs ? 'category' THEN
    target := push_ref(nt.refs, 'category');
    SELECT c.* INTO cat FROM category c WHERE c.id = target AND c.event_id = nt.event_id;
    IF NOT FOUND OR NOT sees_category(member.id, cat) THEN
      RETURN false;
    END IF;
  END IF;
  IF nt.refs ? 'quest' AND nt.audience = 'event' THEN
    RETURN member_sees_quest(member.id, push_ref(nt.refs, 'quest')) AND notice_reward_seen(nt, member);
  ELSIF nt.refs ? 'quest' THEN
    target := push_ref(nt.refs, 'quest');
    SELECT c.* INTO cat FROM quest q JOIN category c ON c.id = q.category_id
    WHERE q.id = target AND q.event_id = nt.event_id;
    IF NOT FOUND OR NOT sees_category(member.id, cat) THEN
      RETURN false;
    END IF;
  END IF;
  RETURN notice_reward_seen(nt, member);
END $$;
REVOKE ALL ON FUNCTION notice_visible(notice, enrollment) FROM PUBLIC;

-- Whether the category a flash quest, a boost or an opening names has opened: its opening passed (a category moved later
-- has not, and a flash quest or double points in it cannot be played yet). An opening is never pushed for a category
-- that unlocks after another one: each member's real opening is when they clear its gate, which no push announces, and
-- checking that per member is too slow for the fan-out (ADR-354 (7)). The same answer for every member of the notice.
CREATE FUNCTION push_category_opened(nt notice) RETURNS boolean
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  target uuid;
  opens  timestamptz;
  gated  boolean;
BEGIN
  IF nt.kind = 'flash_quest' THEN
    target := push_ref(nt.refs, 'quest');
    SELECT c.opens_at, c.unlock_after IS NOT NULL INTO opens, gated
    FROM quest q JOIN category c ON c.id = q.category_id WHERE q.id = target;
  ELSE
    target := push_ref(nt.refs, 'category');
    SELECT c.opens_at, c.unlock_after IS NOT NULL INTO opens, gated FROM category c WHERE c.id = target;
  END IF;
  RETURN FOUND AND coalesce(opens <= now(), true) AND NOT (nt.kind = 'category_open' AND gated);
END $$;
REVOKE ALL ON FUNCTION push_category_opened(notice) FROM PUBLIC;

-- ================================================================ who receives (ADR-354 (1), (2))
-- As 0076, plus: a live or ended event's notices reach real members only. A rehearsal account left between go-live and
-- the wipe gets nothing, as polls_shown and boost_in_force already treat it.
CREATE OR REPLACE FUNCTION notice_status_ok(k notice_kind, status_now text, member enrollment) RETURNS boolean
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT CASE
    WHEN status_now IN ('draft', 'scheduled')
      THEN (member.joined_via IS NOT DISTINCT FROM 'rehearsal') <> k.before_start
    WHEN status_now IN ('live', 'ended')
      THEN NOT k.before_start AND member.joined_via IS DISTINCT FROM 'rehearsal'
    ELSE false END
$$;
REVOKE ALL ON FUNCTION notice_status_ok(notice_kind, text, enrollment) FROM PUBLIC;

-- Each kind's own audience (0076's hook, checked at fan-out and again at the claim), on top of the membership, status
-- and visibility rules: every T-501e kind skips a member who may not play; a live poll reaches those who have not voted
-- while the event's polls are shown; a boost reaches the accounts of its own kind (rehearsal or real) while it runs and
-- the event's boosts are on; a flash quest, a boost and an opening need their category opened (an opening, no gate
-- before it: push_category_opened); the event starting soon names the
-- start the event still has; a milestone needs the event's community switch on. Other kinds pass. A member who may
-- not play is an operator the owner keeps from playing (FR-906): every T-501e push is about playing. PL/pgSQL now
-- (0076's was plain SQL): each function is called in a plain expression and each query names none (see above).
CREATE OR REPLACE FUNCTION notice_audience_ok(nt notice, member enrollment) RETURNS boolean
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  ev     event;
  target uuid;
BEGIN
  IF nt.id IS NULL OR member.id IS NULL THEN
    RETURN false;
  ELSIF nt.kind NOT IN ('flash_quest', 'boost_start', 'poll_sent', 'community_step', 'category_open', 'event_soon') THEN
    RETURN true;
  END IF;
  SELECT e.* INTO ev FROM event e
  WHERE e.id = nt.event_id
    AND NOT EXISTS (SELECT 1 FROM staff_assignment sa
                    WHERE sa.event_id = e.id AND sa.player_id = member.player_id AND NOT sa.can_play);
  IF NOT FOUND THEN
    RETURN false;
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
    IF NOT boosts_on(ev) THEN
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
REVOKE ALL ON FUNCTION notice_audience_ok(notice, enrollment) FROM PUBLIC;

-- ================================================================ a flash quest's launch (FR-1102, T-307)
-- launch_flash sets flash_launched_at once (a replayed launch changes nothing; the go-live wipe clears it). One notice
-- per window (marked by the quest and its opening, so a rehearsal launch and the live one are two), naming the quest,
-- until it closes. Its recipients are those who may see it now (member_sees_quest at fan-out and at the claim).
CREATE FUNCTION push_on_flash_launch() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM notice_create('flash_quest', NEW.organizer_id, NEW.event_id, NULL, jsonb_build_object('quest', NEW.id),
                        jsonb_build_object('event', push_names(e.name_ar, e.name_en),
                                           'quest', push_names(NEW.title_ar, NEW.title_en)),
                        'flash:' || NEW.id || ':' || push_instant(NEW.opens_at), NEW.closes_at)
  FROM event e WHERE e.id = NEW.event_id;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION push_on_flash_launch() FROM PUBLIC;
CREATE TRIGGER quest_push_flash AFTER UPDATE OF flash_launched_at ON quest
  FOR EACH ROW WHEN (OLD.flash_launched_at IS NULL AND NEW.flash_launched_at IS NOT NULL)
  EXECUTE FUNCTION push_on_flash_launch();

-- ================================================================ a live poll's send (FR-1102, T-306)
-- send_poll sets poll_sent_at once (the go-live wipe clears it). One notice per send (marked by the quest and the send's
-- time), naming the poll, until it closes; its recipients have not voted (notice_audience_ok).
CREATE FUNCTION push_on_poll_sent() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM notice_create('poll_sent', NEW.organizer_id, NEW.event_id, NULL, jsonb_build_object('quest', NEW.id),
                        jsonb_build_object('event', push_names(e.name_ar, e.name_en),
                                           'quest', push_names(NEW.title_ar, NEW.title_en)),
                        'poll:' || NEW.id || ':' || push_instant(NEW.poll_sent_at), NEW.closes_at)
  FROM event e WHERE e.id = NEW.event_id;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION push_on_poll_sent() FROM PUBLIC;
CREATE TRIGGER quest_push_poll AFTER UPDATE OF poll_sent_at ON quest
  FOR EACH ROW WHEN (OLD.poll_sent_at IS NULL AND NEW.poll_sent_at IS NOT NULL)
  EXECUTE FUNCTION push_on_poll_sent();

-- ================================================================ a boost's start (FR-1102, T-307)
-- One notice per boost (marked by its id; a started boost can only be stopped), naming its category, until it ends,
-- while the event's boosts are on. A boost saved to start now gets it here at once; a later start is the due scan's.
CREATE FUNCTION push_on_boost_start() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM notice_create('boost_start', NEW.organizer_id, NEW.event_id, NULL,
                        jsonb_build_object('boost', NEW.id, 'category', NEW.category_id),
                        jsonb_build_object('event', push_names(e.name_ar, e.name_en),
                                           'category', push_names(c.name_ar, c.name_en)),
                        'boost:' || NEW.id, NEW.ends_at)
  FROM event e JOIN category c ON c.id = NEW.category_id
  WHERE e.id = NEW.event_id AND boosts_on(e);
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION push_on_boost_start() FROM PUBLIC;
CREATE TRIGGER boost_push_start AFTER INSERT OR UPDATE OF starts_at ON boost
  FOR EACH ROW WHEN (NEW.starts_at <= now())
  EXECUTE FUNCTION push_on_boost_start();

-- ================================================================ a community milestone (FR-246, T-306b)
-- The community tick reaches every step it passed in one statement (settle_goal_at). One notice per goal per statement,
-- for the highest step reached (a jump past two milestones and the goal is one push, not three), marked by that step.
-- It names no quest (a goal's title is not on the name allowlist, and a points goal counts none): every member sees the
-- community card, so every member may be told.
CREATE FUNCTION push_on_community_reach() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM notice_create('community_step', g.organizer_id, g.event_id, NULL,
                        jsonb_build_object('goal', g.id, 'step', top.step_id),
                        jsonb_build_object('event', push_names(e.name_ar, e.name_en)),
                        'community_step:' || top.step_id, NULL)
  FROM (SELECT DISTINCT ON (s.goal_id) s.goal_id, r.step_id
        FROM reached r JOIN community_step s ON s.id = r.step_id
        ORDER BY s.goal_id, s.threshold DESC) top
  JOIN community_goal g ON g.id = top.goal_id
  JOIN event e ON e.id = g.event_id;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION push_on_community_reach() FROM PUBLIC;
CREATE TRIGGER community_reach_push AFTER INSERT ON community_reach
  REFERENCING NEW TABLE AS reached
  FOR EACH STATEMENT EXECUTE FUNCTION push_on_community_reach();

-- ================================================================ the due scans (ADR-354 (3))
-- Each is one set-based statement of at most `lim` notices, its marker filtered out first; answers the notices written.

-- Whether a start or an opening may be pushed (ADR-354 (10)): no earlier notice of the kind for the event (and, for an
-- opening, the category) names a moment less than 15 minutes from it (900,000,000 microseconds; the same moment
-- included, so a re-run writes nothing), and at most 2 re-pushes (3 notices) so far: an organizer nudging the start
-- never pushes every member each minute. Called by the scans only, once per candidate, never per member.
CREATE FUNCTION push_repush_ok(target_event uuid, target_kind text, target_category uuid, at timestamptz)
  RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT count(*) < 3
     AND coalesce(bool_and(abs(split_part(nt.dedupe, ':', 3)::bigint - push_instant(at)::bigint) >= 900000000), true)
  FROM notice nt
  WHERE nt.event_id = target_event AND nt.kind = target_kind AND nt.audience = 'event'
    AND (target_category IS NULL OR nt.refs ->> 'category' = target_category::text)
$$;
REVOKE ALL ON FUNCTION push_repush_ok(uuid, text, uuid, timestamptz) FROM PUBLIC;

-- A scheduled flash quest (visible with its own window, never launched) whose window opened in the last day (a flash
-- quest lasts at most 1,440 minutes) and is shown now (open, flash quests switched on), not held by a community lock.
CREATE FUNCTION push_due_flash(lim integer) RETURNS integer
  LANGUAGE sql SET search_path = public, pg_temp AS $$
  WITH due AS (
    SELECT q.id, q.organizer_id, q.event_id, q.opens_at, q.closes_at, q.title_ar, q.title_en
    FROM quest q
    WHERE q.flash AND q.visible AND q.flash_launched_at IS NULL
      AND q.opens_at <= now() AND q.opens_at > now() - interval '1440 minutes'
      AND flash_shown(q) AND quest_community_lock(q) IS NULL
      AND NOT EXISTS (SELECT 1 FROM notice nt WHERE nt.dedupe = 'flash:' || q.id || ':' || push_instant(q.opens_at))
    ORDER BY q.opens_at, q.id
    LIMIT push_due_flash.lim)
  SELECT count(notice_create('flash_quest', due.organizer_id, due.event_id, NULL, jsonb_build_object('quest', due.id),
                             jsonb_build_object('event', push_names(e.name_ar, e.name_en),
                                                'quest', push_names(due.title_ar, due.title_en)),
                             'flash:' || due.id || ':' || push_instant(due.opens_at), due.closes_at))::integer
  FROM due JOIN event e ON e.id = due.event_id
$$;
REVOKE ALL ON FUNCTION push_due_flash(integer) FROM PUBLIC;

-- A boost that started in the last day (a boost lasts at most 1,440 minutes) and still runs, its event's boosts on.
CREATE FUNCTION push_due_boost(lim integer) RETURNS integer
  LANGUAGE sql SET search_path = public, pg_temp AS $$
  WITH due AS (
    SELECT b.id, b.organizer_id, b.event_id, b.category_id, b.ends_at
    FROM boost b JOIN event e ON e.id = b.event_id
    WHERE b.starts_at <= now() AND b.starts_at > now() - interval '1440 minutes' AND b.ends_at > now()
      AND boosts_on(e)
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
REVOKE ALL ON FUNCTION push_due_boost(integer) FROM PUBLIC;

-- A category that opened in the last 2 hours, after its live event's start (one open from the start is the start's
-- news), unlocking after no other category (ADR-354 (7)), holding a visible quest and not held by a community lock;
-- until 2 hours after the opening. A moved opening is pushed again only per push_repush_ok.
CREATE FUNCTION push_due_category(lim integer) RETURNS integer
  LANGUAGE sql SET search_path = public, pg_temp AS $$
  WITH due AS (
    SELECT c.id, c.organizer_id, c.event_id, c.opens_at, c.name_ar, c.name_en
    FROM category c JOIN event e ON e.id = c.event_id
    WHERE c.opens_at <= now() AND c.opens_at > now() - interval '2 hours' AND c.opens_at > e.starts_at
      AND event_status_now(e.status, e.starts_at, e.ends_at) = 'live' AND c.unlock_after IS NULL
      AND category_community_lock(c.id) IS NULL
      AND EXISTS (SELECT 1 FROM quest q WHERE q.category_id = c.id AND q.visible)
      AND push_repush_ok(c.event_id, 'category_open', c.id, c.opens_at)
    ORDER BY c.opens_at, c.id
    LIMIT push_due_category.lim)
  SELECT count(notice_create('category_open', due.organizer_id, due.event_id, NULL,
                             jsonb_build_object('category', due.id),
                             jsonb_build_object('event', push_names(e.name_ar, e.name_en),
                                                'category', push_names(due.name_ar, due.name_en)),
                             'category_open:' || due.id || ':' || push_instant(due.opens_at),
                             due.opens_at + interval '2 hours'))::integer
  FROM due JOIN event e ON e.id = due.event_id
$$;
REVOKE ALL ON FUNCTION push_due_category(integer) FROM PUBLIC;

-- A scheduled event starting within the hour: one notice per start, naming the time in the event's zone, until the
-- start. A moved start is pushed again only per push_repush_ok; the claim skips a push whose start has moved.
CREATE FUNCTION push_due_event_soon(lim integer) RETURNS integer
  LANGUAGE sql SET search_path = public, pg_temp AS $$
  WITH due AS (
    SELECT e.id, e.organizer_id, e.starts_at, e.name_ar, e.name_en
    FROM event e
    WHERE e.status = 'scheduled' AND e.starts_at > now() AND e.starts_at <= now() + interval '1 hour'
      AND push_repush_ok(e.id, 'event_soon', NULL, e.starts_at)
    ORDER BY e.starts_at, e.id
    LIMIT push_due_event_soon.lim)
  SELECT count(notice_create('event_soon', due.organizer_id, due.id, NULL, '{}'::jsonb,
                             jsonb_build_object('event', push_names(due.name_ar, due.name_en), 'time', due.starts_at),
                             'event_soon:' || due.id || ':' || push_instant(due.starts_at), due.starts_at))::integer
  FROM due
$$;
REVOKE ALL ON FUNCTION push_due_event_soon(integer) FROM PUBLIC;

-- ================================================================ event batches of 1,000 (ADR-354 (9))
-- As 0076, with 1,000 enrollments a call instead of 2,000: an event push that names a quest checks more per member, and
-- a call stays near half a second (the T-501 gate is 1 s; the API's statement limit 5 s). The same total.
CREATE OR REPLACE FUNCTION push_fan_out_batch(nt notice) RETURNS jsonb
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  made bigint[];
  last uuid;
  seen integer;
BEGIN
  WITH batch AS MATERIALIZED (
    SELECT n.id, n.player_id,
           p.status = 'active' AND notice_member_ok(nt, n) AND notice_audience_ok(nt, n) AS ok
    FROM enrollment n JOIN player p ON p.id = n.player_id
    WHERE n.event_id = nt.event_id AND (nt.fan_cursor IS NULL OR n.id > nt.fan_cursor)
    ORDER BY n.id LIMIT 1000),
  inserted AS (
    INSERT INTO notification (notice_id, player_id, event_id)
    SELECT nt.id, b.player_id, nt.event_id FROM batch b WHERE b.ok ORDER BY b.id
    ON CONFLICT (notice_id, player_id) DO NOTHING
    RETURNING id)
  SELECT (SELECT coalesce(array_agg(i.id), '{}') FROM inserted i),
         (SELECT b.id FROM batch b ORDER BY b.id DESC LIMIT 1),
         (SELECT count(*)::integer FROM batch)
  INTO made, last, seen;
  UPDATE notice x
  SET fan_cursor = coalesce(last, x.fan_cursor), fanned_at = CASE WHEN seen < 1000 THEN now() END, fan_failures = 0,
      retry_after = NULL
  WHERE x.id = nt.id;
  PERFORM push_plan(made);
  RETURN jsonb_build_object('rows', cardinality(made), 'more', true);
END $$;
REVOKE ALL ON FUNCTION push_fan_out_batch(notice) FROM PUBLIC;

-- As 0077, plus the four event scans, 500 notices each a call; `more` when any bound was reached, so the worker calls
-- again. Reads without locks and writes only notices; a second run writes nothing new (the markers).
CREATE OR REPLACE FUNCTION push_due() RETURNS jsonb
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  n_ready    integer;
  n_ending   integer;
  n_flash    integer;
  n_boost    integer;
  n_category integer;
  n_soon     integer;
BEGIN
  PERFORM push_system_only();
  n_ready := push_due_ready(500);
  n_ending := push_due_ending(500);
  n_flash := push_due_flash(500);
  n_boost := push_due_boost(500);
  n_category := push_due_category(500);
  n_soon := push_due_event_soon(500);
  RETURN jsonb_build_object('ready', n_ready, 'ending', n_ending, 'flash', n_flash, 'boost', n_boost,
                            'category', n_category, 'soon', n_soon,
                            'more', greatest(n_ready, n_ending, n_flash, n_boost, n_category, n_soon) >= 500);
END $$;
REVOKE ALL ON FUNCTION push_due() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION push_due() TO questify_app;
