-- T-408: the Questify-wide ranking by XP, lifetime and this month, and its monthly seasons (FR-611, FR-1786;
-- ADR-322, ADR-323; plan docs/plans/2026-10-27-t-408-questify-home.md). One cache table, xp_board, holds a lifetime
-- board ('all') and one board per Questify month ('YYYY-MM'); xp_apply, the one function every XP payer calls, keeps
-- it in the same transaction as each XP entry while it holds the player's player_xp row lock. A removal counts in the
-- month of the credit it reverses, so a month board never goes negative and a past month changes only when one of its
-- own credits is removed (plan review MAJOR-1). Deny by default: the table keeps row-level security forced and no
-- grant; every function is closed to PUBLIC in the group that creates it; only the three doors are granted.
-- Migrations 0071 and earlier untouched.
SET LOCAL lock_timeout = '10s';
-- Every XP payer inserts into xp_entry before it changes player_xp.xp, so holding xp_entry ACCESS EXCLUSIVE stops every
-- XP change and makes the backfill and its check exact. Nothing else is locked, and no row either: xp_board has no
-- foreign key to player_xp, because checking one would take KEY SHARE on the rows the daily finish and the sync hold
-- FOR UPDATE while they wait on xp_entry behind this migration (a deadlock the upgrade test reproduced). Its rows come
-- only from xp_entry (which keys on player_xp) and from xp_apply, and no player_xp row is ever deleted. player SHARE
-- (its new index) after xp_entry, as 0069: no writer of player touches xp_entry, so a sign-up or an erasure in flight
-- finishes without waiting on this migration.
LOCK TABLE xp_entry IN ACCESS EXCLUSIVE MODE;
LOCK TABLE player IN SHARE MODE;

