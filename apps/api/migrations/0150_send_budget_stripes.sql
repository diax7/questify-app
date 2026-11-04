-- T-804b: the platform send budget without one held lock (ADR-690, ADR-692; plan
-- docs/plans/2026-11-04-t-804b-sign-in-rush.md section 2). Before, every player code, resend, contact code, contact
-- notice and deletion code took pg_advisory_xact_lock on ONE platform key and held it to the end of its sign-in
-- transaction: about 100 codes a second for the whole platform (Q-621).
--
-- Each channel's budget is now 16 stripes (a constant of take_send_budget, never data), each its own sliding window in
-- auth_throttle (same buckets, key sha256('questify.sms_platform.<i>') or sha256('questify.player_email_platform.<i>'))
-- with the share floor(cap / 16) + (i < cap mod 16 ? 1 : 0), so the shares sum to the cap exactly and the budget stays
-- exact and sliding. take_send_budget runs as one autocommit statement before the request's transaction: it try-locks
-- stripes from a random one, never waits, takes a unit from the first locked stripe under its share, and answers
-- taken, busy (no room found, and a stripe another request holds may still have room: retry) or spent (every stripe
-- full: read under its lock, or, for one another request holds, read without it). A unit is only ever inserted under
-- its stripe's lock, so an unlocked read can only make the answer "spent" a few milliseconds early (a held unit about
-- to be given back), never overspend. The lock lasts only for the function's own transaction.
--
-- It is VOLATILE and the API runs at READ COMMITTED: each query in it takes a new snapshot, taken after its try-lock,
-- so it sees every row a previous holder of that stripe committed (a STABLE function would count with the snapshot of
-- the calling statement, taken before the lock, and could overspend). A REPEATABLE READ or SERIALIZABLE caller would
-- keep its first snapshot and overspend, so the function refuses to run at any other level.
--
-- The cap and window are rows of platform_send_budget (Q-093's number is Dhia's: the seed keeps today's 5,000 SMS an
-- hour and 1,000 player emails a day; the RUNBOOK changes it with one owner UPDATE). Raising a cap is exact at once (a
-- share never shrinks when the cap grows). Lowering a cap or lengthening a window could leave some stripes above their
-- new share while others still have room, so the trigger below stamps changed_at, and for one window after that the
-- function settles: it takes all 16 locks (busy if any is held and the channel is below the cap, read without the
-- locks), counts the whole channel and takes only below the cap, still in a stripe under its share. After one window every row in it was taken under the new numbers.
--
-- Deploy: the window's rows of the old single keys are COPIED into the stripes (round robin, so each stripe holds at
-- most its share), not moved: an API instance of the previous release still running, or a rollback, still counts the
-- old key with its history. While both releases run, each counts only its own keys (RUNBOOK: deploy outside an event's
-- opening).
--
-- Deny by default: the table is readable by the API role only (no write: the number changes by an owner UPDATE), the
-- functions are revoked from PUBLIC by name and the budget function granted to questify_app only (outsider suite). No
-- personal data: the keys are hashes of fixed names.
SET LOCAL lock_timeout = '10s';

-- ================================================================ the budget as data (Q-093, Q-650)
CREATE TABLE platform_send_budget (
  channel        text PRIMARY KEY CHECK (channel IN ('phone', 'email')),
  cap            integer NOT NULL CHECK (cap >= 0),
  -- At most a day: sweepThrottle deletes rows older than a day, so a longer window would count rows already gone.
  window_seconds integer NOT NULL CHECK (window_seconds BETWEEN 1 AND 86400),
  -- When the cap was last lowered or the window lengthened; the budget settles for one window after it.
  changed_at     timestamptz NOT NULL DEFAULT '-infinity'
);
ALTER TABLE platform_send_budget ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_send_budget FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_send_budget_read ON platform_send_budget FOR SELECT TO questify_app USING (true);
REVOKE ALL ON platform_send_budget FROM PUBLIC;
GRANT SELECT ON platform_send_budget TO questify_app;

INSERT INTO platform_send_budget (channel, cap, window_seconds) VALUES
  ('phone', 5000, 3600),
  ('email', 1000, 86400);

CREATE FUNCTION platform_send_budget_settles() RETURNS trigger
  LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  NEW.changed_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION platform_send_budget_settles() FROM PUBLIC;

CREATE TRIGGER platform_send_budget_settles
  BEFORE UPDATE ON platform_send_budget
  FOR EACH ROW
  WHEN (NEW.cap < OLD.cap OR NEW.window_seconds > OLD.window_seconds)
  EXECUTE FUNCTION platform_send_budget_settles();

-- ================================================================ one unit, never waiting (ADR-690, ADR-692)
CREATE FUNCTION take_send_budget(p_channel text)
  RETURNS TABLE (outcome text, stripe integer, stripe_key bytea, taken_at text)
  LANGUAGE plpgsql VOLATILE SET search_path = public, pg_temp AS $$
