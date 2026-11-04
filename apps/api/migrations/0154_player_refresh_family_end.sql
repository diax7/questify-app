-- T-810b item 9 (V7.3.2, V7.1.1; Q-660, ADR-706): a player's refresh family ends 365 days after its sign-in, whatever
-- its use. Until now every rotation gave the new refresh token now() + 180 days, so a phone used once a season stayed
-- signed in for ever (FR-123 as first written). Used and revoked rows are swept 7 days later (0020), so the sign-in
-- time is kept on every row as family_started_at, copied from the family's own rows on each rotation.
--
-- issue_player_tokens keeps its signature, so its callers (0013 to 0144) are untouched: the family's start is the
-- earliest family_started_at of its rows (none for a new sign-in: now()); the refresh token ends at the earlier of
-- now() + 180 days and start + 365 days, and the access token at the earlier of now() + 1 hour and start + 365 days, so
-- the family's last access token cannot outlive it. rotate_player_refresh already answers `invalid` for an expired
-- token; its 60-second retry grace and theft detection are unchanged.
--
-- Rollout: the backfill starts every existing family at its earliest surviving row. A live row ends within 180 days of
-- its creation and older rows are swept, so no surviving row is more than about 187 days old: nobody is signed out by
-- the deploy, and every live row already ends before its family's start + 365 days (asserted below, no UPDATE needed).
-- All the logic is in SQL, so API instances of the old and new release behave the same during the deploy.
--
-- Deny by default: no new function or grant. player_refresh stays RLS-forced with no grant; issue_player_tokens is
-- revoked from PUBLIC again next to its replace and stays ungranted (called only by definers; outsider suite).
SET LOCAL lock_timeout = '10s';

ALTER TABLE player_refresh ADD COLUMN family_started_at timestamptz;

UPDATE player_refresh r
SET family_started_at = f.started
FROM (SELECT family, min(created_at) AS started FROM player_refresh GROUP BY family) f
WHERE f.family = r.family;

ALTER TABLE player_refresh ALTER COLUMN family_started_at SET NOT NULL;
ALTER TABLE player_refresh ALTER COLUMN family_started_at SET DEFAULT now();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM player_refresh
             WHERE revoked_at IS NULL AND expires_at > family_started_at + interval '365 days') THEN
    RAISE EXCEPTION 'a live refresh token ends after its family''s start + 365 days; cap it before 0154';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION issue_player_tokens(holder uuid, access_hash bytea, refresh_hash bytea, new_family uuid)
  RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  started timestamptz;
  family_end timestamptz;
BEGIN
  started := coalesce((SELECT min(r.family_started_at) FROM player_refresh r WHERE r.family = new_family), now());
  family_end := started + interval '365 days';
  INSERT INTO player_refresh (player_id, family, token_hash, expires_at, family_started_at)
  VALUES (holder, new_family, refresh_hash, least(now() + interval '180 days', family_end), started);
  INSERT INTO player_session (player_id, token_hash, expires_at, refresh_family)
  VALUES (holder, access_hash, least(now() + interval '1 hour', family_end), new_family);
  -- Beyond 10 live families, the oldest go first: their refresh tokens and their access tokens end.
  WITH extra AS (
    SELECT r.family FROM player_refresh r
    WHERE r.player_id = holder AND r.revoked_at IS NULL
    GROUP BY r.family ORDER BY max(r.created_at) DESC OFFSET 10
  ), ended AS (
    UPDATE player_refresh p SET revoked_at = now()
    WHERE p.family IN (SELECT e.family FROM extra e) AND p.revoked_at IS NULL
    RETURNING p.family
  )
  UPDATE player_session s SET revoked_at = now()
  WHERE s.refresh_family IN (SELECT e.family FROM extra e) AND s.revoked_at IS NULL;
END $$;
-- Called only by the definers that issue a session, never by the API's role.
REVOKE ALL ON FUNCTION issue_player_tokens(uuid, bytea, bytea, uuid) FROM PUBLIC;