-- ================================================================ months (internal, ADR-323)
-- The Questify month a moment falls in: the month of its Questify day, so a month starts at 04:00 Riyadh time on the
-- 1st (ADR-297's edge) and a late-night daily play counts in the month of its Questify day.
CREATE FUNCTION questify_month(at timestamptz) RETURNS text
  LANGUAGE sql STABLE SET search_path = public, pg_temp
  RETURN to_char(questify_day(at), 'YYYY-MM');
REVOKE ALL ON FUNCTION questify_month(timestamptz) FROM PUBLIC;

-- The month board an XP entry counts on: its own month, or for a removal the month of the credit it reverses. NULL
-- when there is no such entry.
CREATE FUNCTION xp_month_of(entry bigint) RETURNS text
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT questify_month(coalesce(c.created_at, e.created_at))
  FROM xp_entry e LEFT JOIN xp_entry c ON c.id = e.reverses
  WHERE e.id = entry
$$;
REVOKE ALL ON FUNCTION xp_month_of(bigint) FROM PUBLIC;

-- ================================================================ the boards (ADR-322)
-- A cache of xp_entry, like player_xp: 'all' equals player_xp.xp; a month is the XP credited that month less the
-- removals of those credits. xp_version is the highest entry id applied to the row; the lower one ranks first on a tie
-- (FR-606). Kept on the tombstone (no personal data); the reads leave out every player who is not active.
CREATE TABLE xp_board (
  board      text NOT NULL CHECK (board ~ '^(all|[0-9]{4}-(0[1-9]|1[0-2]))$'),
  player_id  uuid NOT NULL,
  xp         bigint NOT NULL CHECK (xp >= 0),
  xp_version bigint NOT NULL CHECK (xp_version > 0),
  PRIMARY KEY (board, player_id)
);
CREATE INDEX xp_board_rank_idx ON xp_board (board, xp DESC, xp_version) WHERE xp > 0;
-- The few players who are not active (banned, deleted): a reader's place counts every board row ahead from the index
-- alone, then takes these off (ADR-322's timing: the join to player per row ahead cost about 100 ms at 100,000).
CREATE INDEX player_inactive_idx ON player (id) WHERE status <> 'active';
ALTER TABLE xp_board ENABLE ROW LEVEL SECURITY;
ALTER TABLE xp_board FORCE ROW LEVEL SECURITY;
REVOKE ALL ON xp_board FROM PUBLIC;

-- 0039's body, then both boards. Every caller holds the player's player_xp row lock from the UPDATE below until it
-- commits, so one player's board rows are written by one transaction at a time: an UPDATE, and an INSERT only when the
-- row is new (a new row can only come from a credit, so the CHECK on xp holds).
CREATE OR REPLACE FUNCTION xp_apply(who uuid, made bigint, delta integer) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  total bigint;
  month text := xp_month_of(made);
  target text;
BEGIN
  IF month IS NULL THEN
    RAISE EXCEPTION 'XP entry % does not exist', made USING ERRCODE = 'internal_error';
  END IF;
  UPDATE player_xp x SET xp = x.xp + delta, level = xp_level_of(x.xp + delta), updated_at = now()
  WHERE x.player_id = who
  RETURNING x.xp INTO total;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'player % has no XP row', who USING ERRCODE = 'internal_error';
  END IF;
  IF delta > 0 THEN
    INSERT INTO level_reached (player_id, level, xp_entry_id)
    SELECT who, l.level, made FROM xp_level l WHERE l.level > 1 AND l.xp_from <= total
    ON CONFLICT DO NOTHING;
  END IF;
  FOREACH target IN ARRAY ARRAY['all', month] LOOP
    UPDATE xp_board b SET xp = b.xp + delta, xp_version = greatest(b.xp_version, made)
    WHERE b.board = target AND b.player_id = who;
    IF NOT FOUND THEN
      INSERT INTO xp_board (board, player_id, xp, xp_version) VALUES (target, who, delta, made);
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION xp_apply(uuid, bigint, integer) FROM PUBLIC;

-- 0039's one-time backfill wrote xp_entry and player_xp without xp_apply; run again, it would leave the boards behind
-- the totals. It ran once, in 0039, and nothing calls it.
DROP FUNCTION xp_backfill();

-- ================================================================ backfill and its check (under the locks above)
INSERT INTO xp_board (board, player_id, xp, xp_version)
SELECT 'all', e.player_id, sum(e.delta), max(e.id) FROM xp_entry e GROUP BY e.player_id;
INSERT INTO xp_board (board, player_id, xp, xp_version)
SELECT questify_month(coalesce(c.created_at, e.created_at)), e.player_id, sum(e.delta), max(e.id)
FROM xp_entry e LEFT JOIN xp_entry c ON c.id = e.reverses
GROUP BY 1, 2;

-- Aborts the migration unless the boards equal the ledger: 'all' equals player_xp.xp for every player (none missing
-- with XP), a player's month rows add up to their 'all' row, and each month row equals the entries xp_month_of places
-- on it, by sum and by highest id. A negative month row was already refused by the CHECK.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM player_xp x FULL JOIN (SELECT * FROM xp_board WHERE board = 'all') b
                                         ON b.player_id = x.player_id
             WHERE coalesce(b.xp, 0) <> coalesce(x.xp, 0))
     OR EXISTS (SELECT 1 FROM xp_board a
                WHERE a.board = 'all'
                  AND a.xp <> (SELECT coalesce(sum(m.xp), 0) FROM xp_board m
                               WHERE m.player_id = a.player_id AND m.board <> 'all'))
     OR EXISTS (SELECT 1
                FROM (SELECT xp_month_of(e.id) AS board, e.player_id, sum(e.delta) AS xp, max(e.id) AS version
                      FROM xp_entry e GROUP BY 1, 2) l
                FULL JOIN (SELECT * FROM xp_board WHERE board <> 'all') m
                  ON m.board = l.board AND m.player_id = l.player_id
                WHERE m.xp IS DISTINCT FROM l.xp OR m.xp_version IS DISTINCT FROM l.version) THEN
    RAISE EXCEPTION 'the XP boards do not match the XP ledger' USING ERRCODE = 'internal_error';
  END IF;
END $$;

-- ================================================================ reading a board (internal)
-- The platform switch (ADR-322): `platform_setting` features.questifyRanking.enabled, on when absent.
CREATE FUNCTION questify_ranking_on() RETURNS boolean
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT s.value -> 'questifyRanking' -> 'enabled' <> 'false'::jsonb
                   FROM platform_setting s WHERE s.key = 'features'), true)
