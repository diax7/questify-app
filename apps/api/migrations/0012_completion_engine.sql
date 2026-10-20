-- The completion engine and the points ledger (T-105). A player completes a quest through one definer function,
-- `complete_quest`, which checks every rule itself and is the only writer of completions and ledger entries; a trigger
-- keeps the enrollment's score and balance equal to the ledger's sums (ADR-111). The ledger is append-only for every
-- role, the owner included (FR-317, NFR-019). Deny by default (docs/rules.md): forced row-level security, no write
-- grants, definer functions with a pinned search_path executable by questify_app only.

-- ================================================================ player sessions (lookup only; T-107 issues them)
CREATE TABLE player_session (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id  uuid NOT NULL REFERENCES player (id),
  token_hash bytea NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX player_session_player_idx ON player_session (player_id);
ALTER TABLE player_session ENABLE ROW LEVEL SECURITY;
ALTER TABLE player_session FORCE ROW LEVEL SECURITY;
REVOKE ALL ON player_session FROM PUBLIC;

-- The player a bearer token belongs to: only an active player, a session not expired and not revoked.
CREATE FUNCTION player_session_owner(hash bytea) RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT s.player_id FROM player_session s JOIN player p ON p.id = s.player_id
  WHERE s.token_hash = hash AND s.revoked_at IS NULL AND s.expires_at > now() AND p.status = 'active'
$$;
REVOKE ALL ON FUNCTION player_session_owner(bytea) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION player_session_owner(bytea) TO questify_app;

-- ================================================================ keys the composite foreign keys point at
ALTER TABLE enrollment ADD CONSTRAINT enrollment_id_event_key UNIQUE (id, event_id);
ALTER TABLE quest ADD CONSTRAINT quest_id_event_key UNIQUE (id, event_id);

-- ================================================================ completions
CREATE TABLE quest_completion (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organizer_id    uuid NOT NULL,
  event_id        uuid NOT NULL,
  enrollment_id   uuid NOT NULL,
  quest_id        uuid NOT NULL,
  -- The n-th time this player completed this quest (FR-227): 1 for a one-time quest.
  occurrence      integer NOT NULL CHECK (occurrence BETWEEN 1 AND 100),
  method          text NOT NULL CHECK (method IN ('qr', 'code')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  -- The app's install id when it sent one (FR-316): personal data, so it lives here, where account deletion can clear
  -- it, never on the append-only ledger.
  device_id       uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (enrollment_id, quest_id, occurrence),
  UNIQUE (enrollment_id, idempotency_key),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE RESTRICT,
  FOREIGN KEY (enrollment_id, event_id) REFERENCES enrollment (id, event_id) ON DELETE RESTRICT,
  FOREIGN KEY (quest_id, event_id) REFERENCES quest (id, event_id) ON DELETE RESTRICT
);
CREATE INDEX quest_completion_quest_idx ON quest_completion (quest_id, created_at);

-- ================================================================ the points ledger
CREATE TABLE ledger_entry (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organizer_id  uuid NOT NULL,
  event_id      uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  -- Each later writer widens this list and says which of the two sums it moves (spend: balance only, ADR-043).
  kind          text NOT NULL CHECK (kind IN ('quest')),
  score_delta   bigint NOT NULL,
  balance_delta bigint NOT NULL,
  completion_id bigint REFERENCES quest_completion (id) ON DELETE RESTRICT,
  quest_id      uuid REFERENCES quest (id) ON DELETE RESTRICT,
  actor         text NOT NULL CHECK (actor IN ('player')),
  operator_id   uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'quest' OR (completion_id IS NOT NULL AND quest_id IS NOT NULL
                             AND score_delta >= 0 AND balance_delta >= 0)),
  FOREIGN KEY (event_id, organizer_id) REFERENCES event (id, organizer_id) ON DELETE RESTRICT,
  FOREIGN KEY (enrollment_id, event_id) REFERENCES enrollment (id, event_id) ON DELETE RESTRICT
);
-- A second guard against paying one completion twice.
CREATE UNIQUE INDEX ledger_entry_quest_completion_key ON ledger_entry (completion_id) WHERE kind = 'quest';
CREATE INDEX ledger_entry_enrollment_idx ON ledger_entry (enrollment_id, id);
CREATE INDEX ledger_entry_event_idx ON ledger_entry (event_id, created_at);

-- Append-only for every role, the owner included, exactly as the audit log (0006): the triggers fire ALWAYS, so a
-- session that sets session_replication_role cannot skip them. Changing the table itself (DDL) goes through reviewed
-- migrations only.
CREATE FUNCTION ledger_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'points entries can never be changed or removed; a correction is a new entry'
    USING ERRCODE = 'insufficient_privilege';
END $$;
REVOKE ALL ON FUNCTION ledger_append_only() FROM PUBLIC;
CREATE TRIGGER ledger_no_update_or_delete BEFORE UPDATE OR DELETE ON ledger_entry
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();
CREATE TRIGGER ledger_no_truncate BEFORE TRUNCATE ON ledger_entry
  FOR EACH STATEMENT EXECUTE FUNCTION ledger_append_only();
ALTER TABLE ledger_entry ENABLE ALWAYS TRIGGER ledger_no_update_or_delete;
ALTER TABLE ledger_entry ENABLE ALWAYS TRIGGER ledger_no_truncate;

-- The enrollment's caches move with every entry, whoever writes it (ADR-111): score and balance stay the ledger's sums.
CREATE FUNCTION apply_ledger_entry() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE enrollment SET score = score + NEW.score_delta, balance = balance + NEW.balance_delta
  WHERE id = NEW.enrollment_id;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION apply_ledger_entry() FROM PUBLIC;
CREATE TRIGGER apply_ledger_entry AFTER INSERT ON ledger_entry
  FOR EACH ROW EXECUTE FUNCTION apply_ledger_entry();

-- ================================================================ who may read; nobody but the function writes
ALTER TABLE quest_completion ENABLE ROW LEVEL SECURITY;
ALTER TABLE quest_completion FORCE ROW LEVEL SECURITY;
ALTER TABLE ledger_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entry FORCE ROW LEVEL SECURITY;
REVOKE ALL ON quest_completion, ledger_entry FROM PUBLIC;
GRANT SELECT ON quest_completion, ledger_entry TO questify_app;

CREATE POLICY quest_completion_read ON quest_completion FOR SELECT TO questify_app
  USING ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope()))
         OR app_is_admin()
         OR enrollment_id IN (SELECT id FROM enrollment WHERE player_id = app_player_id()));