DECLARE
  stripes CONSTANT integer := 16;
  v_bucket text;
  v_prefix text;
  v_cap integer;
  v_window interval;
  v_settling boolean;
  v_keys bytea[];
  v_first integer;
  v_i integer;
  v_share integer;
  v_used integer;
  v_busy boolean := false;
  v_locked boolean;
  v_at timestamptz;
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'take_send_budget: needs READ COMMITTED, got %', current_setting('transaction_isolation')
      USING ERRCODE = '25000';
  END IF;
  SELECT b.cap, make_interval(secs => b.window_seconds),
         b.changed_at > now() - make_interval(secs => b.window_seconds)
    INTO v_cap, v_window, v_settling
    FROM platform_send_budget b WHERE b.channel = p_channel;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'take_send_budget: unknown channel %', p_channel USING ERRCODE = '22023';
  END IF;
  IF p_channel = 'phone' THEN
    v_bucket := 'sms_platform';
    v_prefix := 'questify.sms_platform.';
  ELSE
    v_bucket := 'player_email_platform';
    v_prefix := 'questify.player_email_platform.';
  END IF;
  SELECT array_agg(sha256(convert_to(v_prefix || i, 'UTF8')) ORDER BY i) INTO v_keys
    FROM generate_series(0, stripes - 1) AS i;
  v_first := floor(random() * stripes)::integer;

  IF v_settling THEN
    FOR v_i IN 0 .. stripes - 1 LOOP
      IF NOT pg_try_advisory_xact_lock(('x' || encode(substr(v_keys[v_i + 1], 1, 8), 'hex'))::bit(64)::bigint) THEN
        v_busy := true;
        EXIT;
      END IF;
    END LOOP;
    SELECT count(*) INTO v_used FROM auth_throttle
      WHERE bucket = v_bucket AND key = ANY (v_keys) AND at > now() - v_window;
    IF v_busy AND v_used < v_cap THEN
      RETURN QUERY SELECT 'busy'::text, NULL::integer, NULL::bytea, NULL::text;
      RETURN;
    END IF;
    IF v_used >= v_cap THEN
      RETURN QUERY SELECT 'spent'::text, NULL::integer, NULL::bytea, NULL::text;
      RETURN;
    END IF;
  END IF;

  FOR k IN 0 .. stripes - 1 LOOP
    v_i := (v_first + k) % stripes;
    v_share := v_cap / stripes + CASE WHEN v_i < v_cap % stripes THEN 1 ELSE 0 END;
    CONTINUE WHEN v_share = 0;
    v_locked := v_settling
      OR pg_try_advisory_xact_lock(('x' || encode(substr(v_keys[v_i + 1], 1, 8), 'hex'))::bit(64)::bigint);
    SELECT count(*) INTO v_used FROM auth_throttle
      WHERE bucket = v_bucket AND key = v_keys[v_i + 1] AND at > now() - v_window;
    IF NOT v_locked THEN
      -- Held by another request: busy only if it may still have room, so a crowd at a spent budget hears "spent".
      v_busy := v_busy OR v_used < v_share;
      CONTINUE;
    END IF;
    IF v_used < v_share THEN
      INSERT INTO auth_throttle (bucket, key, at) VALUES (v_bucket, v_keys[v_i + 1], clock_timestamp())
        RETURNING at INTO v_at;
      RETURN QUERY SELECT 'taken'::text, v_i, v_keys[v_i + 1], v_at::text;
      RETURN;
    END IF;
  END LOOP;
  RETURN QUERY SELECT CASE WHEN v_busy THEN 'busy' ELSE 'spent' END, NULL::integer, NULL::bytea, NULL::text;
END;
$$;
REVOKE ALL ON FUNCTION take_send_budget(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION take_send_budget(text) TO questify_app;

-- ================================================================ the old single keys' history, copied
INSERT INTO auth_throttle (bucket, key, at)
SELECT t.bucket,
       sha256(convert_to(
         CASE t.bucket WHEN 'sms_platform' THEN 'questify.sms_platform.' ELSE 'questify.player_email_platform.' END
           || ((row_number() OVER (PARTITION BY t.bucket ORDER BY t.at) - 1) % 16), 'UTF8')),
       t.at
FROM auth_throttle t
JOIN platform_send_budget b
  ON (b.channel, t.bucket) IN (('phone', 'sms_platform'), ('email', 'player_email_platform'))
WHERE t.key = sha256(convert_to(
        CASE t.bucket WHEN 'sms_platform' THEN 'questify.sms_platform' ELSE 'questify.player_email_platform' END,
        'UTF8'))
  AND t.at > now() - make_interval(secs => b.window_seconds);
