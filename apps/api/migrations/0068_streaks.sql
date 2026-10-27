-- T-405: streaks (ADR-294 to ADR-301; plan docs/plans/2026-10-27-t-405-streaks.md). The event day streak: one append-only
-- row per enrollment and open event day, and a flat organizer bonus from day 2 as ledger kind `streak`, both written by
-- a trigger on the quest entry so every door pays it. The Questify daily streak: one row per player and Questify day
-- (04:00 to 04:00 Riyadh), written by the same trigger while the platform switch is on, with XP milestones paid once
-- ever by questify_sync (xp_entry source `streak`). Neither writes gems. Deny by default: every new table keeps
-- row-level security forced and no grant; every function is closed to PUBLIC and only the doors are granted to the API
-- role. Deployed migrations and 0057 to 0067 untouched: what changes is restated here.
SET LOCAL lock_timeout = '10s';
-- Every table this migration touches, up front, in live-path order and at the strongest mode a later statement needs
-- (the T-404 MAJOR-1 lesson). `enrollment` first: every payer row-locks an enrollment before it writes a completion or
-- an entry, so this drains the completions in flight and holds new ones before they touch anything below. xp_entry
-- before player_xp: the sync's unlocked pre-check reads xp_entry before it locks player_xp. Never platform_setting
-- (a scan reads it before player_xp) and never player.
LOCK TABLE enrollment IN EXCLUSIVE MODE;
LOCK TABLE event IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE quest_completion IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE xp_entry IN ACCESS EXCLUSIVE MODE;
LOCK TABLE ledger_entry IN ACCESS EXCLUSIVE MODE;
LOCK TABLE player_xp IN SHARE ROW EXCLUSIVE MODE;

-- ================================================================ the event streak's settings (ADR-295, ADR-299)
-- One row per event or none (none: off, no closed days). Not in event.config: the bonus pays points, so SQL validates
-- and audits it. Weekdays are ISO (1 Monday to 7 Sunday); at most six, so every week keeps an open day.
CREATE TABLE event_streak (
  event_id        uuid PRIMARY KEY,
  organizer_id    uuid NOT NULL,
  enabled         boolean NOT NULL DEFAULT false,
  bonus_points    integer CHECK (bonus_points BETWEEN 1 AND 100000),
  closed_weekdays smallint[] NOT NULL DEFAULT '{}'
    CHECK (closed_weekdays <@ '{1,2,3,4,5,6,7}'::smallint[] AND cardinality(closed_weekdays) <= 6
           AND array_position(closed_weekdays, NULL) IS NULL),
  closed_days     date[] NOT NULL DEFAULT '{}'
    CHECK (cardinality(closed_days) <= 366 AND array_position(closed_days, NULL) IS NULL),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE CASCADE
);
ALTER TABLE event_streak ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_streak FORCE ROW LEVEL SECURITY;
REVOKE ALL ON event_streak FROM PUBLIC, questify_app;

-- One row per open event day a player completed a quest: `days` is the streak length that day, `entry_id` the bonus
-- paid with it (NULL: none). Written for every multi-day event, on or off, so switching it on shows true streaks with no
-- backfill. Its keys name only rows the quest entry's own insert already key-locks (the entry's enrollment and event,
-- the completion and the bonus entry, in the same transaction), so it adds no lock. Append-only for every role.
CREATE TABLE event_streak_day (
  enrollment_id uuid NOT NULL,
  day           date NOT NULL,
  organizer_id  uuid NOT NULL,
  event_id      uuid NOT NULL,
  days          integer NOT NULL CHECK (days >= 1),
  completion_id bigint NOT NULL UNIQUE REFERENCES quest_completion (id) ON DELETE RESTRICT,
  entry_id      bigint UNIQUE REFERENCES ledger_entry (id) ON DELETE RESTRICT,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (enrollment_id, day),
  FOREIGN KEY (enrollment_id, event_id) REFERENCES enrollment (id, event_id) ON DELETE RESTRICT,
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE RESTRICT
);
CREATE INDEX event_streak_day_event_idx ON event_streak_day (event_id, day);
ALTER TABLE event_streak_day ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_streak_day FORCE ROW LEVEL SECURITY;
REVOKE ALL ON event_streak_day FROM PUBLIC, questify_app;

-- ================================================================ the Questify daily streak (ADR-297, ADR-298)
-- One row per Questify day with activity. Kept on the erasure tombstone like xp_entry. No foreign key, by design: one
-- to player would key-share the player row inside a completion and deadlock with erase_player (player FOR UPDATE,
-- then enrollments); one to player_xp would key-share the row ledger_xp then locks FOR UPDATE in the same
-- transaction. The only writers derive player_id from the enrollment (T-406: from the caller).
CREATE TABLE questify_streak_day (
  player_id  uuid NOT NULL,
  day        date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, day)
);
ALTER TABLE questify_streak_day ENABLE ROW LEVEL SECURITY;
ALTER TABLE questify_streak_day FORCE ROW LEVEL SECURITY;
REVOKE ALL ON questify_streak_day FROM PUBLIC, questify_app;

-- The milestones (data; a migration edits them until T-703/T-709 add a console editor). A quest pays 100 XP.
CREATE TABLE questify_streak_milestone (
  days smallint PRIMARY KEY CHECK (days BETWEEN 2 AND 1000),
  xp   integer NOT NULL CHECK (xp BETWEEN 1 AND 1000)
);
ALTER TABLE questify_streak_milestone ENABLE ROW LEVEL SECURITY;
ALTER TABLE questify_streak_milestone FORCE ROW LEVEL SECURITY;
REVOKE ALL ON questify_streak_milestone FROM PUBLIC, questify_app;
INSERT INTO questify_streak_milestone (days, xp) VALUES
  (3, 50), (7, 100), (14, 150), (30, 250), (60, 300), (100, 400), (200, 500), (365, 750);

