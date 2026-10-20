-- Rankings (T-106, ADR-118). The order is points, then who reached those points first: the ledger entry that last
-- changed a player's points (its id) is that player's version, lowest first (FR-606). Ledger ids come from one
-- identity sequence with the default CACHE 1 (raising it would break this order) and are taken under the enrollment's
-- lock, so the order never depends on a clock. Redis holds a copy (ADR-118); every function here reads PostgreSQL, the
-- source of truth (ADR-102), for rebuilds and for the fallback when Redis cannot answer.

-- ================================================================ the version
ALTER TABLE enrollment ADD COLUMN score_version bigint;

CREATE OR REPLACE FUNCTION apply_ledger_entry() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE enrollment
  SET score = score + NEW.score_delta,
      balance = balance + NEW.balance_delta,
      score_version = CASE WHEN NEW.score_delta <> 0 THEN NEW.id ELSE score_version END
  WHERE id = NEW.enrollment_id;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION apply_ledger_entry() FROM PUBLIC;

UPDATE enrollment e SET score_version = last.id
FROM (SELECT enrollment_id, max(id) AS id FROM ledger_entry WHERE score_delta <> 0 GROUP BY enrollment_id) last
WHERE last.enrollment_id = e.id;

DROP INDEX enrollment_ranking_idx;
CREATE INDEX enrollment_ranking_idx ON enrollment (event_id, score DESC, score_version)
  WHERE status = 'active' AND score > 0;

-- ================================================================ who is ranked (FR-609, FR-318, FR-1014)
-- Points above zero, an active enrollment of an active player who is not on the organizer's own team (a member staff
-- account with the same email). Team members who play by phone are caught by the event's exclusion list (T-208).
-- None of these three are definers; only the owner (through the definers below) may call them.

-- The players on an organizer's team: members' staff emails matched to player emails (a handful of rows).
CREATE FUNCTION organizer_team_players(org uuid) RETURNS SETOF uuid
  LANGUAGE sql STABLE AS $$
  SELECT pc.player_id FROM organizer_member m
  JOIN staff_user s ON s.id = m.staff_user_id
  JOIN player_contact pc ON pc.email = s.email
  WHERE m.organizer_id = org
$$;
REVOKE ALL ON FUNCTION organizer_team_players(uuid) FROM PUBLIC;

-- The rule for one enrollment (the after-commit read and the top-10 rows).
CREATE FUNCTION ranking_eligible(target enrollment) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  SELECT target.status = 'active' AND target.score > 0 AND target.score_version IS NOT NULL
    AND EXISTS (SELECT 1 FROM player p WHERE p.id = target.player_id AND p.status = 'active')
    AND target.player_id NOT IN (SELECT organizer_team_players(target.organizer_id))
$$;
REVOKE ALL ON FUNCTION ranking_eligible(enrollment) FROM PUBLIC;

-- The same rule over a whole event in one pass (rebuilds and the fallback): every enrollment with points and whether
-- it is ranked. Per-row calls took 1.7 s at 20,000 players; this set form is what the T-106 plan's timings measure.
CREATE FUNCTION ranked_enrollments(target uuid)
  RETURNS TABLE (id uuid, player_id uuid, score bigint, score_version bigint, ranked boolean)
  LANGUAGE sql STABLE AS $$
  SELECT e.id, e.player_id, e.score, e.score_version,
         e.status = 'active' AND p.status = 'active' AND team.player_id IS NULL
  FROM enrollment e
  JOIN player p ON p.id = e.player_id
  LEFT JOIN (SELECT DISTINCT t.player_id
             FROM event ev, LATERAL organizer_team_players(ev.organizer_id) AS t(player_id)
             WHERE ev.id = target) team ON team.player_id = e.player_id
  WHERE e.event_id = target AND e.score > 0 AND e.score_version IS NOT NULL
$$;
REVOKE ALL ON FUNCTION ranked_enrollments(uuid) FROM PUBLIC;

-- The caller's own active enrollment in the event, when the request is a player's (deny by default: nobody else reads
-- a ranking until the dashboard and the big screen need it, T-504).
CREATE FUNCTION ranking_reader_enrollment(target uuid) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT e.id FROM enrollment e
  WHERE e.event_id = target AND e.player_id = app_player_id() AND e.status = 'active'
$$;
REVOKE ALL ON FUNCTION ranking_reader_enrollment(uuid) FROM PUBLIC;

-- The system's own context: no player, no organizer, no staff user, no admin. Rebuilds and the after-commit update run
-- there on a connection of their own; a request that carries anyone's identity is refused.
CREATE FUNCTION ranking_system() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT app_player_id() IS NULL AND app_organizer_id() IS NULL AND app_staff_user_id() IS NULL
    AND NOT app_is_admin()
