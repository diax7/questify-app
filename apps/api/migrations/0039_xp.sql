-- Questify XP and levels (T-401, ADR-179 to ADR-182; plan docs/plans/2026-10-24-t-401-xp.md). XP belongs to the player
-- across events and follows the event ledger by trigger: one credit per (player, quest), ever, on the first quest
-- entry that is not a rehearsal; one reversal when a removal reverses that credited entry (the quest stays used,
-- ADR-152). Nothing spends XP (FR-415). Deny by default: no table is granted to the API role; own_level is its only
-- door.

-- No ledger entry may land between the backfill below and the trigger that follows it.
LOCK TABLE ledger_entry IN SHARE ROW EXCLUSIVE MODE;

-- ================================================================ the settings: the amount, the curve, the titles
-- The amount per quest (ADR-180) is server-only: platform_setting key `xp`, never in the public `features`/`tuning`.
-- A bad value is refused on write, so it can never abort a scan.
ALTER TABLE platform_setting ADD CONSTRAINT platform_setting_xp_check
  CHECK (key <> 'xp' OR coalesce(value ->> 'questXp', '') ~ '^[1-9][0-9]{0,4}$');
INSERT INTO platform_setting (key, value) VALUES ('xp', '{"questXp": 100}') ON CONFLICT (key) DO NOTHING;

-- Read defensively all the same: a missing row pays 100.
CREATE FUNCTION quest_xp() RETURNS integer
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce((SELECT CASE WHEN s.value ->> 'questXp' ~ '^[1-9][0-9]{0,4}$'
                               THEN (s.value ->> 'questXp')::integer END
                   FROM platform_setting s WHERE s.key = 'xp'), 100)
$$;
REVOKE ALL ON FUNCTION quest_xp() FROM PUBLIC;

-- The curve (ADR-180): level n starts at 50·(n−1)·(n+2) XP. Data, so T-709 can edit it (FR-1403).
CREATE TABLE xp_level (
  level   smallint PRIMARY KEY CHECK (level BETWEEN 1 AND 100),
  xp_from bigint NOT NULL UNIQUE CHECK (xp_from >= 0 AND (xp_from = 0) = (level = 1))
);
ALTER TABLE xp_level ENABLE ROW LEVEL SECURITY;
ALTER TABLE xp_level FORCE ROW LEVEL SECURITY;
REVOKE ALL ON xp_level FROM PUBLIC;
INSERT INTO xp_level (level, xp_from) SELECT n, 50 * (n - 1) * (n + 2) FROM generate_series(1, 30) AS n;

-- A title per range of levels (FR-706, ADR-181): the title of a level is the row with the greatest level_from ≤ it.
CREATE TABLE level_title (
  level_from smallint PRIMARY KEY CHECK (level_from BETWEEN 1 AND 100),
  name_ar    text NOT NULL CHECK (length(name_ar) BETWEEN 1 AND 40),
  name_en    text NOT NULL CHECK (length(name_en) BETWEEN 1 AND 40)
);
ALTER TABLE level_title ENABLE ROW LEVEL SECURITY;
ALTER TABLE level_title FORCE ROW LEVEL SECURITY;
REVOKE ALL ON level_title FROM PUBLIC;
INSERT INTO level_title (level_from, name_ar, name_en) VALUES
  (1, 'مستكشف', 'Explorer'),
  (6, 'مقتفي الأثر', 'Pathfinder'),
  (11, 'مغامر', 'Adventurer'),
  (16, 'صائد الكنوز', 'Treasure Hunter'),
  (21, 'بطل', 'Champion'),
  (26, 'أسطورة', 'Legend');

-- The level an amount of XP stands at.
CREATE FUNCTION xp_level_of(total bigint) RETURNS smallint
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT coalesce(max(l.level), 1)::smallint FROM xp_level l WHERE l.xp_from <= total
$$;
REVOKE ALL ON FUNCTION xp_level_of(bigint) FROM PUBLIC;

