-- The player's data export lists their device checks (T-812, ADR-834, Q-780 answered by Dhia 2026-11-15: "Yes, include
-- them"). `player_data_export` is restated from 0129 with one new top-level section, `deviceChecks`: one line per app
-- install whose latest check this account sent (device_check.player_id), with the platform, the result (`passed` or
-- `failed`), the reason codes and when, oldest first. Never the install id (an identifier, not something the player can
-- read), never another account's check on a shared install (the row names only the account that sent it last).
-- Deny by default: no new function, table or grant; `player_data_export` stays SECURITY DEFINER and closed to PUBLIC,
-- reached only through own_data_export (the player's own seat) and console_player_export (an admin with a case). It
-- reads device_check as the owner, as record_device_check writes it; the API role still has no right on the table.
-- 0200 and earlier untouched.
SET LOCAL lock_timeout = '10s';

-- As 0129, with `deviceChecks` after the support sections. DR404 for a tombstone or an unknown id.
CREATE OR REPLACE FUNCTION player_data_export(target uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  p player;
BEGIN
  SELECT x.* INTO p FROM player x WHERE x.id = target;
  IF NOT FOUND OR p.status = 'deleted' THEN
    RAISE EXCEPTION 'no such player' USING ERRCODE = 'DR404';
  END IF;
  RETURN jsonb_build_object('format', 'questify-data-export', 'version', 1, 'generatedAt', data_export_time(now()),
                            'playerId', p.id)
         || data_export_account(p)
         || jsonb_build_object('events', data_export_events(p.id), 'questify', data_export_questify(p.id))
         || data_export_support(p.id)
         || jsonb_build_object('deviceChecks', coalesce(
              (SELECT jsonb_agg(jsonb_build_object('platform', c.platform, 'result', c.verdict,
                                                   'reasons', to_jsonb(c.reasons),
                                                   'checkedAt', data_export_time(c.checked_at))
                                ORDER BY c.checked_at, c.install_id)
               FROM device_check c WHERE c.player_id = p.id), '[]'));
END $$;
REVOKE ALL ON FUNCTION player_data_export(uuid) FROM PUBLIC;