$$;
REVOKE ALL ON FUNCTION ranking_system() FROM PUBLIC;

-- ================================================================ the repair mark (durable, in PostgreSQL)
-- An event whose Redis copy may be wrong: a Redis write failed, or someone's eligibility changed. The repair tick
-- claims these and rebuilds. Closed to everyone; written only by the functions and triggers below.
CREATE TABLE ranking_repair (
  event_id  uuid PRIMARY KEY REFERENCES event (id) ON DELETE CASCADE,
  marked_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE ranking_repair ENABLE ROW LEVEL SECURITY;
ALTER TABLE ranking_repair FORCE ROW LEVEL SECURITY;
REVOKE ALL ON ranking_repair FROM PUBLIC;

-- Marked by the system, or by an active player of the event (a Redis write that failed after their completion).
CREATE FUNCTION mark_ranking_repair(target uuid) RETURNS void
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  INSERT INTO ranking_repair (event_id) SELECT id FROM event
  WHERE id = target AND (ranking_system() OR ranking_reader_enrollment(target) IS NOT NULL)
  ON CONFLICT (event_id) DO UPDATE SET marked_at = now()
$$;
REVOKE ALL ON FUNCTION mark_ranking_repair(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION mark_ranking_repair(uuid) TO questify_app;

-- Claims up to `size` marked events for a rebuild (system context only): their marks are removed now, at the start of
-- the rebuild, so a change that lands while it runs marks the event again.
CREATE FUNCTION claim_ranking_repairs(size integer) RETURNS SETOF uuid
  LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  DELETE FROM ranking_repair
  WHERE ranking_system() AND event_id IN (
    SELECT event_id FROM ranking_repair ORDER BY marked_at LIMIT least(greatest(size, 0), 100)
    FOR UPDATE SKIP LOCKED)
  RETURNING event_id
$$;
REVOKE ALL ON FUNCTION claim_ranking_repairs(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_ranking_repairs(integer) TO questify_app;

-- The live events, for the backstop rebuild every few minutes (system context only).
CREATE FUNCTION live_ranking_events() RETURNS SETOF uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id FROM event WHERE ranking_system() AND status = 'live'
$$;
REVOKE ALL ON FUNCTION live_ranking_events() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION live_ranking_events() TO questify_app;

-- Every change that can move someone in or out of a ranking marks the events it touches.
CREATE FUNCTION mark_ranking_on_enrollment() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM mark_ranking_repair(NEW.event_id);
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mark_ranking_on_enrollment() FROM PUBLIC;
-- Only enrollments with points can move a rank: approving a pending join with no points marks nothing.
CREATE TRIGGER mark_ranking_on_enrollment AFTER UPDATE OF status ON enrollment
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status AND (OLD.score > 0 OR NEW.score > 0))
  EXECUTE FUNCTION mark_ranking_on_enrollment();

CREATE FUNCTION mark_ranking_on_player() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO ranking_repair (event_id)
  SELECT DISTINCT e.event_id FROM enrollment e WHERE e.player_id = NEW.id AND e.score > 0
  ON CONFLICT (event_id) DO UPDATE SET marked_at = now();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mark_ranking_on_player() FROM PUBLIC;
CREATE TRIGGER mark_ranking_on_player AFTER UPDATE OF status ON player
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION mark_ranking_on_player();

CREATE FUNCTION mark_ranking_on_contact() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO ranking_repair (event_id)
  SELECT DISTINCT e.event_id FROM enrollment e WHERE e.player_id = NEW.player_id AND e.score > 0
  ON CONFLICT (event_id) DO UPDATE SET marked_at = now();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION mark_ranking_on_contact() FROM PUBLIC;
CREATE TRIGGER mark_ranking_on_contact AFTER UPDATE OF email ON player_contact
  FOR EACH ROW WHEN (OLD.email IS DISTINCT FROM NEW.email) EXECUTE FUNCTION mark_ranking_on_contact();

CREATE FUNCTION mark_ranking_on_member() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  changed uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.organizer_id ELSE NEW.organizer_id END;
BEGIN
  INSERT INTO ranking_repair (event_id)
  SELECT ev.id FROM event ev WHERE ev.organizer_id = changed AND ev.status IN ('scheduled', 'live')
  ON CONFLICT (event_id) DO UPDATE SET marked_at = now();
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION mark_ranking_on_member() FROM PUBLIC;
CREATE TRIGGER mark_ranking_on_member AFTER INSERT OR DELETE ON organizer_member
  FOR EACH ROW EXECUTE FUNCTION mark_ranking_on_member();

-- ================================================================ reading the order
-- Every enrollment of an event with points, for a rebuild (system context only; nothing in it is personal: enrollment
-- ids, points, versions), with whether it is ranked: the rebuild writes the ranked ones and a removal mark for the
-- others, so a late write from before a ban cannot bring a player back through the rebuild.
CREATE FUNCTION ranking_entries(target uuid)
  RETURNS TABLE (enrollment_id uuid, score bigint, score_version bigint, ranked boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.id, r.score, r.score_version, r.ranked FROM ranked_enrollments(target) r WHERE ranking_system()
$$;
REVOKE ALL ON FUNCTION ranking_entries(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ranking_entries(uuid) TO questify_app;

-- Where the caller's own just-committed completion leaves them: the event, the enrollment, its points and version, and
-- whether it is ranked. The API copies this into Redis after the commit. Someone else's completion gives nothing.
CREATE FUNCTION ranking_entry_of(completion bigint)
  RETURNS TABLE (event_id uuid, enrollment_id uuid, score bigint, score_version bigint, ranked boolean)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT e.event_id, e.id, e.score, e.score_version, ranking_eligible(e)
  FROM quest_completion c JOIN enrollment e ON e.id = c.enrollment_id
  WHERE c.id = completion AND e.player_id = app_player_id()
$$;
REVOKE ALL ON FUNCTION ranking_entry_of(bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ranking_entry_of(bigint) TO questify_app;

-- The given enrollments of this event as one of its active players sees them: whether each is ranked, and the
-- username of each ranked one. The API passes ids it read from Redis (the top 10), never ids from a client: low-ranked
-- players stay visible only to themselves (ADR-052). A caller who is not an active player of the event gets QR403, so
-- the API can tell "this reader may not look" from "these rows are no longer ranked".
CREATE FUNCTION ranking_rows(target uuid, ids uuid[])
  RETURNS TABLE (enrollment_id uuid, username text, ranked boolean)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF ranking_reader_enrollment(target) IS NULL THEN
    RAISE EXCEPTION 'not an active player of the event' USING ERRCODE = 'QR403';
  END IF;
  RETURN QUERY
    SELECT e.id, CASE WHEN rule.ok THEN p.username END, rule.ok
    FROM enrollment e JOIN player p ON p.id = e.player_id, LATERAL (SELECT ranking_eligible(e) AS ok) rule
    WHERE e.id = ANY (ids) AND e.event_id = target;
END $$;
REVOKE ALL ON FUNCTION ranking_rows(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ranking_rows(uuid, uuid[]) TO questify_app;

-- The fallback when Redis cannot answer: the top of the order straight from PostgreSQL, with the same rule.
CREATE FUNCTION ranking_top(target uuid, size integer)
  RETURNS TABLE (enrollment_id uuid, username text, score bigint, score_version bigint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH reader AS MATERIALIZED (SELECT ranking_reader_enrollment(target) AS id)
  SELECT r.id, p.username, r.score, r.score_version
  FROM reader, ranked_enrollments(target) r JOIN player p ON p.id = r.player_id
  WHERE reader.id IS NOT NULL AND r.ranked
  ORDER BY r.score DESC, r.score_version ASC
  LIMIT least(greatest(size, 0), 100)
$$;
REVOKE ALL ON FUNCTION ranking_top(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ranking_top(uuid, integer) TO questify_app;

-- The caller's own place (1 + how many ranked players are ahead; NULL when the caller is not ranked), the caller's own
-- enrollment, and how many are ranked. No row for someone who is not an active player of the event.
CREATE FUNCTION ranking_position(target uuid)
  RETURNS TABLE (enrollment_id uuid, place bigint, total bigint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH reader AS MATERIALIZED (SELECT ranking_reader_enrollment(target) AS id),
  mine AS MATERIALIZED (SELECT e.score, e.score_version FROM enrollment e, reader WHERE e.id = reader.id)
  SELECT reader.id,
         CASE WHEN bool_or(r.id = reader.id) THEN
           count(*) FILTER (WHERE r.score > mine.score
                              OR (r.score = mine.score AND r.score_version < mine.score_version)) + 1
         END,
         count(r.id)
  FROM reader
  CROSS JOIN mine
  LEFT JOIN ranked_enrollments(target) r ON r.ranked
  WHERE reader.id IS NOT NULL
  GROUP BY reader.id
$$;
REVOKE ALL ON FUNCTION ranking_position(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ranking_position(uuid) TO questify_app;