-- A milestone paid, once ever per player (ADR-298). Points at player_xp as the XP rows; kept on the tombstone.
CREATE TABLE questify_streak_reward (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  player_id  uuid NOT NULL REFERENCES player_xp (player_id),
  days       smallint NOT NULL REFERENCES questify_streak_milestone (days),
  xp         integer NOT NULL CHECK (xp BETWEEN 1 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (player_id, days),
  UNIQUE (id, player_id)
);
ALTER TABLE questify_streak_reward ENABLE ROW LEVEL SECURITY;
ALTER TABLE questify_streak_reward FORCE ROW LEVEL SECURITY;
REVOKE ALL ON questify_streak_reward FROM PUBLIC, questify_app;

-- Append-only for every role, the owner included.
CREATE FUNCTION streak_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'streak records can never be changed or removed' USING ERRCODE = 'insufficient_privilege';
END $$;
REVOKE ALL ON FUNCTION streak_append_only() FROM PUBLIC;
CREATE TRIGGER event_streak_day_no_update_or_delete BEFORE UPDATE OR DELETE ON event_streak_day
  FOR EACH ROW EXECUTE FUNCTION streak_append_only();
CREATE TRIGGER event_streak_day_no_truncate BEFORE TRUNCATE ON event_streak_day
  FOR EACH STATEMENT EXECUTE FUNCTION streak_append_only();
CREATE TRIGGER questify_streak_day_no_update_or_delete BEFORE UPDATE OR DELETE ON questify_streak_day
  FOR EACH ROW EXECUTE FUNCTION streak_append_only();
CREATE TRIGGER questify_streak_day_no_truncate BEFORE TRUNCATE ON questify_streak_day
  FOR EACH STATEMENT EXECUTE FUNCTION streak_append_only();
CREATE TRIGGER questify_streak_milestone_no_update_or_delete BEFORE UPDATE OR DELETE ON questify_streak_milestone
  FOR EACH ROW EXECUTE FUNCTION streak_append_only();
CREATE TRIGGER questify_streak_milestone_no_truncate BEFORE TRUNCATE ON questify_streak_milestone
  FOR EACH STATEMENT EXECUTE FUNCTION streak_append_only();
CREATE TRIGGER questify_streak_reward_no_update_or_delete BEFORE UPDATE OR DELETE ON questify_streak_reward
  FOR EACH ROW EXECUTE FUNCTION streak_append_only();
CREATE TRIGGER questify_streak_reward_no_truncate BEFORE TRUNCATE ON questify_streak_reward
  FOR EACH STATEMENT EXECUTE FUNCTION streak_append_only();
ALTER TABLE event_streak_day ENABLE ALWAYS TRIGGER event_streak_day_no_update_or_delete;
ALTER TABLE event_streak_day ENABLE ALWAYS TRIGGER event_streak_day_no_truncate;
ALTER TABLE questify_streak_day ENABLE ALWAYS TRIGGER questify_streak_day_no_update_or_delete;
ALTER TABLE questify_streak_day ENABLE ALWAYS TRIGGER questify_streak_day_no_truncate;
ALTER TABLE questify_streak_milestone ENABLE ALWAYS TRIGGER questify_streak_milestone_no_update_or_delete;
ALTER TABLE questify_streak_milestone ENABLE ALWAYS TRIGGER questify_streak_milestone_no_truncate;
ALTER TABLE questify_streak_reward ENABLE ALWAYS TRIGGER questify_streak_reward_no_update_or_delete;
ALTER TABLE questify_streak_reward ENABLE ALWAYS TRIGGER questify_streak_reward_no_truncate;

-- ================================================================ the XP row of a milestone (ADR-298)
-- quest, removal and questify keep 0066's shape; a streak entry pays once per reward row of the same player, has no
-- ledger entry or event quest, and reverses nothing (xp_reverse follows only ledger_entry_id).
ALTER TABLE xp_entry
  ADD COLUMN streak_reward_id bigint UNIQUE,
  ADD CONSTRAINT xp_entry_streak_reward_fkey FOREIGN KEY (streak_reward_id, player_id)
    REFERENCES questify_streak_reward (id, player_id),
  DROP CONSTRAINT xp_entry_shape,
  ADD CONSTRAINT xp_entry_shape CHECK (
    (source = 'quest' AND delta > 0 AND reverses IS NULL AND ledger_entry_id IS NOT NULL AND quest_id IS NOT NULL
     AND questify_award_id IS NULL AND streak_reward_id IS NULL)
    OR (source = 'removal' AND delta < 0 AND reverses IS NOT NULL AND ledger_entry_id IS NOT NULL
        AND quest_id IS NOT NULL AND questify_award_id IS NULL AND streak_reward_id IS NULL)
    OR (source = 'questify' AND delta > 0 AND reverses IS NULL AND ledger_entry_id IS NULL AND quest_id IS NULL
        AND questify_award_id IS NOT NULL AND streak_reward_id IS NULL)
    OR (source = 'streak' AND delta > 0 AND reverses IS NULL AND ledger_entry_id IS NULL AND quest_id IS NULL
        AND questify_award_id IS NULL AND streak_reward_id IS NOT NULL));

-- ================================================================ the ledger knows the streak bonus (ADR-296)
-- Its own kind: the organizer's flat amount (never boosted, no XP), paid by the system with the day's first quest
-- completion from streak day 2. The shape allows a balance of 0 as the other system bonuses do; the writer pays only
-- while the event is live, so it moves the balance with the score. One per completion; the day row's UNIQUE entry_id
-- makes it one per enrollment and day.
ALTER TABLE ledger_entry DROP CONSTRAINT ledger_entry_kind_check;
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_kind_check
  CHECK (kind IN ('quest', 'redeem', 'redeem_return', 'welcome', 'handover', 'award', 'removal', 'bonus',
                  'community', 'first_bonus', 'streak'));
ALTER TABLE ledger_entry DROP CONSTRAINT ledger_entry_system_returns_only;
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_system_returns_only
  CHECK (actor <> 'system' OR kind IN ('redeem_return', 'welcome', 'bonus', 'community', 'first_bonus', 'streak'));
ALTER TABLE ledger_entry ADD CONSTRAINT ledger_entry_streak_shape
  CHECK (kind <> 'streak' OR (completion_id IS NOT NULL AND quest_id IS NOT NULL AND score_delta > 0
                              AND balance_delta IN (0, score_delta) AND category_id IS NULL
                              AND community_step_id IS NULL AND redemption_id IS NULL AND boost_id IS NULL
                              AND actor = 'system'));
CREATE UNIQUE INDEX ledger_entry_streak_completion_key ON ledger_entry (completion_id) WHERE kind = 'streak';

-- ================================================================ days and switches (internal)
-- The Questify day a moment falls in: 04:00 to 04:00 Riyadh time, one day for everyone (ADR-297; T-406 reuses it).
CREATE FUNCTION questify_day(at timestamptz) RETURNS date
  LANGUAGE sql STABLE SET search_path = public, pg_temp
  RETURN ((at AT TIME ZONE 'Asia/Riyadh') - interval '4 hours')::date;
REVOKE ALL ON FUNCTION questify_day(timestamptz) FROM PUBLIC;

-- The platform switch (FR-420): `platform_setting` features.dailyStreak.enabled, on when absent (as flash_on reads).
CREATE FUNCTION daily_streak_on() RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT s.value -> 'dailyStreak' -> 'enabled' <> 'false'::jsonb
                   FROM platform_setting s WHERE s.key = 'features'), true)
