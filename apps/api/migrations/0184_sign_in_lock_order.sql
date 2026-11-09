-- The player sign-in's lock order (plan docs/plans/2026-11-09-sign-in-lock-order.md, plan review 86; FOLLOWUPS T-710 and
-- T-810c; ADR-561, ADR-711, ADR-712; ASVS V7.4.1, V7.5.2). Three fixes, no new table, no new grant:
--
-- 1. The reviewer flag (start_player_challenge, start_deletion_challenge) is read after the review_demo row is locked
--    FOR SHARE, for the reviewer number only, so a code asked while Prepare, Close or a number change commits is flagged
--    from the committed row and no SMS goes out while the window is open.
-- 2. The sweep (sweep_player_sign_in) takes a family's device row before any of that family's rows and never waits for a
--    device row or a code (SKIP LOCKED), so it can no longer deadlock with a rotation, an end or an erasure; it runs in
--    bounded batches, and three indexes keep each batch short at 100,000 players (see that section).
-- 3. end_other_player_devices locks the caller's own device row with the others, in id order, and re-reads it, so an
--    ended device cannot end the others and the fresh check reads the row under the lock.
--
-- Every restated function is copied from its latest definition (named at each) with the smallest change, keeps its owner
-- and grants (restated next to it), and is closed to PUBLIC. 0183 and earlier untouched; 0156 stays reserved.
SET LOCAL lock_timeout = '10s';

