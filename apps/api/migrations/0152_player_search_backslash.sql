-- T-810b item 4 (V1.2.4, V1.2.9): the organizer's player search escapes a backslash in its prefix. 0032's
-- event_players escaped `%` and `_` but its backslash step was replace(..., '\', '\'), a no-op, so a typed backslash
-- escaped the next character of the LIKE pattern: the prefix `zq\x` became `zq\x%`, which matched the username `zqxb`.
-- Same signature and body as 0032 with the step written replace(..., '\', '\\'), so it is replaced in place.
--
-- Deny by default: revoked from PUBLIC by name and granted to questify_app only, next to its replace (outsider suite).
-- Catalog only: no table, trigger, policy or other grant changes.
SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION event_players(target uuid, after_id uuid, page integer, prefix text)
  RETURNS TABLE (enrollment_id uuid, username text, avatar text, status text, score bigint, joined_at timestamptz,
                 open_flag bigint, redeem_paused boolean, rehearsal boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT n.id, p.username, p.avatar, n.status, n.score, n.joined_at,
         (SELECT min(f.id) FROM flag f WHERE f.enrollment_id = n.id AND f.status = 'open'),
         n.redeem_paused_at IS NOT NULL,
         n.joined_via IS NOT DISTINCT FROM 'rehearsal'
  FROM event ev
  JOIN enrollment n ON n.event_id = ev.id
  JOIN player p ON p.id = n.player_id
  WHERE ev.id = target
    AND ev.organizer_id = app_organizer_id() AND in_event_scope(ev.id, app_event_scope())
    AND (prefix IS NULL OR username_fold(p.username) LIKE
         replace(replace(replace(username_fold(left(prefix, 30)), '\', '\\'), '%', '\%'), '_', '\_') || '%')
    AND (after_id IS NULL
         OR NOT EXISTS (SELECT 1 FROM enrollment c WHERE c.id = after_id AND c.event_id = target)
         OR (n.joined_at, n.id) > (SELECT c.joined_at, c.id FROM enrollment c WHERE c.id = after_id AND c.event_id = target))
  ORDER BY n.joined_at, n.id
  LIMIT least(greatest(page, 1), 100)
$$;
REVOKE ALL ON FUNCTION event_players(uuid, uuid, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION event_players(uuid, uuid, integer, text) TO questify_app;