-- ================================================================ the XP rows
-- The running total and its level, a cache of xp_entry. One row per player, made with the player. The XP rows point
-- here, not at player, so their key checks never wait on erase_player's lock of the player row.
CREATE TABLE player_xp (
  player_id  uuid PRIMARY KEY REFERENCES player (id),
  xp         bigint NOT NULL DEFAULT 0 CHECK (xp >= 0),
  level      smallint NOT NULL DEFAULT 1 CHECK (level >= 1),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE player_xp ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_xp FORCE ROW LEVEL SECURITY;
REVOKE ALL ON player_xp FROM PUBLIC;

CREATE TABLE xp_entry (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  player_id       uuid NOT NULL REFERENCES player_xp (player_id),
  delta           integer NOT NULL,
  source          text NOT NULL CHECK (source IN ('quest', 'removal')),
  ledger_entry_id bigint NOT NULL REFERENCES ledger_entry (id) ON DELETE RESTRICT,
  quest_id        uuid NOT NULL,
  reverses        bigint REFERENCES xp_entry (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((source = 'quest' AND delta > 0 AND reverses IS NULL)
         OR (source = 'removal' AND delta < 0 AND reverses IS NOT NULL))
);
CREATE UNIQUE INDEX xp_entry_quest_key ON xp_entry (player_id, quest_id) WHERE source = 'quest';
CREATE UNIQUE INDEX xp_entry_ledger_key ON xp_entry (ledger_entry_id) WHERE source = 'quest';
CREATE UNIQUE INDEX xp_entry_reversal_key ON xp_entry (reverses) WHERE source = 'removal';
CREATE INDEX xp_entry_player_idx ON xp_entry (player_id, id);
ALTER TABLE xp_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE xp_entry FORCE ROW LEVEL SECURITY;
REVOKE ALL ON xp_entry FROM PUBLIC;

-- The first time each level was reached (FR-721: T-402 grants an item per row). Never removed: a drop recalculates the
-- level, and climbing back writes nothing new (FR-1602).
CREATE TABLE level_reached (
  player_id   uuid NOT NULL REFERENCES player_xp (player_id),
  level       smallint NOT NULL CHECK (level >= 2),
  xp_entry_id bigint NOT NULL REFERENCES xp_entry (id),
  reached_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, level)
);
CREATE INDEX level_reached_entry_idx ON level_reached (xp_entry_id);
ALTER TABLE level_reached ENABLE ROW LEVEL SECURITY;
ALTER TABLE level_reached FORCE ROW LEVEL SECURITY;
REVOKE ALL ON level_reached FROM PUBLIC;

-- Append-only for every role, the owner included (as the ledger, 0012).
CREATE FUNCTION xp_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'XP entries can never be changed or removed; a correction is a new entry'
    USING ERRCODE = 'insufficient_privilege';
END $$;
REVOKE ALL ON FUNCTION xp_append_only() FROM PUBLIC;
CREATE TRIGGER xp_entry_no_update_or_delete BEFORE UPDATE OR DELETE ON xp_entry
  FOR EACH ROW EXECUTE FUNCTION xp_append_only();
CREATE TRIGGER xp_entry_no_truncate BEFORE TRUNCATE ON xp_entry
  FOR EACH STATEMENT EXECUTE FUNCTION xp_append_only();
CREATE TRIGGER level_reached_no_update_or_delete BEFORE UPDATE OR DELETE ON level_reached
  FOR EACH ROW EXECUTE FUNCTION xp_append_only();
CREATE TRIGGER level_reached_no_truncate BEFORE TRUNCATE ON level_reached
  FOR EACH STATEMENT EXECUTE FUNCTION xp_append_only();
ALTER TABLE xp_entry ENABLE ALWAYS TRIGGER xp_entry_no_update_or_delete;
ALTER TABLE xp_entry ENABLE ALWAYS TRIGGER xp_entry_no_truncate;
ALTER TABLE level_reached ENABLE ALWAYS TRIGGER level_reached_no_update_or_delete;
ALTER TABLE level_reached ENABLE ALWAYS TRIGGER level_reached_no_truncate;

-- Every new player gets their row at once.
CREATE FUNCTION player_xp_start() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO player_xp (player_id) VALUES (NEW.id) ON CONFLICT DO NOTHING;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION player_xp_start() FROM PUBLIC;
CREATE TRIGGER player_xp_start AFTER INSERT ON player FOR EACH ROW EXECUTE FUNCTION player_xp_start();

-- ================================================================ paying and taking back
-- Moves the player's total by an entry just written, and records each level reached for the first time.
CREATE FUNCTION xp_apply(who uuid, made bigint, delta integer) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  total bigint;
BEGIN
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
END $$;
REVOKE ALL ON FUNCTION xp_apply(uuid, bigint, integer) FROM PUBLIC;

-- The first quest entry of a (player, quest) pays quest_xp(); any later one pays nothing (FR-414).
CREATE FUNCTION xp_credit(entry ledger_entry) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  who    uuid;
  amount integer := quest_xp();
  made   bigint;
BEGIN
  SELECT n.player_id INTO STRICT who FROM enrollment n WHERE n.id = entry.enrollment_id;
  INSERT INTO xp_entry (player_id, delta, source, ledger_entry_id, quest_id)
  VALUES (who, amount, 'quest', entry.id, entry.quest_id)
  ON CONFLICT DO NOTHING
  RETURNING id INTO made;
  IF made IS NOT NULL THEN
    PERFORM xp_apply(who, made, amount);
  END IF;
END $$;
REVOKE ALL ON FUNCTION xp_credit(ledger_entry) FROM PUBLIC;

-- A removal of the entry that paid a quest's XP takes it back once (FR-1602); a removal of anything else (a repeat,
-- an award) finds no credit and takes nothing.
CREATE FUNCTION xp_reverse(entry ledger_entry) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  credit xp_entry%ROWTYPE;
  made   bigint;
BEGIN
  SELECT c.* INTO credit FROM xp_entry c WHERE c.ledger_entry_id = entry.reverses AND c.source = 'quest';
  IF NOT FOUND THEN
    RETURN;
  END IF;
  INSERT INTO xp_entry (player_id, delta, source, ledger_entry_id, quest_id, reverses)
  VALUES (credit.player_id, -credit.delta, 'removal', entry.id, credit.quest_id, credit.id)
  ON CONFLICT DO NOTHING
  RETURNING id INTO made;
  IF made IS NOT NULL THEN
    PERFORM xp_apply(credit.player_id, made, -credit.delta);
  END IF;