$$;
REVOKE ALL ON FUNCTION questify_ranking_on() FROM PUBLIC;

-- The board a player asks for: `lifetime` or this Questify `month`. Refuses an inactive caller (PI401, as the sync),
-- the switch off (QW404) and any other scope (22023).
CREATE FUNCTION questify_board_of(scope text) RETURNS text
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
BEGIN
  IF profile_player() IS NULL THEN
    RAISE EXCEPTION 'active player required' USING ERRCODE = 'PI401';
  END IF;
  IF NOT questify_ranking_on() THEN
    RAISE EXCEPTION 'the Questify ranking is off' USING ERRCODE = 'QW404';
  END IF;
  IF scope = 'lifetime' THEN
    RETURN 'all';
  ELSIF scope = 'month' THEN
    RETURN questify_month(now());
  END IF;
  RAISE EXCEPTION 'the scope is lifetime or month' USING ERRCODE = 'invalid_parameter_value';
END $$;
REVOKE ALL ON FUNCTION questify_board_of(text) FROM PUBLIC;

-- One shown row (FR-120): the username, avatar, equipment, the board's XP and the lifetime level; never a player id,
-- a contact or gems.
CREATE FUNCTION xp_board_row(who uuid, place bigint, amount bigint) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'rank', place, 'username', p.username, 'avatar', p.avatar,
    'equipment', jsonb_build_object('character', item_json(eq.character_id), 'frame', item_json(eq.frame_id),
                                    'title', item_json(eq.title_id)),
    'xp', amount, 'level', x.level)
  FROM player p JOIN player_xp x ON x.player_id = p.id LEFT JOIN player_equipment eq ON eq.player_id = p.id
  WHERE p.id = who
$$;
REVOKE ALL ON FUNCTION xp_board_row(uuid, bigint, bigint) FROM PUBLIC;

-- A board as players see it (ADR-052, FR-605, FR-606): the top 10 active players with XP above 0, and the reader's own
-- place (1 + the active rows ahead), or null. One statement in STABLE functions, so the rows and `me` share one
-- snapshot. The rows ahead: every row in two index ranges (more XP; the same XP reached earlier), less the inactive
-- players among them (player_inactive_idx).
CREATE FUNCTION xp_board_json(target_board text, reader uuid) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  WITH ranked AS NOT MATERIALIZED (
    SELECT b.player_id, b.xp, b.xp_version
    FROM xp_board b JOIN player p ON p.id = b.player_id
    WHERE b.board = target_board AND b.xp > 0 AND p.status = 'active'
  ),
  top AS (
    SELECT r.player_id, r.xp, row_number() OVER (ORDER BY r.xp DESC, r.xp_version) AS place
    FROM (SELECT * FROM ranked ORDER BY xp DESC, xp_version LIMIT 10) r
  ),
  mine AS (
    SELECT m.player_id, m.xp,
           1 + (SELECT count(*) FROM xp_board a WHERE a.board = target_board AND a.xp > 0 AND a.xp > m.xp)
             + (SELECT count(*) FROM xp_board a
                WHERE a.board = target_board AND a.xp > 0 AND a.xp = m.xp AND a.xp_version < m.xp_version)
             - (SELECT count(*) FROM player p
                CROSS JOIN LATERAL (SELECT a.xp, a.xp_version FROM xp_board a
                                    WHERE a.board = target_board AND a.player_id = p.id LIMIT 1) a
                WHERE p.status <> 'active' AND a.xp > 0
                  AND (a.xp > m.xp OR (a.xp = m.xp AND a.xp_version < m.xp_version))) AS place
    FROM ranked m WHERE m.player_id = reader
  )
  SELECT jsonb_build_object(
    'board', target_board,
    'rows', coalesce((SELECT jsonb_agg(xp_board_row(t.player_id, t.place, t.xp)
                                       || jsonb_build_object('isMe', coalesce(t.player_id = reader, false))
                                       ORDER BY t.place)
                      FROM top t), '[]'::jsonb),
    'me', (SELECT xp_board_row(m.player_id, m.place, m.xp) FROM mine m))