CREATE POLICY ledger_entry_read ON ledger_entry FOR SELECT TO questify_app
  USING ((organizer_id = app_organizer_id() AND in_event_scope(event_id, app_event_scope()))
         OR app_is_admin()
         OR enrollment_id IN (SELECT id FROM enrollment WHERE player_id = app_player_id()));

-- ================================================================ completing a quest
-- The caller is the player of the request context (`app.player_id`), never an argument. Every rule is checked here,
-- under a lock on the player's enrollment, so two scans of one player run one after the other. The quest row is not
-- locked: a completion that started before a regenerate commits may pass; commit order decides. Refusals raise:
--   QC404 quest not found or not enrolled            QK422 the key was used for another quest or method
--   QC403 enrollment not active (DETAIL: its status) QN403 quest not open (DETAIL: event_not_live|hidden|not_started|ended)
--   QV422 bad proof (DETAIL: wrong_method|old|wrong_code)  QD409 cap reached (DETAIL: the cap)
-- A retry with the same key returns the first completion with the current score and balance, whatever has changed.
CREATE FUNCTION complete_quest(target uuid, proof_method text, proof_version integer, typed_code text,
                               request_key text, device uuid)
  RETURNS TABLE (completion_id bigint, points bigint, occurrence integer, score bigint, balance bigint,
                 replayed boolean)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  me         uuid := app_player_id();
  quest_row  quest%ROWTYPE;
  enrolled   enrollment%ROWTYPE;
  earlier    quest_completion%ROWTYPE;
  status_now text;
  done_count integer;
  made       bigint;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'no player in this request' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO quest_row FROM quest WHERE id = target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quest not found' USING ERRCODE = 'QC404';
  END IF;
  SELECT * INTO enrolled FROM enrollment WHERE event_id = quest_row.event_id AND player_id = me FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quest not found' USING ERRCODE = 'QC404';
  END IF;

  SELECT * INTO earlier FROM quest_completion c
  WHERE c.enrollment_id = enrolled.id AND c.idempotency_key = request_key;
  IF FOUND THEN
    IF earlier.quest_id <> target OR earlier.method <> proof_method THEN
      RAISE EXCEPTION 'this key was used for another completion' USING ERRCODE = 'QK422';
    END IF;
    RETURN QUERY SELECT earlier.id, l.score_delta, earlier.occurrence, enrolled.score, enrolled.balance, true
      FROM ledger_entry l WHERE l.completion_id = earlier.id AND l.kind = 'quest';
    RETURN;
  END IF;

  IF enrolled.status <> 'active' THEN
    RAISE EXCEPTION 'enrollment not active' USING ERRCODE = 'QC403', DETAIL = enrolled.status;
  END IF;
  SELECT event_status_now(e.status, e.starts_at, e.ends_at) INTO status_now FROM event e WHERE e.id = quest_row.event_id;
  IF status_now <> 'live' THEN
    RAISE EXCEPTION 'quest not open' USING ERRCODE = 'QN403', DETAIL = 'event_not_live';
  END IF;
  IF NOT quest_row.visible THEN
    RAISE EXCEPTION 'quest not open' USING ERRCODE = 'QN403', DETAIL = 'hidden';
  END IF;
  IF quest_row.opens_at IS NOT NULL AND quest_row.opens_at > now() THEN
    RAISE EXCEPTION 'quest not open' USING ERRCODE = 'QN403', DETAIL = 'not_started';
  END IF;
  IF quest_row.closes_at IS NOT NULL AND quest_row.closes_at <= now() THEN
    RAISE EXCEPTION 'quest not open' USING ERRCODE = 'QN403', DETAIL = 'ended';
  END IF;

  -- FR-302: a completion only through the method the quest's type has.
  IF NOT ((quest_row.type = 'scan_qr' AND proof_method = 'qr') OR (quest_row.type = 'enter_code' AND proof_method = 'code')) THEN
    RAISE EXCEPTION 'bad proof' USING ERRCODE = 'QV422', DETAIL = 'wrong_method';
  END IF;
  IF proof_method = 'qr' AND proof_version IS DISTINCT FROM quest_row.qr_version THEN
    RAISE EXCEPTION 'bad proof' USING ERRCODE = 'QV422', DETAIL = 'old';
  END IF;
  IF proof_method = 'code' AND (typed_code IS NULL OR typed_code IS DISTINCT FROM quest_row.type_config ->> 'code') THEN
    RAISE EXCEPTION 'bad proof' USING ERRCODE = 'QV422', DETAIL = 'wrong_code';
  END IF;

  SELECT count(*) INTO done_count FROM quest_completion c
  WHERE c.enrollment_id = enrolled.id AND c.quest_id = target;
  IF done_count >= quest_row.repeat_cap THEN
    RAISE EXCEPTION 'already completed' USING ERRCODE = 'QD409', DETAIL = quest_row.repeat_cap::text;
  END IF;

  INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method,
                                idempotency_key, device_id)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, target, done_count + 1, proof_method,
          request_key, device)
  RETURNING id INTO made;
  INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta,
                            completion_id, quest_id, actor)
  VALUES (enrolled.organizer_id, enrolled.event_id, enrolled.id, 'quest', quest_row.points, quest_row.points, made, target,
          'player');

  RETURN QUERY SELECT made, quest_row.points::bigint, done_count + 1, e.score, e.balance, false
    FROM enrollment e WHERE e.id = enrolled.id;
END $$;
REVOKE ALL ON FUNCTION complete_quest(uuid, text, integer, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION complete_quest(uuid, text, integer, text, text, uuid) TO questify_app;