-- ================================================================ the reviewer flag under the row's lock (T-710)
-- As 0144:182, with one change: the flag is computed after the review_demo row is locked FOR SHARE, in its own statement.
-- Only the reviewer number takes the lock (any other sign-in matches no row and locks nothing: no hot row). The match is
-- on `contact`, which Prepare never changes (RD409 `stale`), not on `contact_key`, which it may rotate.
-- This depends on READ COMMITTED (the API's default): after waiting for a Prepare, Close or number change, the locked row
-- is re-checked against `contact` as committed, and the flag's statement takes a new snapshot that sees the commit.
-- Under REPEATABLE READ the lock would fail with 40001 instead and the flag would read the old snapshot.
CREATE OR REPLACE FUNCTION start_player_challenge(challenge uuid, token bytea, method text, contact_value text, key bytea,
                                                  code bytea, terms text, privacy text, fp bytea) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  flagged boolean := false;
BEGIN
  IF method = 'phone' THEN
    PERFORM 1 FROM review_demo d WHERE d.contact = contact_value FOR SHARE;
    flagged := review_demo_open(key);
  END IF;
  UPDATE player_login_challenge SET cancelled_at = now()
  WHERE contact_key = key AND cancelled_at IS NULL;
  INSERT INTO player_login_challenge (id, token_hash, channel, contact, contact_key, code_hash, expires_at,
                                      terms_version, privacy_version, contact_fp, reviewer)
  VALUES (challenge, token, method, contact_value, key, code, now() + interval '5 minutes', terms, privacy, fp,
          flagged);
  RETURN flagged;
END $$;
REVOKE ALL ON FUNCTION start_player_challenge(uuid, bytea, text, text, bytea, bytea, text, text, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION start_player_challenge(uuid, bytea, text, text, bytea, bytea, text, text, bytea)
  TO questify_app;

-- As 0144:490, with the same change after the channel check (and the same READ COMMITTED reliance).
CREATE OR REPLACE FUNCTION start_deletion_challenge(challenge uuid, token bytea, method text, contact_value text,
                                                    key bytea, code bytea) RETURNS TABLE (known boolean, reviewer boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  owner   uuid;
  flagged boolean := false;
BEGIN
  IF method IS NULL OR method NOT IN ('phone', 'email') THEN
    RAISE EXCEPTION 'unknown channel' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF method = 'phone' THEN
    PERFORM 1 FROM review_demo d WHERE d.contact = contact_value FOR SHARE;
    flagged := review_demo_open(key);
  END IF;
  DELETE FROM player_deletion_challenge
  WHERE greatest(expires_at, coalesce(deletion_expires_at, expires_at)) < now() - interval '1 hour'
     OR (contact_key = key AND deletion_hash IS NULL);
  SELECT p.id INTO owner FROM player_contact pc JOIN player p ON p.id = pc.player_id
  WHERE p.status IN ('active', 'banned')
    AND ((method = 'phone' AND pc.phone_e164 = contact_value) OR (method = 'email' AND pc.email = contact_value));
  INSERT INTO player_deletion_challenge (id, token_hash, player_id, contact_key, code_hash, expires_at, reviewer)
  VALUES (challenge, token, owner, key, code, now() + interval '5 minutes', flagged);
  RETURN QUERY SELECT owner IS NOT NULL, flagged;
END $$;
REVOKE ALL ON FUNCTION start_deletion_challenge(uuid, bytea, text, text, bytea, bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION start_deletion_challenge(uuid, bytea, text, text, bytea, bytea) TO questify_app;

-- ================================================================ the sweep: device rows first, never waiting (T-810c)
-- The old-row scans and the replaced_by foreign key's check need indexes at 100,000 players (about 5 million used
-- refresh rows and 5 million sessions in steady state; test/perf/sign-in-sweep-timing.int.test.ts). Without them 0155's
-- sweep reads all of player_refresh once per deleted row for the foreign key (0.6 s a row there), far past the API's 5 s
-- statement timeout, so it never finishes. Each index is the
-- exact expression the sweep compares: LEAST ignores NULLs and expires_at is never NULL, so it equals 0155's
-- "revoked before, or used before, or expired before" tests.
-- Built inside the migration's transaction, not CONCURRENTLY: the tables are small before launch. The build holds a
-- SHARE lock (sign-ins and rotations wait for it, well under a second at today's size).
CREATE INDEX player_refresh_sweep_idx ON player_refresh (least(revoked_at, used_at, expires_at));
CREATE INDEX player_refresh_replaced_by_idx ON player_refresh (replaced_by) WHERE replaced_by IS NOT NULL;
CREATE INDEX player_session_sweep_idx ON player_session (least(revoked_at, expires_at));
-- Sessions with no family (none expected): their own small index, so finding none reads nothing.
CREATE INDEX player_session_sweep_orphan_idx ON player_session (least(revoked_at, expires_at)) WHERE refresh_family IS NULL;
CREATE INDEX player_sign_in_device_ended_idx ON player_sign_in_device (ended_at) WHERE ended_at IS NOT NULL;

-- As 0155:283, made PL/pgSQL (rules: a definer on a request path), in bounded batches, and in the lock order of ADR-712:
-- a family's device row before any of its rows. One call is one short transaction: it takes at most 500 families that
-- have something old (an old refresh row, session or re-authentication code, or a device row ended more than 7 days
-- ago) and at most 1,000 old codes of each other kind, and answers how many rows it removed; the API calls it again
-- until a call removes nothing or its time budget is spent (players/sign-in.ts, sweepIfDue).
-- It never waits for a device row or a code (SKIP LOCKED): a row another call holds is left for a later call. A reset or
-- ban holds a login code and then waits for device rows, and erasure holds device rows and then deletes codes, so a
-- sweep waiting on either could close a cycle. It then touches only the rows of the families whose device row it holds
-- (nobody else can hold those, ADR-712) and of families with no device row (none expected since 0155's backfill; a
-- safety net, with sessions that have no family). The order of the device locks does not matter: it never waits.
-- A device row is removed when it ended more than 7 days ago or its family has no refresh row left.
DROP FUNCTION sweep_player_sign_in();
CREATE FUNCTION sweep_player_sign_in() RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  cut      timestamptz := now() - interval '7 days';
  code_cut timestamptz := now() - interval '1 hour';
  seen     uuid[];
  held     uuid[];
  swept    uuid[];
  found    integer;
  n        integer := 0;
BEGIN
  DELETE FROM player_login_challenge WHERE id IN (
    SELECT l.id FROM player_login_challenge l
    WHERE greatest(l.expires_at, coalesce(l.signup_expires_at, l.expires_at)) < code_cut
    LIMIT 1000 FOR UPDATE SKIP LOCKED);
  GET DIAGNOSTICS found = ROW_COUNT;
  n := n + found;
  DELETE FROM player_contact_challenge WHERE id IN (
    SELECT c.id FROM player_contact_challenge c WHERE c.expires_at < code_cut LIMIT 1000 FOR UPDATE SKIP LOCKED);
  GET DIAGNOSTICS found = ROW_COUNT;
  n := n + found;
  -- Sessions that never had a family (before 0013): no device row to take.
  DELETE FROM player_session WHERE id IN (
    SELECT s.id FROM player_session s
    WHERE least(s.revoked_at, s.expires_at) < cut AND s.refresh_family IS NULL
    LIMIT 1000 FOR UPDATE SKIP LOCKED);
  GET DIAGNOSTICS found = ROW_COUNT;
  n := n + found;
  SELECT coalesce(array_agg(DISTINCT w.family), '{}') INTO seen FROM (
    (SELECT r.family FROM player_refresh r WHERE least(r.revoked_at, r.used_at, r.expires_at) < cut LIMIT 500)
    UNION ALL
    (SELECT s.refresh_family FROM player_session s
     WHERE least(s.revoked_at, s.expires_at) < cut AND s.refresh_family IS NOT NULL LIMIT 500)
    UNION ALL
    (SELECT c.family FROM player_reauth_challenge c WHERE c.expires_at < code_cut LIMIT 500)
    UNION ALL
    (SELECT d.family FROM player_sign_in_device d WHERE d.ended_at < cut LIMIT 500)) w;
  SELECT coalesce(array_agg(h.family), '{}') INTO held FROM (
    SELECT d.family FROM player_sign_in_device d WHERE d.family = ANY (seen) FOR UPDATE SKIP LOCKED) h;
  SELECT held || coalesce(array_agg(f), '{}') INTO swept FROM unnest(seen) f
  WHERE NOT EXISTS (SELECT 1 FROM player_sign_in_device x WHERE x.family = f);
  -- Refresh before sessions, as end_family and rotation. A row's predecessor is always older than it (the successor was
  -- made when it was used), so it goes in the same delete; only a surviving row pointing at a removed one is cleared.
  UPDATE player_refresh SET replaced_by = NULL
  WHERE replaced_by IN (SELECT r.id FROM player_refresh r
                        WHERE r.family = ANY (swept) AND least(r.revoked_at, r.used_at, r.expires_at) < cut)
    AND least(revoked_at, used_at, expires_at) >= cut;
  DELETE FROM player_refresh r WHERE r.family = ANY (swept) AND least(r.revoked_at, r.used_at, r.expires_at) < cut;
  GET DIAGNOSTICS found = ROW_COUNT;
  n := n + found;
  DELETE FROM player_session s WHERE s.refresh_family = ANY (swept) AND least(s.revoked_at, s.expires_at) < cut;
  GET DIAGNOSTICS found = ROW_COUNT;
  n := n + found;
  DELETE FROM player_reauth_challenge c WHERE c.family = ANY (swept) AND c.expires_at < code_cut;
  GET DIAGNOSTICS found = ROW_COUNT;
  n := n + found;
  DELETE FROM player_sign_in_device d
  WHERE d.family = ANY (held)
    AND (d.ended_at < cut OR NOT EXISTS (SELECT 1 FROM player_refresh r WHERE r.family = d.family));
  GET DIAGNOSTICS found = ROW_COUNT;
  RETURN n + found;
END $$;
REVOKE ALL ON FUNCTION sweep_player_sign_in() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sweep_player_sign_in() TO questify_app;

-- ================================================================ end-others locks its own row (T-810c)
-- As 0155:471, with one change: the caller's own device row is locked with the other live ones in one statement, in id
-- order (ADR-712), then re-read; an ended row answers PN401 and the fresh check reads the row as locked. Only the rows
-- that statement locked are ended, so a sign-in that commits afterwards stays live.
CREATE OR REPLACE FUNCTION end_other_player_devices(session bytea, request uuid)
  RETURNS TABLE (outcome text, ended integer)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  here  player_sign_in_device := player_current_device(session);
  held  uuid[];
  other record;
  n     integer := 0;
BEGIN
  SELECT array_agg(l.id ORDER BY l.id) INTO held FROM (
    SELECT d.id FROM player_sign_in_device d
    WHERE d.player_id = here.player_id AND (d.id = here.id OR d.ended_at IS NULL)
    ORDER BY d.id FOR UPDATE) l;
  SELECT d.* INTO here FROM player_sign_in_device d WHERE d.id = here.id;
  IF here.id IS NULL OR here.ended_at IS NOT NULL THEN
    RAISE EXCEPTION 'a live session of the calling player is required' USING ERRCODE = 'PN401';
  END IF;
  IF player_device_fresh_until(here) IS NULL THEN
    RETURN QUERY SELECT 'reauth_required'::text, 0;
    RETURN;
  END IF;
  FOR other IN
    SELECT d.family FROM player_sign_in_device d
    WHERE d.id = ANY (held) AND d.id <> here.id AND d.ended_at IS NULL
    ORDER BY d.id
  LOOP
    IF end_family(other.family) THEN
      n := n + 1;
    END IF;
  END LOOP;
  INSERT INTO audit_log (actor_type, action, target_type, target_id, after, request_id)
  VALUES ('system', 'player.devices.end_others', 'player', here.player_id::text, jsonb_build_object('ended', n),
          request);
  RETURN QUERY SELECT 'ended'::text, n;
END $$;
REVOKE ALL ON FUNCTION end_other_player_devices(bytea, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION end_other_player_devices(bytea, uuid) TO questify_app;
