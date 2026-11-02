-- T-708: legal data requests (FR-1418, FR-1776, FR-1778; plan docs/plans/2026-11-03-t-708-data-requests.md; ADR-480 to
-- ADR-485). A player downloads their own data (own_data_export); an admin exports or erases one player's data on a
-- legal request (console_player_export, admin_erase_player), recorded in the audit log with the admin, a reason code and
-- an opaque case reference. The export is built here at the moment it is asked for and is never stored.
-- erase_player's body moves into erase_account (shared by the self, admin and re-apply paths); a tombstone can never
-- change again (player_tombstone_final, ENABLE ALWAYS); reapply_erasure is owner-only, for the runbook after a restore.
-- Deny by default: every new function is revoked from PUBLIC in its own statement group; only own_data_export,
-- console_player_export, admin_erase_player and console_player_pending are granted to questify_app. No new table.
SET LOCAL lock_timeout = '10s';

-- ================================================================ shared pieces
-- A time in the export: ISO-8601 in UTC, Western digits.
CREATE FUNCTION export_time(t timestamptz) RETURNS text
  LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS $$
  SELECT to_char(t AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;
REVOKE ALL ON FUNCTION export_time(timestamptz) FROM PUBLIC;

-- Why an admin acts on a data request, and the case it belongs to (ADR-483). The reference is an opaque case number:
-- 3 to 64 of A-Z a-z 0-9 . _ / -, at least one letter, and no run of 8 or more digits, so no name, email, phone or
-- national id can be typed into the durable record. DR400 names the field in its message.
CREATE FUNCTION data_request_reason(reason_code text, reference text) RETURNS void
  LANGUAGE plpgsql IMMUTABLE SET search_path = public, pg_temp AS $$
BEGIN
  IF reason_code IS NULL OR reason_code NOT IN ('legal_request', 'player_request') THEN
    RAISE EXCEPTION 'reasonCode' USING ERRCODE = 'DR400';
  END IF;
  IF reference IS NULL OR reference !~ '^[A-Za-z0-9._/-]{3,64}$' OR reference !~ '[A-Za-z]'
     OR reference ~ '[0-9]{8,}' THEN
    RAISE EXCEPTION 'reference' USING ERRCODE = 'DR400';
  END IF;
END $$;
REVOKE ALL ON FUNCTION data_request_reason(text, text) FROM PUBLIC;

-- The player's notice after their own export (fixed text, no name; push text carries nothing personal). Opens the center.
INSERT INTO notice_kind (kind, class, topic, membership, before_start, priority, ttl) VALUES
  ('data_exported', 'personal', NULL, 'none', false, 0, interval '7 days');

-- The 24-hour export count and the legal history of a record read this.
CREATE INDEX audit_log_data_request_idx ON audit_log (target_id, at)
  WHERE action IN ('player.data_export', 'player.delete');

-- ================================================================ the tombstone is final (FR-1776, ADR-484)
-- No column of a deleted account ever changes and the row is never removed, for every role and in replica mode.
-- erase_rows makes the tombstone in its last UPDATE, whose OLD.status is still active or banned.
CREATE FUNCTION player_tombstone_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'deleted' AND (TG_OP = 'DELETE' OR NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'a deleted account can never be restored' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
REVOKE ALL ON FUNCTION player_tombstone_final() FROM PUBLIC;
CREATE TRIGGER player_tombstone_final BEFORE UPDATE OR DELETE ON player
  FOR EACH ROW EXECUTE FUNCTION player_tombstone_final();
ALTER TABLE player ENABLE ALWAYS TRIGGER player_tombstone_final;

-- ================================================================ erasing, shared by every path (D4)
-- erase_player's body from the enrollment locks to ranking_repair; the caller holds the player FOR UPDATE. `challenge`
-- is the self-deletion's challenge, marked used (and let go of the player and the contact) between erase_marks and
-- erase_rows as 0038 did; NULL on the admin and re-apply paths. handover_pending changes nothing (the challenge stays
-- usable). The caller writes the audit entry with its own actor.
CREATE FUNCTION erase_account(me player, key bytea, forfeit boolean, challenge uuid)
  RETURNS TABLE (outcome text, enrolled integer, events uuid[], forfeited integer, marks integer)
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  ids     uuid[];
  boards  uuid[];
  pending uuid[];
  item    uuid;
  made    integer;
BEGIN
  PERFORM 1 FROM enrollment n WHERE n.player_id = me.id ORDER BY n.id FOR NO KEY UPDATE;
  SELECT coalesce(array_agg(n.id ORDER BY n.id), '{}') INTO ids FROM enrollment n WHERE n.player_id = me.id;
  SELECT coalesce(array_agg(d.id ORDER BY d.id), '{}') INTO pending
  FROM redemption d WHERE d.enrollment_id = ANY (ids) AND d.status = 'reserved';
  IF cardinality(pending) > 0 AND NOT coalesce(forfeit, false) THEN
    RETURN QUERY SELECT 'handover_pending'::text, 0, '{}'::uuid[], 0, 0;
    RETURN;
  END IF;
  FOREACH item IN ARRAY pending LOOP
    PERFORM end_reservation(item, 'cancelled', 'erasure', 'system', NULL);
  END LOOP;
  -- The boards the player was on, read before erase_rows ends the enrollments: each is rebuilt without them.
  SELECT coalesce(array_agg(DISTINCT n.event_id), '{}') INTO boards
  FROM enrollment n WHERE n.id = ANY (ids) AND n.status = 'active';
  made := erase_marks(me);
  IF challenge IS NOT NULL THEN
    UPDATE player_deletion_challenge SET erased_at = now(), player_id = NULL, contact_key = NULL WHERE id = challenge;
  END IF;
  PERFORM erase_rows(me.id, ids, key);
  INSERT INTO ranking_repair (event_id) SELECT unnest(boards)
  ON CONFLICT (event_id) DO UPDATE SET marked_at = now();
  RETURN QUERY SELECT 'erased'::text, cardinality(ids),
                      coalesce((SELECT array_agg(DISTINCT n.event_id) FROM enrollment n WHERE n.id = ANY (ids)), '{}'),
                      cardinality(pending), made;
END $$;
REVOKE ALL ON FUNCTION erase_account(player, bytea, boolean, uuid) FROM PUBLIC;

-- As 0038 (same signature, grants and outcomes), with the body in erase_account. Lock order: the deletion challenge FOR
-- UPDATE, then the player FOR UPDATE; the admin and re-apply paths take the same order.
CREATE OR REPLACE FUNCTION erase_player(deletion bytea, forfeit boolean, request uuid)
  RETURNS TABLE (outcome text, player_id uuid, events uuid[])
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  held player_deletion_challenge%ROWTYPE;
  me   player%ROWTYPE;
  done record;
BEGIN
  SELECT c.* INTO held FROM player_deletion_challenge c WHERE c.deletion_hash = deletion FOR UPDATE;
  IF FOUND AND held.erased_at IS NOT NULL THEN
    RETURN QUERY SELECT 'replayed'::text, NULL::uuid, '{}'::uuid[];
    RETURN;
  END IF;
  IF NOT FOUND OR held.deletion_expires_at <= now() THEN
    RETURN QUERY SELECT 'expired'::text, NULL::uuid, '{}'::uuid[];
    RETURN;
  END IF;
  SELECT p.* INTO me FROM player p WHERE p.id = held.player_id FOR UPDATE;
  IF me.status NOT IN ('active', 'banned') THEN
    RETURN QUERY SELECT 'expired'::text, NULL::uuid, '{}'::uuid[];
    RETURN;
  END IF;
  SELECT * INTO done FROM erase_account(me, held.contact_key, forfeit, held.id);
  IF done.outcome = 'handover_pending' THEN
    RETURN QUERY SELECT 'handover_pending'::text, NULL::uuid, '{}'::uuid[];
    RETURN;
  END IF;
  INSERT INTO audit_log (actor_type, action, target_type, target_id, after, request_id)
  VALUES ('system', 'player.delete', 'player', me.id::text,
          jsonb_build_object('events', done.enrolled, 'forfeited', done.forfeited, 'marks', done.marks), request);
  RETURN QUERY SELECT 'erased'::text, me.id, done.events;
END $$;
REVOKE ALL ON FUNCTION erase_player(bytea, boolean, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION erase_player(bytea, boolean, uuid) TO questify_app;

-- The account an admin or the re-apply erases, locked in erase_player's order: every deletion challenge of the player
-- (by id) FOR UPDATE, then the player FOR UPDATE. A self-erase holding its challenge finishes first (this then finds a
-- tombstone); one waiting for its challenge finds it deleted afterwards (expired). NULL for an unknown id.
CREATE FUNCTION erase_target(target uuid) RETURNS player
  LANGUAGE plpgsql VOLATILE SET search_path = public, pg_temp AS $$
DECLARE
  hit player;
BEGIN
  PERFORM 1 FROM player_deletion_challenge c WHERE c.player_id = target ORDER BY c.id FOR UPDATE;
  SELECT p.* INTO hit FROM player p WHERE p.id = target FOR UPDATE;
  RETURN hit;
END $$;
REVOKE ALL ON FUNCTION erase_target(uuid) FROM PUBLIC;

-- An admin erases one player on a legal or the player's own request (FR-1778, ADR-483). The username typed exactly
-- (DR409) so a mistyped id cannot erase the wrong account. Outcomes: erased, handover_pending (nothing changed; the
-- console lists console_player_pending and asks for the forfeit), already_deleted (a repeat of a finished request).
CREATE FUNCTION admin_erase_player(target uuid, reason_code text, reference text, typed_username text,
                                   forfeit boolean, request uuid)
  RETURNS TABLE (outcome text, events uuid[])
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me   uuid := console_admin();
  p    player;
  done record;
BEGIN
  PERFORM data_request_reason(reason_code, reference);
  p := erase_target(target);
  IF p.id IS NULL THEN
    RAISE EXCEPTION 'no such player' USING ERRCODE = 'PA404';
  END IF;
  IF p.status = 'deleted' THEN
    RETURN QUERY SELECT 'already_deleted'::text, '{}'::uuid[];
    RETURN;
  END IF;
  IF typed_username IS NULL OR typed_username IS DISTINCT FROM p.username THEN
    RAISE EXCEPTION 'the username does not match' USING ERRCODE = 'DR409';
  END IF;
  SELECT * INTO done FROM erase_account(p, NULL, forfeit, NULL);
  IF done.outcome = 'handover_pending' THEN
    RETURN QUERY SELECT 'handover_pending'::text, '{}'::uuid[];
    RETURN;
  END IF;
  INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, after, request_id)
  VALUES ('admin', me, 'player.delete', 'player', p.id::text,
          jsonb_build_object('source', 'admin', 'reasonCode', reason_code, 'reference', reference,
                             'events', done.enrolled, 'forfeited', done.forfeited, 'marks', done.marks), request);
  RETURN QUERY SELECT 'erased'::text, done.events;
END $$;
REVOKE ALL ON FUNCTION admin_erase_player(uuid, text, text, text, boolean, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_erase_player(uuid, text, text, text, boolean, uuid) TO questify_app;

-- After a database restore, before traffic (RUNBOOK "Re-apply erasures", ADR-484): erases again an account erased after
-- the backup. Owner-only (no grant); forfeits pending handovers; a tombstone or an unknown id is skipped.
CREATE FUNCTION reapply_erasure(target uuid, request uuid) RETURNS text
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  p    player;
  done record;
BEGIN
  p := erase_target(target);
  IF p.id IS NULL THEN
    RETURN 'unknown';
  END IF;
  IF p.status = 'deleted' THEN
    RETURN 'already_deleted';
  END IF;
  SELECT * INTO done FROM erase_account(p, NULL, true, NULL);
  INSERT INTO audit_log (actor_type, action, target_type, target_id, after, request_id)
  VALUES ('system', 'player.delete', 'player', p.id::text,
          jsonb_build_object('source', 'reapply', 'events', done.enrolled, 'forfeited', done.forfeited,
                             'marks', done.marks), request);
  RETURN 'erased';
END $$;
REVOKE ALL ON FUNCTION reapply_erasure(uuid, uuid) FROM PUBLIC;

-- The handovers still pending for a player, for the admin erase (deletion_pending's player-id twin). PA404 for a
-- tombstone or an unknown id.
CREATE FUNCTION console_player_pending(target uuid)
  RETURNS TABLE (redemption_id uuid, event_id uuid, event_ar text, event_en text, item_ar text, item_en text,
                 rank_prize boolean)
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me uuid := console_admin();
  p  player := player_for_admin(target, false);
BEGIN
  RETURN QUERY
  SELECT d.id, e.id, e.name_ar, e.name_en, coalesce(r.name_ar, k.name_ar), coalesce(r.name_en, k.name_en),
         d.rank_prize_id IS NOT NULL
  FROM redemption d
  JOIN enrollment n ON n.id = d.enrollment_id
  JOIN event e ON e.id = d.event_id
  LEFT JOIN reward r ON r.id = d.reward_id
  LEFT JOIN rank_prize k ON k.id = d.rank_prize_id
  WHERE n.player_id = p.id AND d.status = 'reserved' AND me IS NOT NULL
  ORDER BY d.created_at, d.id;
END $$;
REVOKE ALL ON FUNCTION console_player_pending(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_player_pending(uuid) TO questify_app;

-- ================================================================ the export (D1, ADR-481)
-- The account side: profile, contacts in full (the owner's own data), names, acceptances, choices, devices and
-- sessions without any token, invitations received.
CREATE FUNCTION export_account(p player) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'account', jsonb_build_object(
      'username', p.username, 'birthYear', p.birth_year, 'avatar', p.avatar, 'status', p.status,
      'createdAt', export_time(p.created_at),
      'level', coalesce((SELECT xp_level_of(x.xp) FROM player_xp x WHERE x.player_id = p.id), 1),
      'xp', coalesce((SELECT x.xp FROM player_xp x WHERE x.player_id = p.id), 0),
      'gems', coalesce((SELECT x.gems FROM player_xp x WHERE x.player_id = p.id), 0)),
    'contacts', coalesce((SELECT jsonb_build_object('phone', c.phone_e164, 'email', c.email)
                          FROM player_contact c WHERE c.player_id = p.id),
                         jsonb_build_object('phone', NULL, 'email', NULL)),
    'usernames', coalesce((SELECT jsonb_agg(jsonb_build_object('username', h.username, 'reason', h.reason,
                                                               'changedAt', export_time(h.changed_at))
                                            ORDER BY h.changed_at, h.id)
                           FROM username_history h WHERE h.player_id = p.id), '[]'),
    'acceptances', coalesce((SELECT jsonb_agg(jsonb_build_object('document', a.document, 'version', a.version,
                                                                 'method', a.method,
                                                                 'acceptedAt', export_time(a.accepted_at))
                                              ORDER BY a.accepted_at, a.document)
                             FROM player_acceptance a WHERE a.player_id = p.id), '[]'),
    'marketing', jsonb_build_object(
      'consents', coalesce((SELECT jsonb_agg(jsonb_build_object('channel', m.channel, 'granted', m.granted,
                                                                'method', m.method, 'textVersion', m.text_version,
                                                                'language', m.language,
                                                                'at', export_time(m.created_at))
                                             ORDER BY m.created_at, m.id)
                            FROM marketing_consent m WHERE m.player_id = p.id), '[]'),
      'state', coalesce((SELECT jsonb_agg(jsonb_build_object('channel', m.channel, 'optedIn', m.opted_in,
                                                             'language', m.language,
                                                             'changedAt', export_time(m.changed_at))
                                          ORDER BY m.channel)
                         FROM marketing_state m WHERE m.player_id = p.id), '[]')),
    'preferences', (SELECT jsonb_build_object('cityId', f.city_id, 'interests', to_jsonb(f.interests),
                                              'updatedAt', export_time(f.updated_at))
                    FROM player_preference f WHERE f.player_id = p.id),
    'pushTopics', jsonb_build_object(
      'muted', coalesce((SELECT jsonb_agg(jsonb_build_object('topic', t.topic, 'at', export_time(t.muted_at))
                                          ORDER BY t.topic)
                         FROM push_topic_mute t WHERE t.player_id = p.id), '[]'),
      'on', coalesce((SELECT jsonb_agg(jsonb_build_object('topic', t.topic, 'at', export_time(t.chosen_at))
                                       ORDER BY t.topic)
                      FROM push_topic_on t WHERE t.player_id = p.id), '[]')),
    'devices', coalesce((SELECT jsonb_agg(jsonb_build_object('platform', d.platform, 'language', d.language,
                                                             'appVersion', d.app_version,
                                                             'createdAt', export_time(d.token_set_at),
                                                             'lastSeenAt', export_time(d.seen_at))
                                          ORDER BY d.token_set_at, d.id)
                         FROM push_device d WHERE d.player_id = p.id), '[]'),
    'sessions', coalesce((SELECT jsonb_agg(jsonb_build_object('createdAt', export_time(s.created_at),
                                                              'expiresAt', export_time(s.expires_at),
                                                              'endedAt', export_time(s.revoked_at))
                                           ORDER BY s.created_at, s.id)
                          FROM player_session s WHERE s.player_id = p.id), '[]'),
    'invitations', coalesce((SELECT jsonb_agg(jsonb_build_object('channel', i.channel, 'state', i.state,
                                                                 'createdAt', export_time(i.created_at),
                                                                 'sentAt', export_time(i.sent_at),
                                                                 'openedAt', export_time(i.opened_at),
                                                                 'joinedAt', export_time(i.joined_at))
                                              ORDER BY i.created_at, i.id)
                             FROM invitation_recipient i WHERE i.player_id = p.id), '[]'))
$$;
REVOKE ALL ON FUNCTION export_account(player) FROM PUBLIC;

-- One event's play: what the player did and earned. Names come in both languages; never another player.
CREATE FUNCTION export_event_play(n enrollment) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'completions', coalesce((SELECT jsonb_agg(jsonb_build_object(
                                      'questId', c.quest_id, 'quest', jsonb_build_object('ar', q.title_ar, 'en', q.title_en),
                                      'method', c.method, 'at', export_time(c.created_at)) ORDER BY c.created_at, c.id)
                             FROM quest_completion c JOIN quest q ON q.id = c.quest_id
                             WHERE c.enrollment_id = n.id), '[]'),
    'completionPlaces', coalesce((SELECT jsonb_agg(jsonb_build_object(
                                           'accuracyM', l.accuracy_m, 'venueDistanceM', l.venue_distance_m,
                                           'mocked', l.mocked, 'at', export_time(l.created_at))
                                         ORDER BY l.created_at, l.completion_id)
                                  FROM completion_position l WHERE l.enrollment_id = n.id), '[]'),
    'ledger', coalesce((SELECT jsonb_agg(jsonb_build_object(
                                 'kind', l.kind, 'score', l.score_delta, 'balance', l.balance_delta,
                                 'questId', l.quest_id, 'quest', CASE WHEN q.id IS NOT NULL
                                   THEN jsonb_build_object('ar', q.title_ar, 'en', q.title_en) END,
                                 'at', export_time(l.created_at)) ORDER BY l.created_at, l.id)
                        FROM ledger_entry l LEFT JOIN quest q ON q.id = l.quest_id
                        WHERE l.enrollment_id = n.id), '[]'),
    'redemptions', coalesce((SELECT jsonb_agg(jsonb_build_object(
                                      'item', jsonb_build_object('ar', coalesce(r.name_ar, k.name_ar, i.name_ar),
                                                                 'en', coalesce(r.name_en, k.name_en, i.name_en)),
                                      'price', d.price, 'status', d.status, 'endedBy', d.ended_by,
                                      'at', export_time(d.created_at), 'endedAt', export_time(d.ended_at))
                                    ORDER BY d.created_at, d.id)
                             FROM redemption d LEFT JOIN reward r ON r.id = d.reward_id
                             LEFT JOIN rank_prize k ON k.id = d.rank_prize_id
                             LEFT JOIN quest_item i ON i.id = d.quest_item_id
                             WHERE d.enrollment_id = n.id), '[]'),
    'deskSales', coalesce((SELECT jsonb_agg(jsonb_build_object(
                                    'item', jsonb_build_object('ar', r.name_ar, 'en', r.name_en), 'price', s.price,
                                    'status', s.status, 'at', export_time(s.created_at)) ORDER BY s.created_at, s.id)
                           FROM desk_sale s JOIN reward r ON r.id = s.reward_id WHERE s.enrollment_id = n.id), '[]'),
    'submissions', coalesce((SELECT jsonb_agg(jsonb_build_object(
                                      'questId', s.quest_id, 'kind', s.kind, 'body', s.body, 'status', s.status,
                                      'points', s.points, 'reason', s.reason, 'at', export_time(s.created_at))
                                    ORDER BY s.created_at, s.id)
                             FROM submission s WHERE s.enrollment_id = n.id), '[]'),
    'votes', coalesce((SELECT jsonb_agg(jsonb_build_object('questId', v.quest_id, 'option', v.option_id,
                                                           'at', export_time(v.created_at)) ORDER BY v.created_at)
                       FROM quest_vote v WHERE v.enrollment_id = n.id), '[]'),
    'surveyResponses', coalesce((SELECT jsonb_agg(jsonb_build_object('questId', v.quest_id, 'answers', v.answers,
                                                                     'at', export_time(v.created_at))
                                                  ORDER BY v.created_at)
                                 FROM survey_response v WHERE v.enrollment_id = n.id), '[]'),
    'quizAnswers', coalesce((SELECT jsonb_agg(jsonb_build_object(
                                      'questId', t.quest_id, 'status', t.status, 'right', t.right_count,
                                      'startedAt', export_time(t.started_at),
                                      'answers', coalesce((SELECT jsonb_agg(jsonb_build_object(
                                                                    'question', a.question_id, 'choice', a.choice_id,
                                                                    'correct', a.correct) ORDER BY a.position)
                                                           FROM quiz_answer a WHERE a.attempt_id = t.id), '[]'))
                                    ORDER BY t.started_at, t.id)
                             FROM quiz_attempt t WHERE t.enrollment_id = n.id), '[]'),
    'gameRounds', coalesce((SELECT jsonb_agg(jsonb_build_object(
                                     'questId', g.quest_id, 'game', g.game, 'level', g.level, 'points', g.points,
                                     'status', g.status, 'result', g.result, 'at', export_time(g.issued_at))
                                   ORDER BY g.issued_at, g.id)
                            FROM game_round g WHERE g.enrollment_id = n.id), '[]'),
    'ratings', coalesce((SELECT jsonb_agg(jsonb_build_object('questId', r.quest_id, 'thumb', r.thumb,
                                                             'at', export_time(r.updated_at)) ORDER BY r.created_at)
                         FROM quest_rating r WHERE r.enrollment_id = n.id), '[]'),
    'cheers', coalesce((SELECT jsonb_agg(jsonb_build_object('reaction', c.reaction, 'at', export_time(c.created_at))
                                         ORDER BY c.created_at, c.id)
                        FROM cheer c WHERE c.enrollment_id = n.id), '[]'))
$$;
REVOKE ALL ON FUNCTION export_event_play(enrollment) FROM PUBLIC;

-- One event's progress, places and roles. A meeting shows when it happened, never the other player.
CREATE FUNCTION export_event_more(n enrollment) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'passportStamps', coalesce((SELECT jsonb_agg(jsonb_build_object('questId', s.quest_id, 'stepId', s.step_id,
                                                                    'at', export_time(s.created_at))
                                                 ORDER BY s.created_at)
                                FROM passport_stamp s WHERE s.enrollment_id = n.id), '[]'),
    'categoryBonuses', coalesce((SELECT jsonb_agg(jsonb_build_object(
                                          'category', jsonb_build_object('ar', c.name_ar, 'en', c.name_en),
                                          'at', export_time(b.created_at)) ORDER BY b.created_at)
                                 FROM category_bonus b JOIN category c ON c.id = b.category_id
                                 WHERE b.enrollment_id = n.id), '[]'),
    'categoriesRevealed', coalesce((SELECT jsonb_agg(jsonb_build_object(
                                             'category', jsonb_build_object('ar', c.name_ar, 'en', c.name_en),
                                             'at', export_time(b.created_at)) ORDER BY b.created_at)
                                    FROM category_reveal b JOIN category c ON c.id = b.category_id
                                    WHERE b.enrollment_id = n.id), '[]'),
    'bonusPlaces', coalesce((SELECT jsonb_agg(jsonb_build_object('questId', b.quest_id, 'place', b.place,
                                                                 'at', export_time(b.claimed_at))
                                              ORDER BY b.claimed_at)
                             FROM quest_bonus_slot b WHERE b.enrollment_id = n.id), '[]'),
    'itemsMissed', coalesce((SELECT jsonb_agg(jsonb_build_object('reason', m.reason, 'at', export_time(m.created_at))
                                              ORDER BY m.created_at, m.id)
                             FROM quest_item_miss m WHERE m.enrollment_id = n.id), '[]'),
    'streakDays', coalesce((SELECT jsonb_agg(jsonb_build_object('day', d.day, 'days', d.days) ORDER BY d.day)
                            FROM event_streak_day d WHERE d.enrollment_id = n.id), '[]'),
    'communityGoals', coalesce((SELECT jsonb_agg(jsonb_build_object(
                                         'goal', jsonb_build_object('ar', g.title_ar, 'en', g.title_en),
                                         'firstAt', export_time(c.first_at)) ORDER BY c.first_at)
                                FROM community_contributor c JOIN community_goal g ON g.id = c.goal_id
                                WHERE c.enrollment_id = n.id), '[]'),
    'communityRewards', coalesce((SELECT jsonb_agg(jsonb_build_object('status', c.status,
                                                                      'at', export_time(c.created_at))
                                                   ORDER BY c.created_at)
                                  FROM community_payout c WHERE c.enrollment_id = n.id), '[]'),
    'sessionsRegistered', coalesce((SELECT jsonb_agg(jsonb_build_object(
                                             'session', jsonb_build_object('ar', s.title_ar, 'en', s.title_en),
                                             'at', export_time(r.created_at)) ORDER BY r.created_at)
                                    FROM session_registration r JOIN event_session s ON s.id = r.session_id
                                    WHERE r.enrollment_id = n.id), '[]'),
    'sessionsAttended', coalesce((SELECT jsonb_agg(jsonb_build_object(
                                           'session', jsonb_build_object('ar', s.title_ar, 'en', s.title_en),
                                           'walkIn', a.walk_in, 'at', export_time(a.checked_in_at))
                                         ORDER BY a.checked_in_at)
                                  FROM session_attendance a JOIN event_session s ON s.id = a.session_id
                                  WHERE a.enrollment_id = n.id), '[]'),
    'meetings', coalesce((SELECT jsonb_agg(jsonb_build_object('questId', m.quest_id, 'at', export_time(m.created_at))
                                           ORDER BY m.created_at, m.id)
                          FROM meeting m WHERE m.scanner_enrollment = n.id OR m.shown_enrollment = n.id), '[]'),
    'finalRank', (SELECT f.rank FROM final_rank f WHERE f.enrollment_id = n.id),
    'resultPlace', (SELECT jsonb_build_object('rank', r.rank, 'score', r.score)
                    FROM result_place r WHERE r.enrollment_id = n.id),
    'staffRoles', coalesce((SELECT jsonb_agg(jsonb_build_object(
                                     'abilities', to_jsonb(a.abilities), 'canPlay', a.can_play,
                                     'quests', coalesce((SELECT jsonb_agg(q.quest_id ORDER BY q.quest_id)
                                                         FROM staff_assignment_quest q
                                                         WHERE q.assignment_id = a.id), '[]'),
                                     'from', export_time(a.created_at)) ORDER BY a.created_at)
                            FROM staff_assignment a WHERE a.player_id = n.player_id AND a.event_id = n.event_id), '[]'),
    'souvenirOnTheWay', EXISTS (SELECT 1 FROM souvenir_work w WHERE w.enrollment_id = n.id))
$$;
REVOKE ALL ON FUNCTION export_event_more(enrollment) FROM PUBLIC;

-- Every event the player joined, with the join answers and both halves above.
CREATE FUNCTION export_events(target uuid) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce(jsonb_agg(
           jsonb_build_object(
             'eventId', e.id, 'name', jsonb_build_object('ar', e.name_ar, 'en', e.name_en),
             'joinedAt', export_time(n.joined_at), 'via', n.joined_via, 'status', n.status, 'score', n.score,
             'balance', n.balance, 'waitlisted', n.waitlisted,
             'joinAnswers', coalesce((SELECT jsonb_agg(jsonb_build_object(
                                               'field', jsonb_build_object('ar', f.label_ar, 'en', f.label_en),
                                               'answer', j.value) ORDER BY f.position, f.id)
                                      FROM join_answer j JOIN event_join_field f ON f.id = j.field_id
                                      WHERE j.enrollment_id = n.id), '[]'))
           || export_event_play(n) || export_event_more(n)
           ORDER BY n.joined_at, n.id), '[]')
  FROM enrollment n JOIN event e ON e.id = n.event_id
  WHERE n.player_id = target
$$;
REVOKE ALL ON FUNCTION export_events(uuid) FROM PUBLIC;

-- The Questify side: levels, XP, gems, achievements, awards, streaks, items with their earned source, souvenirs and
-- the daily games.
CREATE FUNCTION export_questify(target uuid) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'levelReached', coalesce((SELECT jsonb_agg(jsonb_build_object('level', l.level, 'at', export_time(l.reached_at))
                                               ORDER BY l.level) FROM level_reached l WHERE l.player_id = target), '[]'),
    'xpEntries', coalesce((SELECT jsonb_agg(jsonb_build_object('delta', x.delta, 'source', x.source,
                                                               'at', export_time(x.created_at)) ORDER BY x.created_at, x.id)
                           FROM xp_entry x WHERE x.player_id = target), '[]'),
    'gemEntries', coalesce((SELECT jsonb_agg(jsonb_build_object('delta', g.delta, 'source', g.source,
                                                                'at', export_time(g.created_at)) ORDER BY g.created_at, g.id)
                            FROM gem_entry g WHERE g.player_id = target), '[]'),
    'gemPurchases', coalesce((SELECT jsonb_agg(jsonb_build_object('itemId', g.item_id, 'price', g.price,
                                                                  'at', export_time(g.created_at)) ORDER BY g.created_at, g.id)
                              FROM gem_purchase g WHERE g.player_id = target), '[]'),
    'achievements', coalesce((SELECT jsonb_agg(jsonb_build_object('achievementId', a.achievement_id, 'tier', a.tier,
                                                                  'earnedAt', export_time(a.earned_at))
                                               ORDER BY a.earned_at, a.achievement_id, a.tier)
                              FROM achievement_earned a WHERE a.player_id = target), '[]'),
    'achievementChanges', coalesce((SELECT jsonb_agg(jsonb_build_object('achievementId', a.achievement_id,
                                                                        'tier', a.tier, 'change', a.change,
                                                                        'at', export_time(a.created_at))
                                                     ORDER BY a.created_at, a.id)
                                    FROM achievement_revocation a WHERE a.player_id = target), '[]'),
    'awards', coalesce((SELECT jsonb_agg(jsonb_build_object('questId', a.quest_id, 'at', export_time(a.earned_at))
                                         ORDER BY a.earned_at, a.id) FROM questify_award a WHERE a.player_id = target), '[]'),
    'streakDays', coalesce((SELECT jsonb_agg(d.day ORDER BY d.day)
                            FROM questify_streak_day d WHERE d.player_id = target), '[]'),
    'streakRewards', coalesce((SELECT jsonb_agg(jsonb_build_object('days', r.days, 'xp', r.xp,
                                                                   'at', export_time(r.created_at)) ORDER BY r.created_at, r.id)
                               FROM questify_streak_reward r WHERE r.player_id = target), '[]'),
    'items', coalesce((SELECT jsonb_agg(jsonb_build_object(
                                'itemId', i.item_id, 'source', i.source, 'level', i.source_level,
                                'event', CASE WHEN e.id IS NOT NULL
                                  THEN jsonb_build_object('ar', e.name_ar, 'en', e.name_en) END,
                                'earnedAt', export_time(i.earned_at)) ORDER BY i.earned_at, i.item_id)
                       FROM player_item i LEFT JOIN event e ON e.id = i.source_event_id
                       WHERE i.player_id = target), '[]'),
    'equipment', (SELECT jsonb_build_object('character', q.character_id, 'frame', q.frame_id, 'title', q.title_id)
                  FROM player_equipment q WHERE q.player_id = target),
    'souvenirReceipts', coalesce((SELECT jsonb_agg(jsonb_build_object(
                                           'itemId', s.item_id, 'event', jsonb_build_object('ar', e.name_ar, 'en', e.name_en),
                                           'at', export_time(s.earned_at)) ORDER BY s.earned_at, s.item_id)
                                  FROM souvenir_receipt s JOIN event e ON e.id = s.event_id
                                  WHERE s.player_id = target), '[]'),
    'daily', jsonb_build_object(
      'plays', coalesce((SELECT jsonb_agg(jsonb_build_object(
                                  'kind', d.kind, 'day', d.starts_on,
                                  'answers', coalesce((SELECT jsonb_agg(jsonb_build_object('position', a.position,
                                                                                           'choice', a.choice,
                                                                                           'correct', a.correct)
                                                                        ORDER BY a.position)
                                                       FROM daily_answer a WHERE a.play_id = d.id), '[]'),
                                  'guesses', coalesce((SELECT jsonb_agg(jsonb_build_object('guess', g.guess,
                                                                                           'marks', g.marks)
                                                                        ORDER BY g.attempt)
                                                       FROM daily_guess g WHERE g.play_id = d.id), '[]'),
                                  'finish', (SELECT jsonb_build_object('solved', f.solved, 'correct', f.correct,
                                                                       'xp', f.xp, 'at', export_time(f.created_at))
                                             FROM daily_finish f WHERE f.play_id = d.id))
                                ORDER BY d.starts_on, d.id)
                         FROM daily_play d WHERE d.player_id = target), '[]')))
$$;
REVOKE ALL ON FUNCTION export_questify(uuid) FROM PUBLIC;

-- Blocks, notifications, help requests, reports made, what Questify did to the account, and the player's own history:
-- an allowlist of actions the player made (never an actor id, never an admin's export, ADR-481).
CREATE FUNCTION export_support(target uuid) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT jsonb_build_object(
    'blocks', coalesce((SELECT jsonb_agg(jsonb_build_object('username', p.username, 'at', export_time(b.created_at))
                                         ORDER BY b.created_at)
                        FROM player_block b JOIN player p ON p.id = b.blocked_id
                        WHERE b.blocker_id = target AND p.status <> 'deleted'), '[]'),
    'notifications', coalesce((SELECT jsonb_agg(jsonb_build_object('kind', o.kind, 'eventId', o.event_id,
                                                                   'params', o.params, 'at', export_time(n.created_at),
                                                                   'readAt', export_time(n.read_at))
                                                ORDER BY n.created_at, n.id)
                               FROM notification n JOIN notice o ON o.id = n.notice_id
                               WHERE n.player_id = target), '[]'),
    'tickets', coalesce((SELECT jsonb_agg(jsonb_build_object('kind', t.kind, 'eventId', t.event_id, 'body', t.body,
                                                             'status', t.status, 'outcome', t.outcome, 'reply', t.reply,
                                                             'at', export_time(t.created_at),
                                                             'closedAt', export_time(t.closed_at))
                                          ORDER BY t.created_at, t.id)
                         FROM ticket t WHERE t.player_id = target), '[]'),
    'reportsMade', coalesce((SELECT jsonb_agg(jsonb_build_object(
                                      'kind', r.target_kind, 'reason', r.reason, 'note', r.note, 'status', r.status,
                                      'outcome', r.outcome,
                                      'snapshot', CASE WHEN r.target_kind <> 'username' THEN r.snapshot END,
                                      'at', export_time(r.created_at)) ORDER BY r.created_at, r.id)
                             FROM content_report r WHERE r.reporter_id = target), '[]'),
    'questifyActions', coalesce((SELECT jsonb_agg(jsonb_build_object('kind', a.kind, 'reasonCode', a.reason_code,
                                                                     'at', export_time(a.created_at))
                                                  ORDER BY a.created_at, a.id)
                                 FROM player_admin_action a WHERE a.player_id = target), '[]'),
    'history', coalesce((SELECT jsonb_agg(jsonb_build_object('action', a.action, 'at', export_time(a.at))
                                          ORDER BY a.at, a.id)
                         FROM audit_log a
                         WHERE a.target_type = 'player' AND a.target_id = target::text
                           AND (a.action IN ('player.signup', 'player.contact_change', 'player.qr_reset')
                                OR (a.action = 'player.data_export' AND a.after ->> 'source' = 'player'))), '[]'))
$$;
REVOKE ALL ON FUNCTION export_support(uuid) FROM PUBLIC;

-- The whole file (FR-1418, ADR-480): one versioned JSON document. DR404 for a tombstone or an unknown id.
CREATE FUNCTION player_data_export(target uuid) RETURNS jsonb
  LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  p player;
BEGIN
  SELECT x.* INTO p FROM player x WHERE x.id = target;
  IF NOT FOUND OR p.status = 'deleted' THEN
    RAISE EXCEPTION 'no such player' USING ERRCODE = 'DR404';
  END IF;
  RETURN jsonb_build_object('format', 'questify-data-export', 'version', 1, 'generatedAt', export_time(now()),
                            'playerId', p.id)
         || export_account(p)
         || jsonb_build_object('events', export_events(p.id), 'questify', export_questify(p.id))
         || export_support(p.id);
END $$;
REVOKE ALL ON FUNCTION player_data_export(uuid) FROM PUBLIC;

-- ================================================================ the player's own export (D2)
-- The signed-in, active player. The row lock makes two exports at once count one after the other. Three of the
-- player's own exports in 24 hours (an admin's never count): DR429 with the seconds until the oldest leaves the window
-- in the message. One audit entry and one personal notice, written only when the file was built.
CREATE FUNCTION own_data_export(request uuid) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me     uuid := app_player_id();
  p      player;
  oldest timestamptz;
  used   integer;
  file   jsonb;
BEGIN
  SELECT x.* INTO p FROM player x WHERE x.id = me FOR NO KEY UPDATE;
  IF NOT FOUND OR p.status <> 'active' THEN
    RAISE EXCEPTION 'no such player' USING ERRCODE = 'DR404';
  END IF;
  SELECT count(*)::integer, min(a.at) INTO used, oldest FROM audit_log a
  WHERE a.action = 'player.data_export' AND a.target_id = me::text AND a.at > now() - interval '24 hours'
    AND a.after ->> 'source' = 'player';
  IF used >= 3 THEN
    RAISE EXCEPTION '%', greatest(1, ceil(extract(epoch FROM oldest + interval '24 hours' - now())))::integer
      USING ERRCODE = 'DR429';
  END IF;
  file := player_data_export(me);
  INSERT INTO audit_log (actor_type, action, target_type, target_id, after, request_id)
  VALUES ('system', 'player.data_export', 'player', me::text, jsonb_build_object('source', 'player'), request);
  PERFORM notice_create('data_exported', NULL, NULL, me, '{}'::jsonb, '{}'::jsonb,
                        'data_exported:' || coalesce(request::text, gen_random_uuid()::text), NULL);
  RETURN file;
END $$;
REVOKE ALL ON FUNCTION own_data_export(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION own_data_export(uuid) TO questify_app;

-- ================================================================ the admin export (D3)
-- An admin, a reason code and a case reference; PA404 for a tombstone. No notice to the player (Q-444). The audit entry
-- is the record FR-1778 asks for and outlives the account.
CREATE FUNCTION console_player_export(target uuid, reason_code text, reference text, request uuid) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me   uuid := console_admin();
  p    player;
  file jsonb;
BEGIN
  PERFORM data_request_reason(reason_code, reference);
  p := player_for_admin(target, false);
  file := player_data_export(p.id);
  INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, after, request_id)
  VALUES ('admin', me, 'player.data_export', 'player', p.id::text,
          jsonb_build_object('source', 'admin', 'reasonCode', reason_code, 'reference', reference), request);
  RETURN file;
END $$;
REVOKE ALL ON FUNCTION console_player_export(uuid, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_player_export(uuid, text, text, uuid) TO questify_app;

-- ================================================================ the record shows the legal history (D9)
-- Exports and erasures of the player, newest first: time, action, source, reason code, reference, and the admin's email
-- for an admin's request. Read by console_player_record for an account and a tombstone alike.
CREATE FUNCTION console_player_legal(target uuid) RETURNS jsonb
  LANGUAGE sql STABLE SET search_path = public, pg_temp AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'at', a.at, 'action', a.action, 'source', coalesce(a.after ->> 'source', 'player'),
           'reasonCode', a.after ->> 'reasonCode', 'reference', a.after ->> 'reference', 'by', s.email)
           ORDER BY a.at DESC, a.id DESC), '[]'::jsonb)
  FROM (SELECT * FROM audit_log x
        WHERE x.target_id = target::text AND x.action IN ('player.data_export', 'player.delete')
        ORDER BY x.at DESC, x.id DESC LIMIT 100) a
  LEFT JOIN staff_user s ON s.id = a.actor_id AND a.actor_type = 'admin'