$$;
REVOKE ALL ON FUNCTION daily_streak_on() FROM PUBLIC;

-- Whether an event day is closed: its ISO weekday or its date is one the organizer closed (FR-1615). No settings row:
-- nothing is closed.
CREATE FUNCTION streak_day_closed(settings event_streak, day date) RETURNS boolean
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp
  RETURN coalesce(extract(isodow FROM day)::smallint = ANY (settings.closed_weekdays)
                  OR day = ANY (settings.closed_days), false);
REVOKE ALL ON FUNCTION streak_day_closed(event_streak, date) FROM PUBLIC;

-- The open event day before `day`, walking back over closed days, or NULL before the event's first day. At most six
-- weekdays close, so a week always has an open day unless the organizer closed its dates too.
CREATE FUNCTION prev_open_day(ev event, settings event_streak, day date) RETURNS date
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
DECLARE
  first_day date := event_day(ev.starts_at, ev);
  probe     date := day - 1;
BEGIN
  WHILE probe >= first_day LOOP
    IF NOT streak_day_closed(settings, probe) THEN
      RETURN probe;
    END IF;
    probe := probe - 1;
  END LOOP;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION prev_open_day(event, event_streak, date) FROM PUBLIC;

-- ================================================================ the writer (ADR-295 to ADR-297, ADR-301)
-- Called by the ledger_streak trigger for every non-rehearsal quest entry, whatever the door, on the day the entry is
-- written (a reviewer's approval day, a quiz's finish, a game's result; a manual award counts too). The event part:
-- nothing unless the event is multi-day and live now and today is open; one primary-key range probe ends it when today
-- is counted or a later day exists (a transaction that started before the day boundary and commits after the new
-- day's first completion writes nothing, so a row is never written behind a later one); else the length from the
-- previous open day's row, the bonus first (its own entry, whose nested insert moves the score) and then the day row by
-- a plain INSERT with the bonus already named. The bonus is paid only while the event is live, when its shop is
-- always open, so it moves the balance with the score (T-313's closed-shop rule cannot arise here). Every payer holds the enrollment FOR NO KEY UPDATE, so two completions
-- of one enrollment never race here; if one ever did, the unique keys roll the completion back. The daily part, only
-- while the platform switch is on: one probe, then INSERT ... ON CONFLICT DO NOTHING. No row lock of its own.
CREATE FUNCTION streak_record(entry ledger_entry) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev          event%ROWTYPE;
  settings    event_streak%ROWTYPE;
  today       date;
  before_day  date;
  streak_days integer;
  paid        bigint;
  who         uuid;
BEGIN
  SELECT * INTO ev FROM event e WHERE e.id = entry.event_id;
  IF event_multi_day(ev) AND event_status_now(ev.status, ev.starts_at, ev.ends_at) = 'live'
     AND now() >= ev.starts_at AND now() < ev.ends_at THEN
    today := event_day(now(), ev);
    SELECT * INTO settings FROM event_streak s WHERE s.event_id = ev.id;
    IF NOT streak_day_closed(settings, today) AND NOT EXISTS (
      SELECT 1 FROM event_streak_day d WHERE d.enrollment_id = entry.enrollment_id AND d.day >= today LIMIT 1) THEN
      before_day := prev_open_day(ev, settings, today);
      SELECT d.days + 1 INTO streak_days FROM event_streak_day d
      WHERE d.enrollment_id = entry.enrollment_id AND d.day = before_day;
      streak_days := coalesce(streak_days, 1);
      IF settings.enabled AND settings.bonus_points IS NOT NULL AND streak_days >= 2 THEN
        INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                                  completion_id, quest_id, actor)
        VALUES (entry.organizer_id, entry.event_id, entry.enrollment_id, 'streak', settings.bonus_points,
                settings.bonus_points, entry.completion_id, entry.quest_id, 'system')
        RETURNING id INTO paid;
      END IF;
      INSERT INTO event_streak_day (enrollment_id, day, organizer_id, event_id, days, completion_id, entry_id)
      VALUES (entry.enrollment_id, today, entry.organizer_id, entry.event_id, streak_days, entry.completion_id, paid);
    END IF;
  END IF;

  IF daily_streak_on() THEN
    SELECT n.player_id INTO who FROM enrollment n WHERE n.id = entry.enrollment_id;
    today := questify_day(now());
    IF NOT EXISTS (SELECT 1 FROM questify_streak_day d WHERE d.player_id = who AND d.day = today) THEN
      INSERT INTO questify_streak_day (player_id, day) VALUES (who, today) ON CONFLICT DO NOTHING;
    END IF;
  END IF;
END $$;
REVOKE ALL ON FUNCTION streak_record(ledger_entry) FROM PUBLIC;

-- Fires after apply_ledger_entry (the quest's points are on the enrollment) and before ledger_xp (triggers of one kind
-- fire in name order), so it never runs after the player_xp lock in its own transaction. Rehearsals write nothing; an
-- operator's practice scan runs inside an undone block, so whatever it writes is rolled back with it.
CREATE FUNCTION ledger_streak() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT NEW.rehearsal THEN
    PERFORM streak_record(NEW);
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION ledger_streak() FROM PUBLIC;
CREATE TRIGGER ledger_streak AFTER INSERT ON ledger_entry FOR EACH ROW
  WHEN (NEW.kind = 'quest') EXECUTE FUNCTION ledger_streak();

-- ================================================================ the event streak's doors (ADR-295, ADR-299)
-- Sets the event's streak, for the organizer's owners within their event limit (anyone else: AN404, as a missing
-- event). Refusals: RF409 results_final; ST409 archived, single_day (not multi-day), day_started with the day in HINT
-- (a closed date added or removed that has started, today included, or a closed weekday added or removed that a
-- started event day fell on), so stored lengths and paid bonuses never disagree with the settings; ST422 with the field
-- in DETAIL (enabled, bonusPoints 1 to 100,000 or none, closedWeekdays 1 to 7 at most six and unique, closedDays at
-- most 366 inside the event's days). Locks the event FOR KEY SHARE (against a results confirmation in flight), then
-- only the event_streak row, never an enrollment, a completion or an XP row. An amount or on/off change applies to bonuses paid after it commits. Answers
-- 'set' or 'unchanged' (the same settings again: nothing written, no audit). Audited `event.streak_set`.
CREATE FUNCTION set_event_streak(target_event uuid, is_on boolean, points integer, weekdays smallint[],
                                 dates date[], request uuid) RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev        event := award_event_of(target_event);
  first_day date;
  last_day  date;
  today     date;
  old       event_streak%ROWTYPE;
  made      integer;
  wanted  smallint[];
  closing date[];
  started date;
BEGIN
  IF NOT app_is_owner(ev.organizer_id) THEN
    RAISE EXCEPTION 'no such event' USING ERRCODE = 'AN404';
  END IF;
  -- The event first (confirm_results takes it FOR UPDATE): a confirm in flight waits for this change to commit, or
  -- this change sees the frozen results, as remove_award does. KEY SHARE never waits on a payer (they key-share it too).
  PERFORM 1 FROM event e WHERE e.id = ev.id FOR KEY SHARE;
  IF EXISTS (SELECT 1 FROM event_result x WHERE x.event_id = ev.id) THEN
    RAISE EXCEPTION 'the results are final' USING ERRCODE = 'RF409', DETAIL = 'results_final';
  END IF;
  IF ev.status = 'archived' THEN
    RAISE EXCEPTION 'the event is archived' USING ERRCODE = 'ST409', DETAIL = 'archived';
  END IF;
  IF NOT event_multi_day(ev) THEN
    RAISE EXCEPTION 'a streak needs a multi-day event' USING ERRCODE = 'ST409', DETAIL = 'single_day';
  END IF;
  IF is_on IS NULL THEN
    RAISE EXCEPTION 'on or off' USING ERRCODE = 'ST422', DETAIL = 'enabled';
  END IF;
  IF points NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'a bonus is 1 to 100,000 points' USING ERRCODE = 'ST422', DETAIL = 'bonusPoints';
  END IF;
  IF weekdays IS NULL OR array_position(weekdays, NULL) IS NOT NULL OR NOT weekdays <@ '{1,2,3,4,5,6,7}'::smallint[]
     OR cardinality(weekdays) > 6
     OR cardinality(weekdays) <> (SELECT count(DISTINCT w) FROM unnest(weekdays) w) THEN
    RAISE EXCEPTION 'closed weekdays are 1 to 7, at most six' USING ERRCODE = 'ST422', DETAIL = 'closedWeekdays';
  END IF;
  first_day := event_day(ev.starts_at, ev);
  last_day := event_day(ev.ends_at - interval '1 microsecond', ev);
  today := event_day(now(), ev);
  IF dates IS NULL OR array_position(dates, NULL) IS NOT NULL OR cardinality(dates) > 366
     OR EXISTS (SELECT 1 FROM unnest(dates) d WHERE d < first_day OR d > last_day) THEN
    RAISE EXCEPTION 'closed days are days of the event' USING ERRCODE = 'ST422', DETAIL = 'closedDays';
  END IF;
  wanted := ARRAY(SELECT DISTINCT w FROM unnest(weekdays) w ORDER BY w);
  closing := ARRAY(SELECT DISTINCT d FROM unnest(dates) d ORDER BY d);

  INSERT INTO event_streak (event_id, organizer_id) VALUES (ev.id, ev.organizer_id) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS made = ROW_COUNT;
  SELECT * INTO old FROM event_streak s WHERE s.event_id = ev.id FOR UPDATE;
  IF (old.enabled, old.bonus_points, old.closed_weekdays, old.closed_days)
     IS NOT DISTINCT FROM (is_on, points, wanted, closing) THEN
    RETURN 'unchanged';
  END IF;
  SELECT min(d) INTO started FROM (
    SELECT d FROM unnest(old.closed_days) d WHERE NOT d = ANY (closing)
    UNION ALL
    SELECT d FROM unnest(closing) d WHERE NOT d = ANY (old.closed_days)) changed
  WHERE changed.d <= today;
  IF started IS NULL AND first_day <= today THEN
    SELECT min(g)::date INTO started
    FROM generate_series(first_day, least(today, last_day), interval '1 day') g
    WHERE extract(isodow FROM g)::smallint IN (
      SELECT w FROM unnest(old.closed_weekdays) w WHERE NOT w = ANY (wanted)
      UNION ALL
      SELECT w FROM unnest(wanted) w WHERE NOT w = ANY (old.closed_weekdays));
  END IF;
  IF started IS NOT NULL THEN
    RAISE EXCEPTION 'days that have started cannot change' USING ERRCODE = 'ST409', DETAIL = 'day_started',
      HINT = started::text;
  END IF;
  UPDATE event_streak s
  SET enabled = is_on, bonus_points = points, closed_weekdays = wanted, closed_days = closing, updated_at = now()
  WHERE s.event_id = ev.id;
  INSERT INTO audit_log (actor_type, actor_id, organizer_id, event_id, action, target_type, target_id, before, after,
                         request_id)
  VALUES ('staff', app_staff_user_id(), ev.organizer_id, ev.id, 'event.streak_set', 'event', ev.id::text,
          CASE WHEN made = 0 THEN jsonb_build_object('enabled', old.enabled, 'bonusPoints', old.bonus_points,
                                                     'closedWeekdays', old.closed_weekdays,
                                                     'closedDays', old.closed_days) END,
          jsonb_build_object('enabled', is_on, 'bonusPoints', points, 'closedWeekdays', wanted,
                             'closedDays', closing),
          request);
  RETURN 'set';
END $$;
REVOKE ALL ON FUNCTION set_event_streak(uuid, boolean, integer, smallint[], date[], uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION set_event_streak(uuid, boolean, integer, smallint[], date[], uuid) TO questify_app;

-- The event's streak settings for its owners and editors in scope (AN404 for anyone else), with whether the event is
-- multi-day and its day now (the dashboard offers only later days).
CREATE FUNCTION event_streak_settings(target_event uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
  settings event_streak%ROWTYPE;
BEGIN
  SELECT * INTO settings FROM event_streak s WHERE s.event_id = ev.id;
  RETURN jsonb_build_object('enabled', coalesce(settings.enabled, false), 'bonusPoints', settings.bonus_points,
                            'closedWeekdays', to_jsonb(coalesce(settings.closed_weekdays, '{}')),
                            'closedDays', to_jsonb(coalesce(settings.closed_days, '{}')),
                            'multiDay', event_multi_day(ev), 'today', event_day(now(), ev));
END $$;
REVOKE ALL ON FUNCTION event_streak_settings(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION event_streak_settings(uuid) TO questify_app;

-- The calling member's own event streak: `on` while the streak is enabled on a live multi-day event; `days` today's
-- row, else the previous open day's (still alive: play today), else 0; whether today is played and closed; the bonus.
-- No row for anyone but an active member of the event.
CREATE FUNCTION own_event_streak(target_event uuid)
  RETURNS TABLE (is_on boolean, days integer, played_today boolean, closed_today boolean, bonus_points integer)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  member   uuid;
  ev       event%ROWTYPE;
  settings event_streak%ROWTYPE;
  today    date;
  mine     event_streak_day%ROWTYPE;
  before_day date;
  earlier  integer;
BEGIN
  SELECT n.id INTO member FROM enrollment n JOIN player p ON p.id = n.player_id AND p.status = 'active'
  WHERE n.event_id = target_event AND n.player_id = app_player_id() AND n.status = 'active';
  IF member IS NULL THEN
    RETURN;
  END IF;
  SELECT * INTO ev FROM event e WHERE e.id = target_event;
  SELECT * INTO settings FROM event_streak s WHERE s.event_id = ev.id;
  today := event_day(now(), ev);
  SELECT * INTO mine FROM event_streak_day d WHERE d.enrollment_id = member AND d.day = today;
  IF mine.enrollment_id IS NULL THEN
    before_day := prev_open_day(ev, settings, today);
    SELECT d.days INTO earlier FROM event_streak_day d WHERE d.enrollment_id = member AND d.day = before_day;
  END IF;
  RETURN QUERY SELECT coalesce(settings.enabled, false) AND event_multi_day(ev)
                        AND event_status_now(ev.status, ev.starts_at, ev.ends_at) = 'live',
                      coalesce(mine.days, earlier, 0), mine.enrollment_id IS NOT NULL,
                      streak_day_closed(settings, today), settings.bonus_points;
END $$;
REVOKE ALL ON FUNCTION own_event_streak(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION own_event_streak(uuid) TO questify_app;

-- The streak bonus the calling player's own completion paid: its points and the streak day. No row for another
-- player's completion or one that paid none. The same on a replay.
CREATE FUNCTION own_streak_bonus(completion bigint) RETURNS TABLE (points integer, days integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT l.score_delta::integer, d.days
  FROM event_streak_day d
  JOIN enrollment n ON n.id = d.enrollment_id AND n.player_id = app_player_id()
  JOIN ledger_entry l ON l.id = d.entry_id
  WHERE d.completion_id = completion
$$;
REVOKE ALL ON FUNCTION own_streak_bonus(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION own_streak_bonus(bigint) TO questify_app;

-- ================================================================ the daily streak's reads (ADR-297, ADR-298)
-- The run of consecutive Questify days ending today, else ending yesterday (alive until today ends), else 0. Read time,
-- never stored: a day row arriving late (a completion committing across 04:00) still joins the run. Internal.
CREATE FUNCTION daily_streak_length(who uuid) RETURNS integer
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  WITH counted AS (
    SELECT d.day, row_number() OVER (ORDER BY d.day DESC)::integer AS k
    FROM questify_streak_day d WHERE d.player_id = who AND d.day <= questify_day(now())
  ), head AS (
    SELECT c.day FROM counted c WHERE c.k = 1 AND c.day >= questify_day(now()) - 1
  )
  SELECT count(*)::integer FROM counted c, head h WHERE c.day = h.day - (c.k - 1)
$$;
REVOKE ALL ON FUNCTION daily_streak_length(uuid) FROM PUBLIC;

-- Whether the switch is on and a milestone at or under the player's length is unpaid. Internal.
CREATE FUNCTION streak_due(who uuid) RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT daily_streak_on() AND EXISTS (
    SELECT 1 FROM questify_streak_milestone m
    WHERE m.days <= daily_streak_length(who)
      AND NOT EXISTS (SELECT 1 FROM questify_streak_reward r WHERE r.player_id = who AND r.days = m.days))
$$;
REVOKE ALL ON FUNCTION streak_due(uuid) FROM PUBLIC;

-- The daily streak as its owner sees it: the length, whether today is counted, and the next unpaid milestone above the
-- length; NULL while the switch is off. Internal.
CREATE FUNCTION daily_streak_of(who uuid) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN daily_streak_on() THEN jsonb_build_object(
    'days', s.days,
    'today', EXISTS (SELECT 1 FROM questify_streak_day d WHERE d.player_id = who AND d.day = questify_day(now())),
    'next', (SELECT jsonb_build_object('days', m.days, 'xp', m.xp) FROM questify_streak_milestone m
             WHERE m.days > s.days
               AND NOT EXISTS (SELECT 1 FROM questify_streak_reward r WHERE r.player_id = who AND r.days = m.days)
             ORDER BY m.days LIMIT 1)) END
  FROM (SELECT daily_streak_length(who) AS days) s
$$;
REVOKE ALL ON FUNCTION daily_streak_of(uuid) FROM PUBLIC;

-- The caller's daily streak (GET /v1/me); NULL while the switch is off or for a caller who is not an active player.
-- Shown to its owner only: no public profile, ranking or organizer read carries it.
CREATE FUNCTION own_daily_streak() RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT daily_streak_of(me.id) FROM (SELECT profile_player() AS id) me WHERE me.id IS NOT NULL
$$;
REVOKE ALL ON FUNCTION own_daily_streak() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION own_daily_streak() TO questify_app;

-- ================================================================ the sync pays the milestones (ADR-298)
-- As 0067, plus the daily streak's milestones after the Questify quests and before the gems, under the same locks
-- (player KEY SHARE, then player_xp FOR UPDATE): every milestone at or under the length with no reward row gets one
-- (ON CONFLICT DO NOTHING), an xp_entry (streak) and xp_apply, so levels, level items and the level's gems follow as
-- for any XP. Each milestone pays once ever. Nothing while the switch is off. The answer gains `dailyStreak` (NULL when
-- off) with the milestones this call paid; `levelUp` covers their XP. The unlocked pre-check gains streak_due.
CREATE OR REPLACE FUNCTION questify_sync() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
 who     uuid;
 tiers   jsonb;
 quest   record;
 mile    record;
 award   bigint;
 reward  bigint;
 entry   bigint;
 paid    jsonb := '[]'::jsonb;
 streaks jsonb := '[]'::jsonb;
 entries bigint[] := '{}';
 amount  record;
 earned  bigint;
 balance bigint;
BEGIN
 SELECT p.id INTO who FROM player p WHERE p.id = app_player_id() AND p.status = 'active';
 IF who IS NULL THEN RAISE EXCEPTION 'active player required' USING ERRCODE = 'PI401'; END IF;
 IF NOT EXISTS (SELECT 1 FROM achievements_due(who)) AND NOT EXISTS (SELECT 1 FROM questify_due(who))
    AND NOT gems_due(who) AND NOT streak_due(who) THEN
  RETURN jsonb_build_object('achievements', '[]'::jsonb, 'quests', '[]'::jsonb, 'levelUp', NULL,
   'gems', jsonb_build_object('earned', 0, 'balance', (SELECT x.gems FROM player_xp x WHERE x.player_id = who)),
   'dailyStreak', daily_streak_of(who) || CASE WHEN daily_streak_on() THEN jsonb_build_object('rewards', '[]'::jsonb) END);
 END IF;
 SELECT p.id INTO who FROM player p WHERE p.id = who AND p.status = 'active' FOR KEY SHARE;
 IF who IS NULL THEN RAISE EXCEPTION 'active player required' USING ERRCODE = 'PI401'; END IF;
 PERFORM 1 FROM player_xp x WHERE x.player_id = who FOR UPDATE;
 WITH written AS (
  INSERT INTO achievement_earned (player_id, achievement_id, tier)
  SELECT who, d.achievement_id, d.tier FROM achievements_due(who) d
  ON CONFLICT DO NOTHING
  RETURNING achievement_id, tier
 )
 SELECT coalesce(jsonb_agg(jsonb_build_object('id', w.achievement_id, 'tier', w.tier)
  ORDER BY a.position, array_position(ARRAY['bronze', 'silver', 'gold'], w.tier)), '[]'::jsonb)
 INTO tiers FROM written w JOIN achievement a ON a.id = w.achievement_id;
 FOR quest IN
  SELECT q.id, q.title_ar, q.title_en, q.xp
  FROM questify_due(who) d JOIN questify_quest q ON q.id = d.quest_id LEFT JOIN questify_campaign c ON c.id = q.campaign_id
  ORDER BY c.starts_at NULLS FIRST, q.position, q.id
 LOOP
  INSERT INTO questify_award (player_id, quest_id) VALUES (who, quest.id) ON CONFLICT DO NOTHING RETURNING id INTO award;
  CONTINUE WHEN award IS NULL;
  INSERT INTO xp_entry (player_id, delta, source, questify_award_id) VALUES (who, quest.xp, 'questify', award)
  RETURNING id INTO entry;
  PERFORM xp_apply(who, entry, quest.xp);
  entries := entries || entry;
  paid := paid || jsonb_build_array(jsonb_build_object('id', quest.id,
   'title', jsonb_build_object('ar', quest.title_ar, 'en', quest.title_en), 'xp', quest.xp));
 END LOOP;
 IF daily_streak_on() THEN
  FOR mile IN
   SELECT m.days, m.xp FROM questify_streak_milestone m
   WHERE m.days <= daily_streak_length(who)
     AND NOT EXISTS (SELECT 1 FROM questify_streak_reward r WHERE r.player_id = who AND r.days = m.days)
   ORDER BY m.days
  LOOP
   INSERT INTO questify_streak_reward (player_id, days, xp) VALUES (who, mile.days, mile.xp)
   ON CONFLICT DO NOTHING RETURNING id INTO reward;
   CONTINUE WHEN reward IS NULL;
   INSERT INTO xp_entry (player_id, delta, source, streak_reward_id) VALUES (who, mile.xp, 'streak', reward)
   RETURNING id INTO entry;
   PERFORM xp_apply(who, entry, mile.xp);
   entries := entries || entry;
   streaks := streaks || jsonb_build_array(jsonb_build_object('days', mile.days, 'xp', mile.xp));
  END LOOP;
 END IF;
 SELECT * INTO amount FROM gem_amounts();
 WITH due AS (
  SELECT 'level' AS source, r.level AS source_level, NULL::text AS achievement_id, NULL::text AS tier,
         NULL::bigint AS award_id, amount.level_up AS delta, r.reached_at AS at
  FROM level_reached r
  WHERE r.player_id = who
    AND NOT EXISTS (SELECT 1 FROM gem_entry g WHERE g.player_id = who AND g.source_level = r.level)
  UNION ALL
  SELECT 'achievement', NULL, e.achievement_id, e.tier, NULL,
         CASE e.tier WHEN 'bronze' THEN amount.bronze WHEN 'silver' THEN amount.silver ELSE amount.gold END,
         e.earned_at
  FROM achievement_earned e
  WHERE e.player_id = who
    AND NOT EXISTS (SELECT 1 FROM gem_entry g WHERE g.player_id = who AND g.achievement_id = e.achievement_id
                    AND g.tier = e.tier)
  UNION ALL
  SELECT 'questify', NULL, NULL, NULL, a.id, q.gems, a.earned_at
  FROM questify_award a JOIN questify_quest q ON q.id = a.quest_id
  WHERE a.player_id = who AND q.gems > 0 AND NOT EXISTS (SELECT 1 FROM gem_entry g WHERE g.questify_award_id = a.id)
 ), written AS (
  INSERT INTO gem_entry (player_id, delta, source, source_level, achievement_id, tier, questify_award_id)
  SELECT who, d.delta, d.source, d.source_level, d.achievement_id, d.tier, d.award_id FROM due d
  ORDER BY d.at, d.source, d.source_level, d.achievement_id, array_position(ARRAY['bronze', 'silver', 'gold'], d.tier),
           d.award_id
  ON CONFLICT DO NOTHING
  RETURNING delta
 )
 SELECT coalesce(sum(w.delta), 0) INTO earned FROM written w;
 IF earned > 0 THEN
  UPDATE player_xp x SET gems = x.gems + earned WHERE x.player_id = who RETURNING x.gems INTO balance;
 ELSE
  SELECT x.gems INTO balance FROM player_xp x WHERE x.player_id = who;
 END IF;
 RETURN jsonb_build_object('achievements', tiers, 'quests', paid, 'levelUp', questify_level_up(who, entries),
  'gems', jsonb_build_object('earned', earned, 'balance', balance),
  'dailyStreak', daily_streak_of(who) || CASE WHEN daily_streak_on() THEN jsonb_build_object('rewards', streaks) END);
END $$;
REVOKE ALL ON FUNCTION questify_sync() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION questify_sync() TO questify_app;

-- ================================================================ the kind in the readers (ADR-296)
-- As 0062, with the streak bonus removable on its own. Removing it never unpicks the day (the day row stays, so it is
-- never paid again for that day); removing the quest line leaves the day and the bonus. A removal of either writes no
-- XP for the bonus (xp_reverse finds no credit for it).
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
  IF credit.kind NOT IN ('quest', 'award', 'welcome', 'bonus', 'community', 'first_bonus', 'streak') THEN
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
                            quest_id, category_id, community_step_id, actor, staff_user_id, reverses, boost_id)
  VALUES (ev.organizer_id, ev.id, enrolled.id, 'removal', -take_s, -take_b, credit.completion_id, credit.quest_id,
          credit.category_id, credit.community_step_id, 'staff', me, credit.id, credit.boost_id)
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

-- As 0062, with the streak bonus (the quest entry before it is refused first).
CREATE OR REPLACE FUNCTION ledger_operator_play_guard() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NOT NEW.rehearsal AND NEW.kind IN ('quest', 'redeem', 'award', 'bonus', 'community', 'first_bonus', 'streak')
     AND EXISTS (
    SELECT 1 FROM enrollment e JOIN staff_assignment sa ON sa.event_id = e.event_id AND sa.player_id = e.player_id
    WHERE e.id = NEW.enrollment_id AND NOT sa.can_play) THEN
    RAISE EXCEPTION 'operators do not play the event they staff' USING ERRCODE = 'QP403';
  END IF;
  RETURN NEW;
END $$;

-- As 0062: a points goal counts the streak bonus as it counts the category and first-N bonuses.
CREATE OR REPLACE FUNCTION community_read_slice(goal community_goal, close_at timestamptz, lower timestamptz, upper timestamptz,
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
      AND l.kind IN ('quest', 'bonus', 'first_bonus', 'streak', 'removal')
      AND (l.kind <> 'removal' OR (NOT r.rehearsal AND r.created_at >= goal.starts_at AND r.created_at < close_at))
      AND CASE WHEN l.kind = 'removal' THEN r.kind ELSE l.kind END
          = ANY (CASE WHEN goal.measure = 'points' THEN ARRAY['quest', 'bonus', 'first_bonus', 'streak']
                      ELSE ARRAY['quest'] END)
      AND (goal.measure = 'points' OR (goal.quest_id IS NULL AND goal.category_id IS NULL)
           OR q.id = goal.quest_id OR q.category_id = goal.category_id)
  )
  SELECT c.enrollment_id, min(c.created_at) FILTER (WHERE c.contributes),
         coalesce(sum(c.delta) FILTER (WHERE c.created_at < split), 0)::bigint,
         coalesce(sum(c.delta) FILTER (WHERE c.created_at >= split), 0)::bigint
  FROM counted c
  GROUP BY c.enrollment_id
$$;

-- As 0062, plus `streak_days` on a streak bonus line ("Streak bonus, day N"). The output changed: DROP and CREATE.
DROP FUNCTION member_activity(uuid, bigint, integer);
CREATE FUNCTION member_activity(target uuid, before_id bigint, page integer)
  RETURNS TABLE (id bigint, at timestamptz, kind text, score_delta bigint, balance_delta bigint, quest_id uuid,
                 title_ar text, title_en text, multiplier integer, bonus_slots integer, streak_days integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH me AS (
    SELECT n.id FROM enrollment n JOIN player p ON p.id = n.player_id
    WHERE n.event_id = target AND n.player_id = app_player_id() AND n.status = 'active' AND p.status = 'active'
  )
  SELECT l.id, l.created_at, l.kind, l.score_delta, l.balance_delta, l.quest_id,
         coalesce(q.title_ar, r.name_ar, k.name_ar, i.name_ar, g.name_ar, cg.title_ar),
         coalesce(q.title_en, r.name_en, k.name_en, i.name_en, g.name_en, cg.title_en),
         bo.multiplier,
         CASE WHEN l.kind = 'first_bonus' THEN fb.slots END,
         sd.days
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
  LEFT JOIN boost bo ON bo.id = l.boost_id
  LEFT JOIN quest_first_bonus fb ON fb.quest_id = l.quest_id AND l.kind = 'first_bonus'
  LEFT JOIN event_streak_day sd ON sd.entry_id = l.id AND l.kind = 'streak'
  WHERE before_id IS NULL OR l.id < before_id
  ORDER BY l.id DESC
  LIMIT least(greatest(coalesce(page, 25), 1), 100)
$$;
REVOKE ALL ON FUNCTION member_activity(uuid, bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION member_activity(uuid, bigint, integer) TO questify_app;

-- As 0062, with the streak bonus removable on its own and `streak_days` on its line. The output changed: DROP and
-- CREATE.
DROP FUNCTION member_ledger(uuid, uuid, bigint, integer);
CREATE FUNCTION member_ledger(target_event uuid, target_enrollment uuid, before_id bigint, page integer)
  RETURNS TABLE (id bigint, at timestamptz, kind text, score_delta bigint, balance_delta bigint, quest_id uuid,
                 title_ar text, title_en text, reason text, by_operator text, by_staff text, reverses bigint,
                 removable boolean, removed boolean, multiplier integer, bonus_slots integer, bonus_place integer,
                 streak_days integer)
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
         l.kind IN ('quest', 'award', 'welcome', 'bonus', 'community', 'first_bonus', 'streak')
           AND NOT EXISTS (SELECT 1 FROM ledger_entry x WHERE x.reverses = l.id),
         EXISTS (SELECT 1 FROM ledger_entry x WHERE x.reverses = l.id),
         bo.multiplier,
         CASE WHEN l.kind = 'first_bonus'
                   OR (l.kind = 'quest' AND NOT EXISTS (SELECT 1 FROM ledger_entry x WHERE x.reverses = fs.entry_id))
              THEN fb.slots END,
         CASE WHEN l.kind = 'first_bonus' THEN first_bonus_place(fs) END,
         sd.days
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
  LEFT JOIN boost bo ON bo.id = l.boost_id
  LEFT JOIN quest_bonus_slot fs ON fs.completion_id = l.completion_id AND l.kind IN ('quest', 'first_bonus')
  LEFT JOIN quest_first_bonus fb ON fb.quest_id = fs.quest_id
  LEFT JOIN event_streak_day sd ON sd.entry_id = l.id AND l.kind = 'streak'
  LEFT JOIN player op ON op.id = l.operator_id
  LEFT JOIN staff_user su ON su.id = l.staff_user_id
  WHERE l.event_id = ev.id AND l.enrollment_id = target_enrollment AND (before_id IS NULL OR l.id < before_id)
  ORDER BY l.id DESC
  LIMIT least(greatest(coalesce(page, 50), 1), 100);
END $$;
REVOKE ALL ON FUNCTION member_ledger(uuid, uuid, bigint, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION member_ledger(uuid, uuid, bigint, integer) TO questify_app;

-- As 0062, with a quest's `earned` leaving out the streak bonus and its removal: the bonus carries the paying quest's
-- id, but it is the day's, not the quest's (plan review MINOR-7).
DROP FUNCTION member_event_quests(uuid);
CREATE FUNCTION member_event_quests(target uuid)
  RETURNS TABLE (category_id uuid, category_name_ar text, category_name_en text, category_position integer,
                 quest_id uuid, title_ar text, title_en text, description_ar text, description_en text,
                 type text, points integer, repeat_cap integer, opens_at timestamptz, closes_at timestamptz,
                 quest_position integer, done integer, earned bigint, verification text[],
                 order_mode text, category_opens_at timestamptz, unlock_after uuid, unlock_after_name_ar text,
                 unlock_after_name_en text, completion_bonus integer, bonus_earned bigint, bonus_settled boolean,
                 lock text, steps_done integer, steps_needed integer, refresh text, resets_at timestamptz,
                 item_ar text, item_en text, bonus_item_ar text, bonus_item_en text, place_lat numeric,
                 place_lng numeric, place_radius_m integer, daily_cap integer, met_today integer,
                 game_left integer, game_passed boolean, community_lock jsonb, category_community_lock jsonb,
                 flash_closes_at timestamptz, boost jsonb, first_bonus_points integer, first_bonus_slots integer,
                 first_bonus_place integer)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH me AS (
    SELECT n.id, n AS enrolled FROM enrollment n JOIN player p ON p.id = n.player_id
    WHERE n.event_id = target AND n.player_id = app_player_id() AND n.status = 'active' AND p.status = 'active'
  )
  SELECT c.id, c.name_ar, c.name_en, c.position, q.id, q.title_ar, q.title_en, q.description_ar, q.description_en,
         q.type, q.points, q.repeat_cap, q.opens_at, q.closes_at, q.position,
         period_count(me.id, q)
           + (SELECT count(*)::int FROM quiz_attempt a
              WHERE a.enrollment_id = me.id AND a.quest_id = q.id AND a.status = 'finished' AND a.completion_id IS NULL)
           + CASE WHEN q.type = 'game' AND period_count(me.id, q) = 0 AND game_spent(me.id, q) THEN 1 ELSE 0 END,
         (SELECT coalesce(sum(l.score_delta), 0)::bigint FROM ledger_entry l
          LEFT JOIN ledger_entry rv ON l.kind = 'removal' AND rv.id = l.reverses
          WHERE l.enrollment_id = me.id AND l.quest_id = q.id AND l.kind <> 'streak'
            AND rv.kind IS DISTINCT FROM 'streak'),
         q.verification,
         c.order_mode, c.opens_at, c.unlock_after,
         CASE WHEN sees_category(me.id, u) THEN u.name_ar END,
         CASE WHEN sees_category(me.id, u) THEN u.name_en END,
         c.completion_bonus,
         (SELECT coalesce(sum(l.score_delta), 0)::bigint FROM ledger_entry l
          WHERE l.enrollment_id = me.id AND l.category_id = c.id),
         EXISTS (SELECT 1 FROM category_bonus b
                 WHERE b.enrollment_id = me.id AND b.category_id = c.id
                   AND b.period_start >= category_period_start(c, e)),
         CASE WHEN k.step IS NOT NULL THEN 'community_locked' ELSE category_rule_lock(q, me.id) END,
         CASE WHEN q.type = 'passport' THEN (SELECT count(*)::int FROM passport_stamp p
                                             WHERE p.enrollment_id = me.id AND p.quest_id = q.id) END,
         CASE WHEN q.type = 'passport' THEN (q.type_config ->> 'needed')::int END,
         c.refresh,
         category_resets_at(c, e),
         CASE WHEN qi.units_out < qi.stock_total AND NOT EXISTS (
                SELECT 1 FROM quest_completion qc WHERE qc.enrollment_id = me.id AND qc.quest_id = q.id)
              THEN qi.name_ar END,
         CASE WHEN qi.units_out < qi.stock_total AND NOT EXISTS (
                SELECT 1 FROM quest_completion qc WHERE qc.enrollment_id = me.id AND qc.quest_id = q.id)
              THEN qi.name_en END,
         CASE WHEN ci.units_out < ci.stock_total THEN ci.name_ar END,
         CASE WHEN ci.units_out < ci.stock_total THEN ci.name_en END,
         CASE WHEN q.type = 'location' THEN q.place_lat END,
         CASE WHEN q.type = 'location' THEN q.place_lng END,
         CASE WHEN q.type = 'location' THEN q.place_radius_m END,
         CASE WHEN q.type = 'meet' THEN (q.type_config ->> 'dailyCap')::int END,
         CASE WHEN q.type = 'meet' THEN meet_today(me.id, q) END,
         CASE WHEN q.type = 'game' THEN game_left(me.id, q) END,
         CASE WHEN q.type = 'game' THEN (SELECT a.passed FROM game_attempts(me.id, q) a) END,
         community_lock_note(k.step),
         community_lock_note(k.category_step),
         CASE WHEN q.flash THEN q.closes_at END,
         CASE WHEN (cb.running).id IS NOT NULL
              THEN jsonb_build_object('boostId', (cb.running).id, 'multiplier', (cb.running).multiplier,
                                      'endsAt', (cb.running).ends_at) END,
         fb.points, fb.slots,
         CASE WHEN fs.quest_id IS NOT NULL THEN first_bonus_place(fs) END
  FROM me
  JOIN event e ON e.id = target
  JOIN category c ON c.event_id = target AND sees_category(me.id, c)
  CROSS JOIN LATERAL (SELECT boost_in_force(c.id, me.enrolled, now()) AS running) cb
  LEFT JOIN category u ON u.id = c.unlock_after
  JOIN quest q ON q.category_id = c.id AND q.event_id = target AND q.visible AND flash_shown(q)
  CROSS JOIN LATERAL (SELECT category_community_lock(c.id) AS category_step) kc
  CROSS JOIN LATERAL (SELECT coalesce(
                        (SELECT s.id FROM community_step s
                         WHERE s.unlock_quest_id = q.id
                           AND NOT EXISTS (SELECT 1 FROM community_reach r WHERE r.step_id = s.id)),
                        kc.category_step) AS step, kc.category_step) k
  LEFT JOIN quest_item qi ON qi.id = q.item_id AND qi.status = 'active'
  LEFT JOIN quest_item ci ON ci.id = c.item_id AND ci.status = 'active'
  LEFT JOIN quest_first_bonus fb ON fb.quest_id = q.id
  LEFT JOIN quest_bonus_slot fs ON fs.quest_id = q.id AND fs.enrollment_id = me.id
  ORDER BY c.position, c.id, q.position, q.id
$$;
REVOKE ALL ON FUNCTION member_event_quests(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION member_event_quests(uuid) TO questify_app;
