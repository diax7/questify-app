-- T-810f (plan docs/plans/2026-11-05-t-810f-reward-code-rotation.md, review 88; ADR-705, ADR-725 to ADR-729; Q-694 to
-- Q-696; ASVS V11.2.2): reward code key rotation.
--
-- The API now seals a code as `0x51 0x02 keyId ‖ iv ‖ tag ‖ ciphertext` (32 bytes at the least, so 0025's length check
-- holds) and, during a rotation, holds a previous key next to the current one. An old unused code is then marked under
-- the previous key, so a new upload of the same code would miss UNIQUE (event_id, code_hash). add_reward_codes gains
-- `prior_hashes`: the marks of the same codes under the previous key. An item whose prior mark is already in the event
-- is skipped and counted as a duplicate.
--
-- Rollout: the default '{}' keeps the 3-argument call of the API instance still running working, so the migration
-- needs no window. The 3-argument function is dropped, not kept beside the new one: one door, one signature.
--
-- Deny by default: revoked from PUBLIC next to the create; only questify_app may execute it, as before.
SET LOCAL lock_timeout = '10s';

DROP FUNCTION add_reward_codes(uuid, bytea[], bytea[]);

-- Adds codes to a digital reward (FR-510) for a staff member of the reward's organizer within their events, or an
-- admin: a code already in the event (under the current mark, or under its prior mark when given) is skipped and the
-- stock rises by what was added. Refusals: invalid_parameter_value when the arrays do not pair up or a prior mark is
-- not 32 bytes; RN404 no such reward, removed, or not the caller's; RD409 not a digital reward; RC422 more than
-- 100 000 codes (DETAIL: how many more fit).
CREATE FUNCTION add_reward_codes(target uuid, ciphers bytea[], hashes bytea[],
                                 prior_hashes bytea[] DEFAULT '{}')
  RETURNS TABLE (added integer, duplicates integer, stock_total integer, stock_left integer)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  most     CONSTANT integer := 100000;
  given    integer := coalesce(array_length(ciphers, 1), 0);
  priors   integer := coalesce(array_length(prior_hashes, 1), 0);
  item     reward%ROWTYPE;
  inserted integer;
BEGIN
  IF given = 0 OR given <> coalesce(array_length(hashes, 1), 0) OR (priors <> 0 AND priors <> given) THEN
    RAISE EXCEPTION 'codes, hashes and prior hashes must pair up' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(prior_hashes) AS p (mark) WHERE p.mark IS NULL OR length(p.mark) <> 32) THEN
    RAISE EXCEPTION 'every prior hash is 32 bytes' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO item FROM reward r WHERE r.id = target;
  IF NOT FOUND OR NOT (app_is_admin()
                       OR (item.organizer_id = app_organizer_id() AND app_staff_user_id() IS NOT NULL
                           AND in_event_scope(item.event_id, app_event_scope()))) THEN
    RAISE EXCEPTION 'reward not found' USING ERRCODE = 'RN404';
  END IF;
  SELECT * INTO item FROM reward r WHERE r.id = target FOR UPDATE;
  IF item.status <> 'active' THEN
    RAISE EXCEPTION 'reward not found' USING ERRCODE = 'RN404';
  END IF;
  IF item.kind <> 'digital' THEN
    RAISE EXCEPTION 'not a digital reward' USING ERRCODE = 'RD409';
  END IF;
  WITH given_codes AS (
    SELECT u.cipher, u.hash, CASE WHEN priors = 0 THEN NULL ELSE prior_hashes[u.n] END AS prior
      FROM unnest(ciphers, hashes) WITH ORDINALITY AS u (cipher, hash, n)
  ), fresh AS (
    INSERT INTO reward_code (organizer_id, event_id, reward_id, code_cipher, code_hash)
    SELECT item.organizer_id, item.event_id, item.id, g.cipher, g.hash FROM given_codes g
     WHERE g.prior IS NULL
        OR NOT EXISTS (SELECT 1 FROM reward_code c WHERE c.event_id = item.event_id AND c.code_hash = g.prior)
    ON CONFLICT (event_id, code_hash) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO inserted FROM fresh;
  IF item.stock_total + inserted > most THEN
    RAISE EXCEPTION 'too many codes' USING ERRCODE = 'RC422', DETAIL = (most - item.stock_total)::text;
  END IF;
  UPDATE reward r SET stock_total = r.stock_total + inserted WHERE r.id = target;
  RETURN QUERY SELECT inserted, given - inserted, item.stock_total + inserted,
                      item.stock_total + inserted - item.units_out;
END $$;
REVOKE ALL ON FUNCTION add_reward_codes(uuid, bytea[], bytea[], bytea[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION add_reward_codes(uuid, bytea[], bytea[], bytea[]) TO questify_app;