$$;
REVOKE ALL ON FUNCTION console_player_legal(uuid) FROM PUBLIC;

-- As 0124, with `legalRequests` on both answers.
CREATE OR REPLACE FUNCTION console_player_record(target uuid, request uuid) RETURNS jsonb
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  me     uuid := console_admin();
  p      player;
  answer jsonb;
BEGIN
  SELECT x.* INTO p FROM player x WHERE x.id = target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such player' USING ERRCODE = 'PA404';
  END IF;
  IF p.status = 'deleted' THEN
    answer := jsonb_build_object('player', jsonb_build_object('id', p.id, 'status', p.status,
                                                              'createdAt', p.created_at, 'deletedAt', p.deleted_at));
  ELSE
    answer := jsonb_build_object(
      'player', jsonb_build_object(
        'id', p.id, 'username', p.username, 'avatar', p.avatar, 'status', p.status, 'createdAt', p.created_at,
        'level', coalesce((SELECT xp_level_of(x.xp) FROM player_xp x WHERE x.player_id = p.id), 1),
        'xp', coalesce((SELECT x.xp FROM player_xp x WHERE x.player_id = p.id), 0)),
      'contacts', coalesce((SELECT contact_masked(pc.phone_e164, pc.email)
                            FROM player_contact pc WHERE pc.player_id = p.id),
                           jsonb_build_object('phone', NULL, 'email', NULL)),
      'contactsChanged', (SELECT jsonb_build_object('at', a.at, 'channel', a.after ->> 'channel',
                                                    'kind', a.after ->> 'kind')
                          FROM audit_log a
                          WHERE a.action = 'player.contact_change' AND a.target_id = p.id::text
                          ORDER BY a.at DESC LIMIT 1),
      'usernames', coalesce((SELECT jsonb_agg(jsonb_build_object('username', h.username, 'reason', h.reason,
                                                                 'changedAt', h.changed_at)
                                              ORDER BY h.changed_at DESC, h.id DESC)
                             FROM (SELECT * FROM username_history u WHERE u.player_id = p.id
                                   ORDER BY u.changed_at DESC, u.id DESC LIMIT 50) h), '[]'::jsonb),
      'events', console_player_events(p.id),
      'achievements', console_player_tiers(p.id),
      'sessions', (SELECT count(DISTINCT r.family)::integer FROM player_refresh r
                   WHERE r.player_id = p.id AND r.revoked_at IS NULL AND r.expires_at > now()
                     AND r.created_at > coalesce(p.tokens_valid_after, '-infinity'::timestamptz)),
      'actions', coalesce((SELECT jsonb_agg(jsonb_build_object(
                                    'id', a.id, 'kind', a.kind, 'reasonCode', a.reason_code, 'note', a.note,
                                    'fromUsername', a.from_username, 'toUsername', a.to_username,
                                    'by', s.email, 'at', a.created_at) ORDER BY a.created_at DESC, a.id)
                           FROM (SELECT * FROM player_admin_action x WHERE x.player_id = p.id
                                 ORDER BY x.created_at DESC LIMIT 100) a
                           JOIN staff_user s ON s.id = a.admin_id), '[]'::jsonb))
      || console_player_flags_reports(p.id);
  END IF;
  answer := answer || jsonb_build_object('legalRequests', console_player_legal(p.id));
  INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, request_id)
  VALUES ('admin', me, 'console.player_read', 'player', p.id::text, request);
  RETURN answer;
END $$;
REVOKE ALL ON FUNCTION console_player_record(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION console_player_record(uuid, uuid) TO questify_app;