END $$;
REVOKE ALL ON FUNCTION xp_reverse(ledger_entry) FROM PUBLIC;

CREATE FUNCTION ledger_xp() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.rehearsal THEN
    RETURN NULL;
  END IF;
  IF NEW.kind = 'quest' THEN
    PERFORM xp_credit(NEW);
  ELSIF NEW.kind = 'removal' THEN
    PERFORM xp_reverse(NEW);
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION ledger_xp() FROM PUBLIC;
CREATE TRIGGER ledger_xp AFTER INSERT ON ledger_entry FOR EACH ROW
  WHEN (NEW.kind IN ('quest', 'removal')) EXECUTE FUNCTION ledger_xp();

-- ================================================================ the backfill (idempotent: a second run adds nothing)
-- Credits from the first non-rehearsal quest entry per (player, quest), reversals of the removed ones, then each
-- total, level and level reached, from the rows themselves.
CREATE FUNCTION xp_backfill() RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO player_xp (player_id) SELECT p.id FROM player p ON CONFLICT DO NOTHING;
  INSERT INTO xp_entry (player_id, delta, source, ledger_entry_id, quest_id)
  SELECT DISTINCT ON (n.player_id, l.quest_id) n.player_id, quest_xp(), 'quest', l.id, l.quest_id
  FROM ledger_entry l JOIN enrollment n ON n.id = l.enrollment_id
  WHERE l.kind = 'quest' AND NOT l.rehearsal
  ORDER BY n.player_id, l.quest_id, l.id
  ON CONFLICT DO NOTHING;
  INSERT INTO xp_entry (player_id, delta, source, ledger_entry_id, quest_id, reverses)
  SELECT c.player_id, -c.delta, 'removal', r.id, c.quest_id, c.id
  FROM xp_entry c JOIN ledger_entry r ON r.reverses = c.ledger_entry_id AND r.kind = 'removal'
  WHERE c.source = 'quest'
  ON CONFLICT DO NOTHING;
  UPDATE player_xp x SET xp = s.total, level = xp_level_of(s.total), updated_at = now()
  FROM (SELECT e.player_id, sum(e.delta) AS total FROM xp_entry e GROUP BY e.player_id) s
  WHERE s.player_id = x.player_id AND (x.xp <> s.total OR x.level <> xp_level_of(s.total));
  INSERT INTO level_reached (player_id, level, xp_entry_id)
  SELECT DISTINCT ON (r.player_id, l.level) r.player_id, l.level, r.id
  FROM (SELECT e.id, e.player_id, sum(e.delta) OVER (PARTITION BY e.player_id ORDER BY e.id) AS running
        FROM xp_entry e) r
  JOIN xp_level l ON l.level > 1 AND l.xp_from <= r.running
  ORDER BY r.player_id, l.level, r.id
  ON CONFLICT DO NOTHING;
END $$;
REVOKE ALL ON FUNCTION xp_backfill() FROM PUBLIC;
SELECT xp_backfill();

-- ================================================================ reading (the API role's only door)
-- The title of a level: the row with the greatest level_from at or below it.
CREATE FUNCTION level_title_of(target smallint) RETURNS TABLE (name_ar text, name_en text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT t.name_ar, t.name_en FROM level_title t WHERE t.level_from <= target ORDER BY t.level_from DESC LIMIT 1
$$;
REVOKE ALL ON FUNCTION level_title_of(smallint) FROM PUBLIC;

-- The calling player's XP, level, the level's range, its title, and (given a completion) the highest level that
-- completion's credit reached for the first time with its title: the level-up to celebrate, the same on a replay.
-- The XP a quest gave is not part of the answer (FR-414).
CREATE FUNCTION own_level(completion bigint)
  RETURNS TABLE (xp bigint, level smallint, level_from bigint, next_level_at bigint, title_ar text, title_en text,
                 level_up smallint, up_title_ar text, up_title_en text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT x.xp, x.level, cur.xp_from, nxt.xp_from, t.name_ar, t.name_en, up.level, ut.name_ar, ut.name_en
  FROM player_xp x
  JOIN player p ON p.id = x.player_id AND p.status = 'active'
  JOIN xp_level cur ON cur.level = x.level
  LEFT JOIN xp_level nxt ON nxt.level = x.level + 1
  LEFT JOIN LATERAL level_title_of(x.level) t ON true
  LEFT JOIN LATERAL (SELECT max(r.level) AS level FROM level_reached r
                     JOIN xp_entry e ON e.id = r.xp_entry_id
                     JOIN ledger_entry l ON l.id = e.ledger_entry_id
                     WHERE r.player_id = x.player_id AND l.completion_id = completion AND l.kind = 'quest') up ON true
  LEFT JOIN LATERAL level_title_of(up.level) ut ON true
  WHERE x.player_id = app_player_id()
$$;
REVOKE ALL ON FUNCTION own_level(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION own_level(bigint) TO questify_app;
