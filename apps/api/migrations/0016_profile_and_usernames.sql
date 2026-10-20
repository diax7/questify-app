-- Profile at sign-up and username rules (T-109). Usernames are unique after Arabic and case folding, checked against
-- Arabic and English word lists (ADR-119), kept in a history, and changed only through definers: the API role can no
-- longer write a username or a birth year itself. Every player has one of Questify's six default avatars.

-- ================================================================ names that already exist must fit the new rules
DO $$
DECLARE
  bad text;
BEGIN
  SELECT string_agg(id::text, ', ') INTO bad FROM player
  WHERE username !~ '^[ء-غف-يA-Za-z0-9_]{3,30}$';
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'players % have usernames outside the allowed characters; rename them before this migration', bad;
  END IF;
END $$;

-- ================================================================ folding
-- Lower case, then أ إ آ → ا, ة → ه, ى → ي: names that read alike collide. An index uses it, so a change needs a
-- REINDEX of player_username_key; the API role runs it whenever it writes a player row.
CREATE FUNCTION username_fold(name text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  RETURN translate(lower(name), 'أإآةى', 'اااهي');
REVOKE ALL ON FUNCTION username_fold(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION username_fold(text) TO questify_app;

DO $$
DECLARE
  clash text;
BEGIN
  SELECT string_agg(ids, '; ') INTO clash FROM (
    SELECT string_agg(id::text, ', ') AS ids FROM player GROUP BY username_fold(username) HAVING count(*) > 1) c;
  IF clash IS NOT NULL THEN
    RAISE EXCEPTION 'usernames that read alike: %; rename all but one in each group before this migration', clash;
  END IF;
END $$;

DROP INDEX player_username_key;
CREATE UNIQUE INDEX player_username_key ON player (username_fold(username));
-- The same characters `checkUsername` allows (3–30 Arabic letters without marks or tatweel, Latin letters, digits, _),
-- so folding and the word lists can never be dodged by a writer that skipped it.
ALTER TABLE player ADD CONSTRAINT player_username_characters
  CHECK (username ~ '^[ء-غف-يA-Za-z0-9_]{3,30}$');

-- ================================================================ avatars (FR-117): Questify's six, shipped with the app
ALTER TABLE player ADD COLUMN avatar text NOT NULL DEFAULT 'falcon'
  CHECK (avatar IN ('falcon', 'fox', 'camel', 'owl', 'lantern', 'explorer-hat'));

-- ================================================================ only the definers write names and ages
REVOKE INSERT ON player FROM questify_app;
REVOKE UPDATE (username, birth_year) ON player FROM questify_app;
GRANT UPDATE (avatar) ON player TO questify_app;

-- ================================================================ word lists (FR-118, FR-1412; ADR-119)
-- `word` entries match a whole token of the name (split at _ and digits); `part` entries match anywhere in the name
-- with _ and digits removed, or with common digit spellings read as letters (0 o, 1 i, 3 e, 4 a, 5 s, 7 t). Words are
-- stored folded and letters only, so a bad entry can never match every name or nothing at all.
CREATE TABLE username_word (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  word       text NOT NULL UNIQUE CHECK (word ~ '^[a-zء-غف-ي]{2,}$' AND word = username_fold(word)),
  match      text NOT NULL CHECK (match IN ('word', 'part')),
  -- Not used by matching (every list checks every name); it is for the console's editing (FR-1779).
  language   text NOT NULL CHECK (language IN ('ar', 'en')),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE username_word ENABLE ROW LEVEL SECURITY;
ALTER TABLE username_word FORCE ROW LEVEL SECURITY;
REVOKE ALL ON username_word FROM PUBLIC;

CREATE FUNCTION username_blocked(name text) RETURNS boolean
  LANGUAGE sql STABLE AS $$
  WITH folded AS (SELECT username_fold(name) AS v),
  forms AS (
    SELECT regexp_split_to_array(v, '[_0-9]+') AS tokens,
           regexp_replace(v, '[_0-9]', '', 'g') AS bare,
           regexp_replace(translate(v, '013457', 'oieast'), '[_0-9]', '', 'g') AS mapped
    FROM folded)
  SELECT EXISTS (
    SELECT 1 FROM username_word w, forms
    WHERE (w.match = 'word' AND w.word = ANY (forms.tokens))
       OR (w.match = 'part' AND (position(w.word IN forms.bare) > 0 OR position(w.word IN forms.mapped) > 0)))
$$;
REVOKE ALL ON FUNCTION username_blocked(text) FROM PUBLIC;

-- ================================================================ history (FR-1702)
CREATE TABLE username_history (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  player_id  uuid NOT NULL REFERENCES player (id) ON DELETE RESTRICT,
  username   text NOT NULL,
  reason     text NOT NULL CHECK (reason IN ('signup', 'rename')),
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX username_history_player_idx ON username_history (player_id, changed_at DESC);
ALTER TABLE username_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE username_history FORCE ROW LEVEL SECURITY;
REVOKE ALL ON username_history FROM PUBLIC;

-- Append-only for every role. Erasure (T-217) will delete a player's rows inside a definer that sets app.erasure first.
-- The flag guards against mistakes only, not attackers: the API role has no DELETE here at all.
CREATE FUNCTION username_history_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.erasure', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'username history can never be changed or removed' USING ERRCODE = 'insufficient_privilege';
END $$;
REVOKE ALL ON FUNCTION username_history_append_only() FROM PUBLIC;
CREATE TRIGGER username_history_no_change BEFORE UPDATE OR DELETE ON username_history
  FOR EACH ROW EXECUTE FUNCTION username_history_append_only();
CREATE TRIGGER username_history_no_truncate BEFORE TRUNCATE ON username_history
  FOR EACH STATEMENT EXECUTE FUNCTION username_history_append_only();
ALTER TABLE username_history ENABLE ALWAYS TRIGGER username_history_no_change;
ALTER TABLE username_history ENABLE ALWAYS TRIGGER username_history_no_truncate;

CREATE FUNCTION record_username() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO username_history (player_id, username, reason) VALUES (NEW.id, NEW.username, 'signup');
  ELSIF NEW.username IS DISTINCT FROM OLD.username THEN
    INSERT INTO username_history (player_id, username, reason) VALUES (NEW.id, NEW.username, 'rename');
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION record_username() FROM PUBLIC;
CREATE TRIGGER record_username AFTER INSERT OR UPDATE OF username ON player
  FOR EACH ROW EXECUTE FUNCTION record_username();

INSERT INTO username_history (player_id, username, reason, changed_at)
SELECT id, username, 'signup', created_at FROM player;

-- ================================================================ creating the account, now with an avatar and the lists
DROP FUNCTION create_player(bytea, text, integer, bytea, bytea, uuid);

-- Bound to the signup token a verified code produced. The year counts in Riyadh. Outcomes:
--   expired             no live signup for this token
--   invalid_birth_year  before 1900 or after this year (the token stays, to correct it)
--   too_young           under 13 by year (FR-119): nothing is created, and the token is used up
--   username_blocked    the name holds a listed word (the token stays, to try another)
--   username_taken      the name reads like someone's, after folding (the token stays)
--   contact_taken       a parallel sign-up for the same contact won (the app signs in again and finds it)
--   created             the player, its contact and its tokens, with an audit entry
CREATE FUNCTION create_player(signup bytea, chosen_name text, born integer, chosen_avatar text, access_hash bytea,
                              refresh_hash bytea, family uuid)
  RETURNS TABLE (outcome text, player_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  found_challenge player_login_challenge%ROWTYPE;
  made            uuid;
  this_year       integer := extract(year FROM now() AT TIME ZONE 'Asia/Riyadh')::integer;
BEGIN
  SELECT * INTO found_challenge FROM player_login_challenge c
  WHERE c.signup_hash = signup AND c.signup_expires_at > now() AND c.cancelled_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'expired'::text, NULL::uuid;
    RETURN;
  END IF;
  IF born IS NULL OR born < 1900 OR born > this_year THEN
    RETURN QUERY SELECT 'invalid_birth_year'::text, NULL::uuid;
    RETURN;
  END IF;
  IF this_year - born < 13 THEN
    DELETE FROM player_login_challenge WHERE id = found_challenge.id;
    RETURN QUERY SELECT 'too_young'::text, NULL::uuid;
    RETURN;
  END IF;
  IF username_blocked(chosen_name) THEN
    RETURN QUERY SELECT 'username_blocked'::text, NULL::uuid;
    RETURN;
  END IF;
  IF EXISTS (SELECT 1 FROM player p WHERE username_fold(p.username) = username_fold(chosen_name)) THEN
    RETURN QUERY SELECT 'username_taken'::text, NULL::uuid;
    RETURN;
  END IF;
  BEGIN
    INSERT INTO player (username, birth_year, avatar) VALUES (chosen_name, born, chosen_avatar) RETURNING id INTO made;
    INSERT INTO player_contact (player_id, phone_e164, email)
    VALUES (made,
            CASE WHEN found_challenge.channel = 'phone' THEN found_challenge.contact END,
            CASE WHEN found_challenge.channel = 'email' THEN found_challenge.contact END);
  EXCEPTION WHEN unique_violation THEN
    -- A name taken at the same moment, or the contact signed up in parallel: nothing of this attempt stays.
    IF EXISTS (SELECT 1 FROM player p WHERE username_fold(p.username) = username_fold(chosen_name)) THEN
      RETURN QUERY SELECT 'username_taken'::text, NULL::uuid;
    ELSE
      DELETE FROM player_login_challenge WHERE id = found_challenge.id;
      RETURN QUERY SELECT 'contact_taken'::text, NULL::uuid;
    END IF;
    RETURN;
  END;
  DELETE FROM player_login_challenge WHERE id = found_challenge.id;
  PERFORM issue_player_tokens(made, access_hash, refresh_hash, family);
  INSERT INTO audit_log (actor_type, action, target_type, target_id, after)
  VALUES ('system', 'player.signup', 'player', made::text, jsonb_build_object('channel', found_challenge.channel));
  RETURN QUERY SELECT 'created'::text, made;
END $$;
REVOKE ALL ON FUNCTION create_player(bytea, text, integer, text, bytea, bytea, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_player(bytea, text, integer, text, bytea, bytea, uuid) TO questify_app;

-- ================================================================ changing a username (FR-704, FR-705, FR-1702)
-- The caller's own name, under a lock on their row so two changes at once count one after the other. `days` is the
-- tuned limit between changes (sign-up does not count). Outcomes:
--   unchanged         exactly the current name (nothing written)
--   too_soon          the last change was less than `days` ago; next_change_at says when the next is allowed
--   username_blocked  the name holds a listed word
--   username_taken    the name reads like someone else's, after folding
--   renamed           saved, with a history row; next_change_at is when the next change is allowed
-- Raises for a caller who is not an active player, or a `days` outside 1–365.
CREATE FUNCTION rename_player(new_name text, days integer)
  RETURNS TABLE (outcome text, next_change_at timestamptz)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me          player%ROWTYPE;
  last_change timestamptz;
BEGIN
  IF days IS NULL OR days < 1 OR days > 365 THEN
    RAISE EXCEPTION 'rename_player needs days from 1 to 365' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO me FROM player WHERE id = app_player_id() AND status = 'active' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not an active player' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF me.username = new_name THEN
    RETURN QUERY SELECT 'unchanged'::text, NULL::timestamptz;
    RETURN;
  END IF;
  SELECT max(h.changed_at) INTO last_change FROM username_history h
  WHERE h.player_id = me.id AND h.reason = 'rename';
  IF last_change IS NOT NULL AND last_change + make_interval(days => days) > now() THEN
    RETURN QUERY SELECT 'too_soon'::text, last_change + make_interval(days => days);
    RETURN;
  END IF;
  IF username_blocked(new_name) THEN
    RETURN QUERY SELECT 'username_blocked'::text, NULL::timestamptz;
    RETURN;
  END IF;
  BEGIN
    UPDATE player SET username = new_name WHERE id = me.id;
  EXCEPTION WHEN unique_violation THEN
    RETURN QUERY SELECT 'username_taken'::text, NULL::timestamptz;
    RETURN;
  END;
  RETURN QUERY SELECT 'renamed'::text, now() + make_interval(days => days);
END $$;
REVOKE ALL ON FUNCTION rename_player(text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rename_player(text, integer) TO questify_app;

-- When the caller may change their name next: NULL when they may now (sign-up does not count). Raises for a `days`
-- outside 1–365, as rename_player does, so the two never disagree.
CREATE FUNCTION username_next_change(days integer) RETURNS timestamptz
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  last_change timestamptz;
BEGIN
  IF days IS NULL OR days < 1 OR days > 365 THEN
    RAISE EXCEPTION 'username_next_change needs days from 1 to 365' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT max(h.changed_at) INTO last_change FROM username_history h
  WHERE h.player_id = app_player_id() AND h.reason = 'rename';
  RETURN CASE WHEN last_change + make_interval(days => days) > now()
              THEN last_change + make_interval(days => days) END;
END $$;
REVOKE ALL ON FUNCTION username_next_change(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION username_next_change(integer) TO questify_app;

-- ================================================================ rankings show the avatar too (FR-120)
DROP FUNCTION ranking_rows(uuid, uuid[]);
CREATE FUNCTION ranking_rows(target uuid, ids uuid[])
  RETURNS TABLE (enrollment_id uuid, username text, avatar text, ranked boolean)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF ranking_reader_enrollment(target) IS NULL THEN
    RAISE EXCEPTION 'not an active player of the event' USING ERRCODE = 'QR403';
  END IF;
  RETURN QUERY
    SELECT e.id, CASE WHEN rule.ok THEN p.username END, CASE WHEN rule.ok THEN p.avatar END, rule.ok
    FROM enrollment e JOIN player p ON p.id = e.player_id, LATERAL (SELECT ranking_eligible(e) AS ok) rule
    WHERE e.id = ANY (ids) AND e.event_id = target;
END $$;
REVOKE ALL ON FUNCTION ranking_rows(uuid, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ranking_rows(uuid, uuid[]) TO questify_app;

DROP FUNCTION ranking_top(uuid, integer);
CREATE FUNCTION ranking_top(target uuid, size integer)
  RETURNS TABLE (enrollment_id uuid, username text, avatar text, score bigint, score_version bigint)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH reader AS MATERIALIZED (SELECT ranking_reader_enrollment(target) AS id)
  SELECT r.id, p.username, p.avatar, r.score, r.score_version
  FROM reader, ranked_enrollments(target) r JOIN player p ON p.id = r.player_id
  WHERE reader.id IS NOT NULL AND r.ranked
  ORDER BY r.score DESC, r.score_version ASC
  LIMIT least(greatest(size, 0), 100)
$$;
REVOKE ALL ON FUNCTION ranking_top(uuid, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ranking_top(uuid, integer) TO questify_app;

-- ================================================================ the first lists (ADR-119: LDNOOBW, CC BY 4.0, cut)
INSERT INTO username_word (word, match, language) VALUES
  ('acrotomophilia', 'part', 'en'),
  ('alabamahotpocket', 'part', 'en'),
  ('alaskanpipeline', 'part', 'en'),
  ('anal', 'word', 'en'),
  ('anilingus', 'part', 'en'),
  ('anus', 'word', 'en'),
  ('apeshit', 'part', 'en'),
  ('arsehole', 'part', 'en'),
  ('ass', 'word', 'en'),
  ('asshole', 'part', 'en'),
  ('assmunch', 'part', 'en'),
  ('autoerotic', 'part', 'en'),
  ('babeland', 'part', 'en'),
  ('ballgag', 'part', 'en'),
  ('ballgravy', 'part', 'en'),
  ('ballkicking', 'part', 'en'),
  ('balllicking', 'part', 'en'),
  ('ballsack', 'part', 'en'),
  ('ballsucking', 'part', 'en'),
  ('bangbros', 'part', 'en'),
  ('bangbus', 'part', 'en'),
  ('bareback', 'word', 'en'),
  ('barelylegal', 'part', 'en'),
  ('barenaked', 'part', 'en'),
  ('bastard', 'part', 'en'),
  ('bastardo', 'part', 'en'),
  ('bbw', 'word', 'en'),
  ('bdsm', 'word', 'en'),
  ('beaner', 'part', 'en'),
  ('beaners', 'part', 'en'),
  ('beastiality', 'part', 'en'),
  ('beavercleaver', 'part', 'en'),
  ('beaverlips', 'part', 'en'),
  ('bestiality', 'part', 'en'),
  ('bigbreasts', 'part', 'en'),
  ('bigknockers', 'part', 'en'),
  ('bigtits', 'part', 'en'),
  ('bimbos', 'part', 'en'),
  ('birdlock', 'part', 'en'),
  ('bitch', 'part', 'en'),
  ('bitches', 'part', 'en'),
  ('blackcock', 'part', 'en'),
  ('blondeonblondeaction', 'part', 'en'),
  ('blowjob', 'part', 'en'),
  ('blowyourload', 'part', 'en'),
  ('bluewaffle', 'part', 'en'),
  ('blumpkin', 'part', 'en'),
  ('bollocks', 'part', 'en'),
  ('bondage', 'part', 'en'),
  ('boner', 'part', 'en'),
  ('boob', 'word', 'en'),
  ('boobs', 'part', 'en'),
  ('bootycall', 'part', 'en'),
  ('brownshowers', 'part', 'en'),
  ('bukkake', 'part', 'en'),
  ('bulldyke', 'part', 'en'),
  ('bulletvibe', 'part', 'en'),
  ('bullshit', 'part', 'en'),
  ('bunghole', 'part', 'en'),
  ('busty', 'part', 'en'),
  ('butt', 'word', 'en'),
  ('buttcheeks', 'part', 'en'),
  ('butthole', 'part', 'en'),
  ('cameltoe', 'part', 'en'),
  ('camgirl', 'part', 'en'),
  ('camslut', 'part', 'en'),
  ('camwhore', 'part', 'en'),
  ('carpetmuncher', 'part', 'en'),
  ('cialis', 'word', 'en'),
  ('circlejerk', 'part', 'en'),
  ('clevelandsteamer', 'part', 'en'),
  ('clit', 'word', 'en'),
  ('clitoris', 'part', 'en'),
  ('cloverclamps', 'part', 'en'),
  ('clusterfuck', 'part', 'en'),
  ('cock', 'word', 'en'),
  ('cocks', 'word', 'en'),
  ('coon', 'word', 'en'),
  ('coons', 'word', 'en'),
  ('coprolagnia', 'part', 'en'),
  ('coprophilia', 'part', 'en'),
  ('cornhole', 'word', 'en'),
  ('creampie', 'part', 'en'),
  ('cum', 'word', 'en'),
  ('cumming', 'word', 'en'),
  ('cumshot', 'part', 'en'),
  ('cumshots', 'part', 'en'),
  ('cunnilingus', 'part', 'en'),
  ('cunt', 'part', 'en'),
  ('darkie', 'part', 'en'),
  ('daterape', 'part', 'en'),
  ('deepthroat', 'part', 'en'),
  ('dendrophilia', 'part', 'en'),
  ('dick', 'word', 'en'),
  ('dildo', 'part', 'en'),
  ('dingleberries', 'part', 'en'),
  ('dingleberry', 'part', 'en'),
  ('dirtysanchez', 'part', 'en'),
  ('doggiestyle', 'part', 'en'),
  ('doggystyle', 'part', 'en'),
  ('dogstyle', 'part', 'en'),
  ('dolcett', 'part', 'en'),
  ('dominatrix', 'part', 'en'),
  ('dommes', 'part', 'en'),
  ('donkeypunch', 'part', 'en'),
  ('doubledong', 'part', 'en'),
  ('doublepenetration', 'part', 'en'),
  ('dpaction', 'part', 'en'),
  ('dryhump', 'part', 'en'),
  ('dvda', 'word', 'en'),
  ('eatmyass', 'part', 'en'),
  ('ecchi', 'part', 'en'),
  ('ejaculation', 'part', 'en'),
  ('erotic', 'part', 'en'),
  ('erotism', 'part', 'en'),
  ('eunuch', 'part', 'en'),
  ('fag', 'word', 'en'),
  ('faggot', 'part', 'en'),
  ('fecal', 'part', 'en'),
  ('felch', 'part', 'en'),
  ('fellatio', 'part', 'en'),
  ('feltch', 'part', 'en'),
  ('femalesquirting', 'part', 'en'),
  ('femdom', 'part', 'en'),
  ('figging', 'part', 'en'),
  ('fingerbang', 'part', 'en'),
  ('fingering', 'word', 'en'),
  ('fisting', 'part', 'en'),
  ('footfetish', 'part', 'en'),
  ('footjob', 'part', 'en'),
  ('frotting', 'part', 'en'),
  ('fuck', 'part', 'en'),
  ('fuckbuttons', 'part', 'en'),
  ('fuckin', 'part', 'en'),
  ('fucking', 'part', 'en'),
  ('fucktards', 'part', 'en'),
  ('fudgepacker', 'part', 'en'),
  ('futanari', 'part', 'en'),
  ('gangbang', 'part', 'en'),
  ('gaysex', 'part', 'en'),
  ('genitals', 'part', 'en'),
  ('giantcock', 'part', 'en'),
  ('girlontop', 'part', 'en'),
  ('girlscup', 'part', 'en'),
  ('girlsgonewild', 'part', 'en'),
  ('goatcx', 'part', 'en'),
  ('goatse', 'part', 'en'),
  ('goddamn', 'part', 'en'),
  ('gokkun', 'part', 'en'),
  ('goldenshower', 'part', 'en'),
  ('goodpoop', 'part', 'en'),
  ('googirl', 'part', 'en'),
  ('goregasm', 'part', 'en'),
  ('grope', 'part', 'en'),
  ('groupsex', 'part', 'en'),
  ('gspot', 'part', 'en'),
  ('guro', 'word', 'en'),
  ('handjob', 'part', 'en'),
  ('hentai', 'part', 'en'),
  ('homoerotic', 'part', 'en'),
  ('honkey', 'part', 'en'),
  ('hooker', 'part', 'en'),
  ('horny', 'word', 'en'),
  ('hotcarl', 'part', 'en'),
  ('humping', 'word', 'en'),
  ('incest', 'part', 'en'),
  ('intercourse', 'part', 'en'),
  ('jackoff', 'part', 'en'),
  ('jailbait', 'part', 'en'),
  ('jerkoff', 'part', 'en'),
  ('jigaboo', 'part', 'en'),
  ('jiggaboo', 'part', 'en'),
  ('jiggerboo', 'part', 'en'),
  ('jizz', 'part', 'en'),
  ('juggs', 'part', 'en'),
  ('kike', 'word', 'en'),
  ('kinbaku', 'part', 'en'),
  ('kinkster', 'part', 'en'),
  ('kinky', 'part', 'en'),
  ('knobbing', 'part', 'en'),
  ('leatherrestraint', 'part', 'en'),
  ('leatherstraightjacket', 'part', 'en'),
  ('lemonparty', 'part', 'en'),
  ('livesex', 'part', 'en'),
  ('lolita', 'part', 'en'),
  ('makemecome', 'part', 'en'),
  ('malesquirting', 'part', 'en'),
  ('masturbate', 'part', 'en'),
  ('masturbating', 'part', 'en'),
  ('masturbation', 'part', 'en'),
  ('menageatrois', 'part', 'en'),
  ('milf', 'word', 'en'),
  ('missionaryposition', 'part', 'en'),
  ('mong', 'word', 'en'),
  ('motherfucker', 'part', 'en'),
  ('moundofvenus', 'part', 'en'),
  ('mrhands', 'part', 'en'),
  ('muffdiver', 'part', 'en'),
  ('muffdiving', 'part', 'en'),
  ('nambla', 'part', 'en'),
  ('nawashi', 'part', 'en'),
  ('negro', 'word', 'en'),
  ('neonazi', 'part', 'en'),
  ('nigga', 'part', 'en'),
  ('nigger', 'part', 'en'),
  ('nignog', 'part', 'en'),
  ('nimphomania', 'part', 'en'),
  ('nipple', 'part', 'en'),
  ('nipples', 'part', 'en'),
  ('nsfw', 'word', 'en'),
  ('nsfwimages', 'part', 'en'),
  ('nude', 'word', 'en'),
  ('nudity', 'part', 'en'),
  ('nutten', 'part', 'en'),
  ('nympho', 'part', 'en'),
  ('nymphomania', 'part', 'en'),
  ('octopussy', 'part', 'en'),
  ('omorashi', 'part', 'en'),
  ('onecuptwogirls', 'part', 'en'),
  ('oneguyonejar', 'part', 'en'),
  ('orgasm', 'part', 'en'),
  ('orgy', 'word', 'en'),
  ('paedophile', 'part', 'en'),
  ('paki', 'word', 'en'),
  ('panties', 'part', 'en'),
  ('panty', 'part', 'en'),
  ('pedobear', 'part', 'en'),
  ('pedophile', 'part', 'en'),
  ('pegging', 'word', 'en'),
  ('penis', 'part', 'en'),
  ('phonesex', 'part', 'en'),
  ('pieceofshit', 'part', 'en'),
  ('pikey', 'part', 'en'),
  ('pissing', 'part', 'en'),
  ('pisspig', 'part', 'en'),
  ('playboy', 'part', 'en'),
  ('polesmoker', 'part', 'en'),
  ('ponyplay', 'part', 'en'),
  ('poof', 'word', 'en'),
  ('poon', 'word', 'en'),
  ('poontang', 'part', 'en'),
  ('poopchute', 'part', 'en'),
  ('porn', 'part', 'en'),
  ('porno', 'part', 'en'),
  ('pornography', 'part', 'en'),
  ('princealbertpiercing', 'part', 'en'),
  ('pthc', 'word', 'en'),
  ('pubes', 'word', 'en'),
  ('punany', 'part', 'en'),
  ('pussy', 'part', 'en'),
  ('queaf', 'part', 'en'),
  ('queef', 'part', 'en'),
  ('quim', 'word', 'en'),
  ('raghead', 'part', 'en'),
  ('ragingboner', 'part', 'en'),
  ('rape', 'word', 'en'),
  ('raping', 'word', 'en'),
  ('rapist', 'word', 'en'),
  ('rectum', 'part', 'en'),
  ('reversecowgirl', 'part', 'en'),
  ('rimjob', 'part', 'en'),
  ('rimming', 'word', 'en'),
  ('rosypalmandhersisters', 'part', 'en'),
  ('rustytrombone', 'part', 'en'),
  ('sadism', 'part', 'en'),
  ('scat', 'word', 'en'),
  ('schlong', 'part', 'en'),
  ('scissoring', 'word', 'en'),
  ('semen', 'word', 'en'),
  ('sex', 'word', 'en'),
  ('sexcam', 'part', 'en'),
  ('sexo', 'word', 'en'),
  ('sexual', 'part', 'en'),
  ('sexuality', 'part', 'en'),
  ('sexually', 'part', 'en'),
  ('sexy', 'word', 'en'),
  ('shavedbeaver', 'part', 'en'),
  ('shavedpussy', 'part', 'en'),
  ('shemale', 'part', 'en'),
  ('shibari', 'part', 'en'),
  ('shit', 'part', 'en'),
  ('shitblimp', 'part', 'en'),
  ('shitty', 'part', 'en'),
  ('shrimping', 'word', 'en'),
  ('skeet', 'part', 'en'),
  ('slanteye', 'part', 'en'),
  ('slut', 'part', 'en'),
  ('smut', 'word', 'en'),
  ('snatch', 'part', 'en'),
  ('snowballing', 'word', 'en'),
  ('sodomize', 'part', 'en'),
  ('sodomy', 'part', 'en'),
  ('spastic', 'part', 'en'),
  ('spic', 'word', 'en'),
  ('splooge', 'part', 'en'),
  ('sploogemoose', 'part', 'en'),
  ('spooge', 'part', 'en'),
  ('spreadlegs', 'part', 'en'),
  ('spunk', 'part', 'en'),
  ('strapon', 'part', 'en'),
  ('strappado', 'part', 'en'),
  ('stripclub', 'part', 'en'),
  ('styledoggy', 'part', 'en'),
  ('suck', 'word', 'en'),
  ('sucks', 'part', 'en'),
  ('suicidegirls', 'part', 'en'),
  ('swastika', 'part', 'en'),
  ('swinger', 'word', 'en'),
  ('teabagging', 'part', 'en'),
  ('threesome', 'part', 'en'),
  ('throating', 'part', 'en'),
  ('thumbzilla', 'part', 'en'),
  ('tit', 'word', 'en'),
  ('tits', 'word', 'en'),
  ('titties', 'part', 'en'),
  ('titty', 'part', 'en'),
  ('topless', 'part', 'en'),
  ('tosser', 'part', 'en'),
  ('towelhead', 'part', 'en'),
  ('tranny', 'part', 'en'),
  ('tribadism', 'part', 'en'),
  ('tubgirl', 'part', 'en'),
  ('tushy', 'part', 'en'),
  ('twat', 'part', 'en'),
  ('twink', 'word', 'en'),
  ('twogirlsonecup', 'part', 'en'),
  ('undressing', 'word', 'en'),
  ('upskirt', 'part', 'en'),
  ('urethraplay', 'part', 'en'),
  ('urophilia', 'part', 'en'),
  ('vagina', 'part', 'en'),
  ('venusmound', 'part', 'en'),
  ('viagra', 'part', 'en'),
  ('vibrator', 'part', 'en'),
  ('violetwand', 'part', 'en'),
  ('vorarephilia', 'part', 'en'),
  ('voyeur', 'part', 'en'),
  ('voyeurweb', 'part', 'en'),
  ('voyuer', 'part', 'en'),
  ('vulva', 'part', 'en'),
  ('wank', 'part', 'en'),
  ('wetback', 'part', 'en'),
  ('wetdream', 'part', 'en'),
  ('whitepower', 'part', 'en'),
  ('whore', 'part', 'en'),
  ('worldsex', 'part', 'en'),
  ('wrinkledstarfish', 'part', 'en'),
  ('xxx', 'word', 'en'),
  ('yaoi', 'word', 'en'),
  ('yellowshowers', 'part', 'en'),
  ('yiffy', 'part', 'en'),
  ('zoophilia', 'part', 'en'),
  ('احتلام', 'part', 'ar'),
  ('اغتصاب', 'part', 'ar'),
  ('بز', 'word', 'ar'),
  ('بزاز', 'word', 'ar'),
  ('بظر', 'word', 'ar'),
  ('تمص', 'word', 'ar'),
  ('ثدي', 'word', 'ar'),
  ('جماع', 'word', 'ar'),
  ('حلمه', 'word', 'ar'),
  ('خنثي', 'word', 'ar'),
  ('خول', 'word', 'ar'),
  ('زب', 'word', 'ar'),
  ('سحاق', 'part', 'ar'),
  ('سحاقيه', 'part', 'ar'),
  ('سكس', 'part', 'ar'),
  ('شاذ', 'word', 'ar'),
  ('شرج', 'word', 'ar'),
  ('شهوه', 'word', 'ar'),
  ('طيز', 'part', 'ar'),
  ('عاهره', 'part', 'ar'),
  ('عرص', 'word', 'ar'),
  ('قحبه', 'word', 'ar'),
  ('قضيب', 'word', 'ar'),
  ('كس', 'word', 'ar'),
  ('لحس', 'word', 'ar'),
  ('لعق', 'word', 'ar'),
  ('لواط', 'part', 'ar'),
  ('لوطي', 'part', 'ar'),
  ('متناك', 'part', 'ar'),
  ('متناكه', 'part', 'ar'),
  ('مص', 'word', 'ar'),
  ('مفلقسه', 'part', 'ar'),
  ('نيك', 'word', 'ar'),
  ('كسم', 'part', 'ar'),
  ('منيوك', 'part', 'ar'),
  ('شرموط', 'part', 'ar'),
  ('زبي', 'word', 'ar');

-- The definers read the lists as the migration owner and the table has forced row-level security: an owner that
-- cannot bypass it would see no words and let every name through. Prove now that it can.
DO $$
BEGIN
  IF (SELECT count(*) FROM username_word) = 0 THEN
    RAISE EXCEPTION 'the migration owner cannot read username_word (row-level security is forced): grant it BYPASSRLS';
  END IF;
END $$;