$$;
REVOKE ALL ON FUNCTION xp_board_json(text, uuid) FROM PUBLIC;

-- The admin's view of a month board (ADR-323): its ranked count, then the same top 10 the players saw. Refuses a
-- malformed month (22023).
CREATE FUNCTION questify_season_board(month text) RETURNS text
  LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
BEGIN
  IF month IS NULL OR month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' THEN
    RAISE EXCEPTION 'a month is YYYY-MM' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN month;
END $$;
REVOKE ALL ON FUNCTION questify_season_board(text) FROM PUBLIC;

-- How many players a board ranks (active, XP above 0). The admin's views only; a player's answer has no total.
CREATE FUNCTION xp_board_count(target_board text) RETURNS bigint
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT count(*) FROM xp_board b JOIN player p ON p.id = b.player_id
  WHERE b.board = target_board AND b.xp > 0 AND p.status = 'active'
$$;
REVOKE ALL ON FUNCTION xp_board_count(text) FROM PUBLIC;

-- ================================================================ the doors
-- The Questify-wide ranking as the caller sees it (FR-611): `lifetime` or this month. Caller-bound: no player id is
-- taken from outside.
CREATE FUNCTION questify_ranking(scope text) RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT xp_board_json(questify_board_of(scope), profile_player())
$$;
REVOKE ALL ON FUNCTION questify_ranking(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION questify_ranking(text) TO questify_app;

-- Every season (FR-1786): each month from the earliest month board to the current month, newest first, with its ranked
-- count (0 for a month nobody played). The first and last month boards come from the key's two ends ('all' sorts after
-- every month), so no board row is read to list them. Admin only.
CREATE FUNCTION questify_seasons() RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('month', s.board, 'players', xp_board_count(s.board),
                                               'current', s.board = now_month.board)
                            ORDER BY s.board DESC), '[]'::jsonb)
  FROM (SELECT questify_admin() AS admin, questify_month(now()) AS board) now_month
  CROSS JOIN LATERAL (
    SELECT to_char(m, 'YYYY-MM') AS board
    FROM generate_series(
      to_date(least(now_month.board, (SELECT min(b.board) FROM xp_board b WHERE b.board < 'all')), 'YYYY-MM'),
      to_date(greatest(now_month.board, (SELECT max(b.board) FROM xp_board b WHERE b.board < 'all')), 'YYYY-MM'),
      interval '1 month') m
  ) s
  WHERE now_month.admin IS NOT NULL
$$;
REVOKE ALL ON FUNCTION questify_seasons() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION questify_seasons() TO questify_app;

-- One season's archive (ADR-323): its ranked count and its top 10, read with today's rule. Admin only.
CREATE FUNCTION questify_season_top(month text) RETURNS jsonb
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'month', m.board,
    'players', xp_board_count(m.board),
    'rows', coalesce((SELECT jsonb_agg(r - 'isMe' ORDER BY (r ->> 'rank')::integer)
                      FROM jsonb_array_elements(xp_board_json(m.board, NULL) -> 'rows') r), '[]'::jsonb))
  FROM (SELECT questify_admin() AS admin, questify_season_board(month) AS board) m
  WHERE m.admin IS NOT NULL
$$;
REVOKE ALL ON FUNCTION questify_season_top(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION questify_season_top(text) TO questify_app;
