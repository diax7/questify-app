-- The device-integrity flag (T-812, FR-334, ADR-833 to ADR-835; plan docs/plans/2026-11-13-device-integrity.md).
-- The API verifies a phone's Play Integrity verdict or App Attest attestation and assertion and records the outcome
-- per install here; a failed install raises one `device_integrity` case per account of a live event that played on it,
-- now and at its next scan. Never blocking: nothing here refuses a scan, a sign-in or a reservation (a case holds the
-- desk only through the owner's hold, ADR-154, as every flag). Deny by default: both tables have row-level security
-- forced, PUBLIC revoked and no grant; every new function is closed to PUBLIC, and only the four player doors are
-- granted. 0197 and earlier untouched.
SET LOCAL lock_timeout = '10s';

-- ================================================================ the checks (ADR-834)
-- The latest outcome per app install (the X-Device-Id the app sends). `player_id` is the account that sent it last:
-- the install id is personal data, erased with that account (the tombstone trigger below). `reasons` are short codes
-- only (`device`, `app`, `nonce`, `chain`, ...), never a vendor payload.
CREATE TABLE device_check (
  install_id uuid PRIMARY KEY,
  platform   text NOT NULL CHECK (platform IN ('ios', 'android')),
  verdict    text NOT NULL CHECK (verdict IN ('passed', 'failed')),
  reasons    text[] NOT NULL DEFAULT '{}',
  player_id  uuid NOT NULL REFERENCES player (id),
  checked_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT device_check_reasons CHECK (
    cardinality(reasons) <= 8 AND (verdict = 'failed') = (cardinality(reasons) > 0)
    AND array_to_string(reasons, ',') ~ '^[a-z_,]{0,120}$')
);
CREATE INDEX device_check_player_idx ON device_check (player_id);
ALTER TABLE device_check ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_check FORCE ROW LEVEL SECURITY;
REVOKE ALL ON device_check FROM PUBLIC;

-- An App Attest key once its attestation held: its public key (SPKI DER) and the counter of its last assertion. A key
-- belongs to one install (Apple keeps it in that install's keychain); any account on that install may assert with it.
CREATE TABLE app_attest_key (
  key_id      bytea PRIMARY KEY CHECK (octet_length(key_id) = 32),
  install_id  uuid NOT NULL,
  player_id   uuid NOT NULL REFERENCES player (id),
  public_key  bytea NOT NULL CHECK (octet_length(public_key) BETWEEN 59 AND 120),
  sign_count  bigint NOT NULL DEFAULT 0 CHECK (sign_count BETWEEN 0 AND 4294967295),
  development boolean NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  used_at     timestamptz
);
CREATE INDEX app_attest_key_player_idx ON app_attest_key (player_id);
ALTER TABLE app_attest_key ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_attest_key FORCE ROW LEVEL SECURITY;
REVOKE ALL ON app_attest_key FROM PUBLIC;

-- ================================================================ the flag kind (FR-334)
-- One case per account and install, ever, as `shared_device` (a cleared case stays cleared); evidence
-- {"platform", "reasons", "checkedAt"}, refreshed while the case is open.
ALTER TABLE flag DROP CONSTRAINT flag_kind_check;
ALTER TABLE flag ADD CONSTRAINT flag_kind_check
  CHECK (kind IN ('shared_device', 'burst', 'far_from_venue', 'impossible_speed', 'minigame', 'nfc_copy',
                  'device_integrity'));
ALTER TABLE flag DROP CONSTRAINT flag_device_kind;
ALTER TABLE flag ADD CONSTRAINT flag_device_kind
  CHECK ((kind IN ('shared_device', 'device_integrity')) = (device_id IS NOT NULL));
CREATE UNIQUE INDEX flag_integrity_once ON flag (enrollment_id, device_id) WHERE kind = 'device_integrity';

CREATE FUNCTION integrity_evidence(c device_check) RETURNS jsonb
  LANGUAGE plpgsql STABLE SET search_path = public, pg_temp AS $$
BEGIN
  RETURN jsonb_build_object('platform', c.platform, 'reasons', to_jsonb(c.reasons), 'checkedAt', c.checked_at);
END $$;
REVOKE ALL ON FUNCTION integrity_evidence(device_check) FROM PUBLIC;

-- One case for the account `n` played on the failed install `c`; an open one takes the newest evidence.
CREATE FUNCTION raise_integrity_flag(n enrollment, c device_check) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO flag (organizer_id, event_id, enrollment_id, kind, device_id, evidence)
  VALUES (n.organizer_id, n.event_id, n.id, 'device_integrity', c.install_id, integrity_evidence(c))
  ON CONFLICT (enrollment_id, device_id) WHERE kind = 'device_integrity' DO UPDATE
    SET evidence = EXCLUDED.evidence, last_seen_at = now()
    WHERE flag.status = 'open';
END $$;
REVOKE ALL ON FUNCTION raise_integrity_flag(enrollment, device_check) FROM PUBLIC;

-- A scan from an install whose latest check failed flags the scanning account (a manual or system-paid completion is
-- no phone's doing and raises nothing). One primary-key read when the completion names an install, none otherwise.
-- Never raises.
CREATE FUNCTION raise_integrity_on_completion() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  c device_check;
  n enrollment;
BEGIN
  IF NEW.method = 'manual' OR system_paid(NEW.method, NEW.idempotency_key) THEN
    RETURN NULL;
  END IF;
  SELECT * INTO c FROM device_check d WHERE d.install_id = NEW.device_id AND d.verdict = 'failed';
  IF FOUND THEN
    SELECT * INTO n FROM enrollment e WHERE e.id = NEW.enrollment_id;
    PERFORM raise_integrity_flag(n, c);
  END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION raise_integrity_on_completion() FROM PUBLIC;
CREATE TRIGGER quest_completion_integrity_flag AFTER INSERT ON quest_completion
  FOR EACH ROW WHEN (NEW.device_id IS NOT NULL) EXECUTE FUNCTION raise_integrity_on_completion();

-- ================================================================ the player doors (ADR-833)
-- The API's verdict for the calling active player's install (push_player: an active player's own seat, never a paired
-- device). A failure flags every account (not removed) that scanned from this install in a live event; a pass after a
-- failure closes nothing (the team decides). The verdict is the API's: the database cannot check a vendor's signature.
CREATE FUNCTION record_device_check(install uuid, plat text, passed boolean, why text[]) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  who uuid := push_player();
  c   device_check;
  n   enrollment;
BEGIN
  IF install IS NULL THEN
    RAISE EXCEPTION 'install required' USING ERRCODE = 'DI400';
  END IF;
  INSERT INTO device_check (install_id, platform, verdict, reasons, player_id, checked_at)
  VALUES (install, plat, CASE WHEN passed THEN 'passed' ELSE 'failed' END,
          CASE WHEN passed THEN '{}'::text[] ELSE coalesce(why, '{}') END, who, now())
  ON CONFLICT (install_id) DO UPDATE
    SET platform = EXCLUDED.platform, verdict = EXCLUDED.verdict, reasons = EXCLUDED.reasons,
        player_id = EXCLUDED.player_id, checked_at = EXCLUDED.checked_at
  RETURNING * INTO c;
  IF passed THEN
    RETURN;
  END IF;
  FOR n IN
    SELECT e.* FROM enrollment e
    WHERE e.status <> 'removed'
      AND e.id IN (SELECT q.enrollment_id FROM event ev
                   JOIN quest_completion q ON q.event_id = ev.id AND q.device_id = install
                   WHERE ev.status = 'live')
    ORDER BY e.id
  LOOP
    PERFORM raise_integrity_flag(n, c);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION record_device_check(uuid, text, boolean, text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION record_device_check(uuid, text, boolean, text[]) TO questify_app;

-- Stores a key whose attestation the API verified, for the caller's install. False when the key id is already known
-- (an attestation is made once per key; the stored one stays).
CREATE FUNCTION app_attest_key_add(key bytea, install uuid, spki bytea, dev boolean) RETURNS boolean
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  who uuid := push_player();
BEGIN
  INSERT INTO app_attest_key (key_id, install_id, player_id, public_key, development)
  VALUES (key, install, who, spki, dev)
  ON CONFLICT (key_id) DO NOTHING;
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION app_attest_key_add(bytea, uuid, bytea, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_attest_key_add(bytea, uuid, bytea, boolean) TO questify_app;

-- The key `key` of the caller's install, locked until the transaction ends so two assertions cannot both pass with
-- one counter; no row for a key of another install or none.
CREATE FUNCTION app_attest_key_for(key bytea, install uuid)
  RETURNS TABLE (public_key bytea, sign_count bigint)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM push_player();
  RETURN QUERY SELECT k.public_key, k.sign_count FROM app_attest_key k
  WHERE k.key_id = key AND k.install_id = install FOR UPDATE;
END $$;
REVOKE ALL ON FUNCTION app_attest_key_for(bytea, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_attest_key_for(bytea, uuid) TO questify_app;

-- Moves the key's counter forward after a verified assertion; never back.
CREATE FUNCTION app_attest_key_count(key bytea, install uuid, counter bigint) RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM push_player();
  UPDATE app_attest_key k SET sign_count = counter, used_at = now()
  WHERE k.key_id = key AND k.install_id = install AND k.sign_count < counter;
END $$;
REVOKE ALL ON FUNCTION app_attest_key_count(bytea, uuid, bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_attest_key_count(bytea, uuid, bigint) TO questify_app;

-- ================================================================ erasure (T-217, ADR-834)
-- When an account becomes a tombstone (erase_rows' last UPDATE, every erasure path), the checks and keys it sent go.
-- Its cases went with its enrollments' flags.
CREATE FUNCTION forget_device_checks() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  DELETE FROM device_check WHERE player_id = NEW.id;
  DELETE FROM app_attest_key WHERE player_id = NEW.id;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION forget_device_checks() FROM PUBLIC;
CREATE TRIGGER player_forget_device_checks AFTER UPDATE OF status ON player
  FOR EACH ROW WHEN (OLD.status <> 'deleted' AND NEW.status = 'deleted') EXECUTE FUNCTION forget_device_checks();

-- ================================================================ the Flags page (FR-335)
-- As 0114, with one branch added: a device-integrity case answers its evidence as one line (platform, reason codes,
-- when), so the API reads every kind's evidence as a list.
CREATE OR REPLACE FUNCTION flag_detail(target_event uuid, target_flag bigint)
  RETURNS TABLE (id bigint, kind text, status text, resolution text, note text, raised_at timestamptz,
                 last_seen_at timestamptz, resolved_at timestamptz, resolved_by text, enrollment_id uuid,
                 username text, avatar text, enrollment_status text, paused boolean, hold boolean,
                 evidence jsonb, waiting jsonb, removals jsonb)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ev event := award_event_of(target_event);
BEGIN
  RETURN QUERY
  SELECT f.id, f.kind, f.status, f.resolution, f.note, f.raised_at, f.last_seen_at, f.resolved_at, staff_shown(su.id, ev.organizer_id),
         f.enrollment_id, p.username, p.avatar, n.status, n.redeem_paused_at IS NOT NULL, ev.flag_hold,
         CASE WHEN f.kind = 'shared_device' THEN (
           SELECT coalesce(jsonb_agg(jsonb_build_object('enrollmentId', a.enrollment_id, 'username', ap.username,
                                                        'lastScanAt', a.last_at) ORDER BY a.last_at DESC), '[]')
           FROM (SELECT c.enrollment_id, max(c.created_at) AS last_at FROM quest_completion c
                 WHERE c.event_id = ev.id AND c.device_id = f.device_id GROUP BY c.enrollment_id) a
           JOIN enrollment an ON an.id = a.enrollment_id JOIN player ap ON ap.id = an.player_id)
         WHEN f.kind = 'device_integrity' THEN
           jsonb_build_array(jsonb_build_object('platform', f.evidence ->> 'platform',
                                                'reasons', coalesce(f.evidence -> 'reasons', '[]'),
                                                'checkedAt', f.evidence ->> 'checkedAt'))
         WHEN f.kind = 'minigame' THEN (
           SELECT coalesce(jsonb_agg(jsonb_build_object('at', x.entry ->> 'at', 'roundId', x.entry -> 'round',
                                                        'game', x.entry ->> 'game', 'level', x.entry ->> 'level',
                                                        'reason', x.entry ->> 'reason', 'verdict', r.status,
                                                        'result', r.result,
                                                        'questAr', q.title_ar, 'questEn', q.title_en)
                                     ORDER BY x.n), '[]')
           FROM jsonb_array_elements(f.evidence -> 'rounds') WITH ORDINALITY AS x(entry, n)
           LEFT JOIN game_round r ON r.id = (x.entry ->> 'round')::bigint AND r.enrollment_id = f.enrollment_id
           LEFT JOIN quest q ON q.id = r.quest_id)
         ELSE (
           SELECT coalesce(jsonb_agg(jsonb_build_object('at', c.created_at, 'method', c.method, 'questAr', q.title_ar,
                                                        'questEn', q.title_en, 'operator', op.username,
                                                        'distanceM', cp.venue_distance_m, 'accuracyM', cp.accuracy_m,
                                                        'mocked', cp.mocked,
                                                        'gapM', CASE WHEN q.place_lat IS NOT NULL AND pv.id IS NOT NULL THEN rounded_m(
                                                          place_gap_m(q.place_lat, q.place_lng, q.place_radius_m,
                                                                      pv.place_lat, pv.place_lng, pv.place_radius_m))
                                                          END,
                                                        'seconds', CASE WHEN q.place_lat IS NOT NULL AND pv.id IS NOT NULL THEN
                                                          round(extract(epoch FROM c.created_at - pv.created_at))::integer
                                                          END)
                                     ORDER BY c.id), '[]')
           FROM quest_completion c
           JOIN quest q ON q.id = c.quest_id
           LEFT JOIN ledger_entry l ON l.completion_id = c.id AND l.kind = 'quest'
           LEFT JOIN player op ON op.id = l.operator_id
           LEFT JOIN completion_position cp ON cp.completion_id = c.id
           LEFT JOIN LATERAL previous_placed(c) pv ON true
           WHERE c.enrollment_id = f.enrollment_id
             AND c.id IN (SELECT (x #>> '{}')::bigint FROM jsonb_array_elements(f.evidence -> 'completions') x))
         END,
         (SELECT coalesce(jsonb_agg(jsonb_build_object('nameAr', coalesce(r.name_ar, k.name_ar, i.name_ar),
                                                       'nameEn', coalesce(r.name_en, k.name_en, i.name_en),
                                                       'reservedUntil', d.reserved_until) ORDER BY d.created_at), '[]')
          FROM redemption d LEFT JOIN reward r ON r.id = d.reward_id LEFT JOIN rank_prize k ON k.id = d.rank_prize_id
          LEFT JOIN quest_item i ON i.id = d.quest_item_id
          WHERE d.enrollment_id = f.enrollment_id AND d.status = 'reserved'),
         (SELECT coalesce(jsonb_agg(jsonb_build_object('entryId', l.id, 'at', l.created_at, 'score', l.score_delta,
                                                       'balance', l.balance_delta, 'reason', ln.reason)
                                    ORDER BY l.id), '[]')
          FROM ledger_entry l LEFT JOIN ledger_note ln ON ln.entry_id = l.id
          WHERE l.enrollment_id = f.enrollment_id AND l.kind = 'removal' AND l.created_at >= f.raised_at)
  FROM flag f
  JOIN enrollment n ON n.id = f.enrollment_id
  JOIN player p ON p.id = n.player_id
  LEFT JOIN staff_user su ON su.id = f.resolved_by
  WHERE f.id = target_flag AND f.event_id = ev.id;
END $$;
