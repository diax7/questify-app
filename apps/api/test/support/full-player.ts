import type { Client } from "pg";

/** The ids a full player's seed made. */
export type FullPlayer = Readonly<{
  player: string;
  other: string;
  event: string;
  org: string;
  completion: string;
  phone: string;
  email: string;
  username: string;
  joinAnswer: string;
  submission: string;
  ticket: string;
}>;

let seeds = 0;

/**
 * A player with at least one row in every table the data export reads (T-708, ADR-482), written as the migration owner:
 * one event with a second player in it (a meeting, a block and a desk sale point at them), a points record, a prize,
 * every kind of play, staff roles, Questify levels, items, souvenirs, daily games, notices, choices and audit entries.
 * The personal-data catalog test fails naming the empty section when a new exportable table is not seeded here.
 */
export async function seedFullPlayer(owner: Client): Promise<FullPlayer> {
  seeds += 1;
  const k = String((Date.now() % 1_000_000) * 100 + (seeds % 100));
  await owner.query("CREATE TEMP TABLE IF NOT EXISTS seed_ids (name text, id text)");
  await owner.query("DELETE FROM seed_ids");
  await owner.query(`
DO $seed$
DECLARE
  k      text := '${k}';
  org    uuid; ev uuid; cat uuid; q uuid; rw uuid; me uuid; other uuid; n uuid; n2 uuid;
  comp   bigint; comp2 bigint; entry bigint; play bigint; attempt bigint; pass bigint; xpe bigint;
  fld    uuid; ses uuid; goal uuid; step uuid; pstep uuid; red uuid; dev uuid; nid bigint; sa uuid;
  award  bigint; pq uuid; finish bigint; streak bigint; staff uuid; camp uuid; prize uuid;
BEGIN
  INSERT INTO organizer (name, slug) VALUES ('Full Org ' || k, 'full-' || k) RETURNING id INTO org;
  INSERT INTO staff_user (email, password_hash) VALUES ('team' || k || '@team.test', 'unused') RETURNING id INTO staff;
  INSERT INTO event (organizer_id, join_code, name_ar, name_en, status, starts_at, ends_at)
  VALUES (org, 'FULL' || k, 'مهرجان', 'Full Fest', 'live', now() - interval '2 hours', now() + interval '1 day')
  RETURNING id INTO ev;
  INSERT INTO category (event_id, name_ar, name_en) VALUES (ev, 'عام', 'General') RETURNING id INTO cat;
  INSERT INTO quest (event_id, category_id, type, title_ar, title_en, points, type_config)
  VALUES (ev, cat, 'enter_code', 'كشك', 'Booth', 10, '{"code": "ABC"}') RETURNING id INTO q;
  INSERT INTO quest (event_id, category_id, type, title_en, points, type_config)
  VALUES (ev, cat, 'passport', 'Passport', 10, '{"needed": 1}') RETURNING id INTO pq;
  INSERT INTO reward (event_id, kind, name_ar, name_en, price, stock_total)
  VALUES (ev, 'experience', 'سبا', 'Spa', 5, 9) RETURNING id INTO rw;

  INSERT INTO player (username, birth_year) VALUES ('full_' || k, 1991) RETURNING id INTO me;
  INSERT INTO player (username, birth_year) VALUES ('other_' || k, 1992) RETURNING id INTO other;
  INSERT INTO seed_ids VALUES ('player', me::text), ('other', other::text), ('event', ev::text), ('org', org::text);
  INSERT INTO player_contact (player_id, phone_e164, email)
  VALUES (me, '+9665' || lpad(k, 8, '0'), 'full' || k || '@example.com');
  INSERT INTO player_fingerprint (player_id, fingerprint) VALUES (me, sha256(convert_to('fp' || k, 'UTF8')));
  INSERT INTO player_acceptance (player_id, document, version, method) VALUES (me, 'terms_of_use', '1', 'signup');
  INSERT INTO marketing_consent (player_id, channel, granted, method, text_version, language)
  VALUES (me, 'email', true, 'settings', '1', 'ar');
  INSERT INTO player_preference (player_id, city_id, interests) VALUES (me, 'sa-riyadh', ARRAY['music']);
  INSERT INTO push_topic_mute (player_id, topic) VALUES (me, 'rank');
  INSERT INTO push_topic_on (player_id, topic) VALUES (me, 'community');
  INSERT INTO push_device (player_id, family, platform, token, language, app_version)
  VALUES (me, gen_random_uuid(), 'android', 'push_token_abcdefghijkl_' || k, 'ar', '1.0.0') RETURNING id INTO dev;
  INSERT INTO player_session (player_id, token_hash, expires_at)
  VALUES (me, sha256(convert_to('session' || k, 'UTF8')), now() + interval '1 hour');
  INSERT INTO player_refresh (player_id, family, token_hash, expires_at)
  VALUES (me, gen_random_uuid(), sha256(convert_to('refresh' || k, 'UTF8')), now() + interval '1 day');
  INSERT INTO player_sign_in_device (player_id, family, platform, model, signed_in_at)
  SELECT me, r.family, 'android', 'Pixel 8', now() FROM player_refresh r WHERE r.player_id = me;
  INSERT INTO player_reauth_challenge (player_id, family, token_hash, channel, code_hash, expires_at)
  SELECT me, r.family, sha256(convert_to('reauth' || k, 'UTF8')), 'phone', sha256(convert_to('code' || k, 'UTF8')),
         now() + interval '5 minutes'
  FROM player_refresh r WHERE r.player_id = me;
  INSERT INTO player_block (blocker_id, blocked_id) VALUES (me, other);
  INSERT INTO invitation_campaign (organizer_id, event_id, request_id, fingerprint, size)
  VALUES (org, ev, gen_random_uuid(), 'fp' || k, 50) RETURNING id INTO camp;
  INSERT INTO invitation_recipient (campaign_id, player_id, channel) VALUES (camp, me, 'push');
  nid := notice_create('username_changed', NULL, NULL, me, '{}'::jsonb, '{}'::jsonb, 'seed' || k, NULL);
  INSERT INTO notification (notice_id, player_id) VALUES (nid, me);
  INSERT INTO player_admin_action (player_id, admin_id, kind, reason_code, note)
  VALUES (me, staff, 'contact_reveal', 'support_request', 'the player asked for help');

  INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES (org, ev, me) RETURNING id INTO n;
  INSERT INTO enrollment (organizer_id, event_id, player_id) VALUES (org, ev, other) RETURNING id INTO n2;
  INSERT INTO event_join_field (event_id, kind, label_ar, label_en, position)
  VALUES (ev, 'custom', 'المدينة', 'City', 1) RETURNING id INTO fld;
  INSERT INTO join_answer (enrollment_id, field_id, organizer_id, event_id, value) VALUES (n, fld, org, ev, 'Jeddah ' || k);
  INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method, idempotency_key, device_id)
  VALUES (org, ev, n, q, 1, 'code', 'c1' || k, gen_random_uuid()) RETURNING id INTO comp;
  INSERT INTO quest_completion (organizer_id, event_id, enrollment_id, quest_id, occurrence, method, idempotency_key)
  VALUES (org, ev, n2, q, 1, 'code', 'c2' || k) RETURNING id INTO comp2;
  INSERT INTO completion_position (completion_id, organizer_id, event_id, enrollment_id, accuracy_m, mocked)
  VALUES (comp, org, ev, n, 12, false);
  INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, completion_id,
                            quest_id, actor)
  VALUES (org, ev, n, 'quest', 10, 10, comp, q, 'player') RETURNING id INTO entry;
  INSERT INTO ledger_note (entry_id, organizer_id, event_id, reason) VALUES (entry, org, ev, 'organizer note ' || k);
  INSERT INTO redemption (organizer_id, event_id, enrollment_id, reward_id, price, idempotency_key, reserved_until)
  VALUES (org, ev, n, rw, 5, 'r1' || k, now() + interval '1 day') RETURNING id INTO red;
  UPDATE reward SET units_out = units_out + 1 WHERE id = rw;
  INSERT INTO ledger_entry (organizer_id, event_id, enrollment_id, kind, score_delta, balance_delta, redemption_id, actor)
  VALUES (org, ev, n, 'redeem', 0, -5, red, 'player');
  INSERT INTO submission (organizer_id, event_id, enrollment_id, quest_id, kind, body, points, status, idempotency_key)
  VALUES (org, ev, n, q, 'text', 'my secret answer ' || k, 10, 'pending', 's1' || k);
  INSERT INTO quest_vote (organizer_id, event_id, enrollment_id, quest_id, option_id, completion_id)
  VALUES (org, ev, n, q, 'a', comp);
  INSERT INTO survey_response (organizer_id, event_id, enrollment_id, quest_id, answers, completion_id)
  VALUES (org, ev, n, q, '{"q1": "yes"}', comp);
  INSERT INTO quiz_attempt (organizer_id, event_id, enrollment_id, quest_id, points_each, question_count)
  VALUES (org, ev, n, q, 5, 1) RETURNING id INTO attempt;
  INSERT INTO quiz_answer (attempt_id, position, question_id, choice_id, correct, answered_at) VALUES (attempt, 1, 'q1', 'c1', true, now());
  INSERT INTO game_round (organizer_id, event_id, enrollment_id, quest_id, game, level, seed, params, points, issue_key,
                          engine_version, deadline_at)
  VALUES (org, ev, n, q, 'memory_match', 'easy', 7, '{}', 10, 'g1' || k, 1, now() + interval '5 minutes');
  INSERT INTO quest_rating (organizer_id, event_id, quest_id, enrollment_id, thumb) VALUES (org, ev, q, n, 'up');
  INSERT INTO cheer (organizer_id, event_id, enrollment_id, reaction) VALUES (org, ev, n, 'heart');
  INSERT INTO passport_step (organizer_id, event_id, quest_id, name_en) VALUES (org, ev, pq, 'Step') RETURNING id INTO pstep;
  INSERT INTO passport_stamp (organizer_id, event_id, enrollment_id, quest_id, step_id, idempotency_key, completion_id)
  VALUES (org, ev, n, pq, pstep, 'p1' || k, NULL);
  INSERT INTO category_bonus (organizer_id, event_id, enrollment_id, category_id) VALUES (org, ev, n, cat);
  INSERT INTO category_reveal (organizer_id, event_id, enrollment_id, category_id) VALUES (org, ev, n, cat);
  INSERT INTO quest_first_bonus (quest_id, organizer_id, event_id, points, slots) VALUES (q, org, ev, 5, 1);
  DELETE FROM quest_bonus_slot WHERE quest_id = q;
  INSERT INTO quest_bonus_slot (quest_id, place, organizer_id, event_id, completion_id, entry_id, enrollment_id, claimed_at)
  VALUES (q, 1, org, ev, comp, entry, n, now());
  INSERT INTO event_streak_day (enrollment_id, day, organizer_id, event_id, days, completion_id)
  VALUES (n, current_date, org, ev, 1, comp) ON CONFLICT DO NOTHING;
  INSERT INTO community_goal (organizer_id, event_id, title_ar, title_en, measure, target, starts_at, ends_at)
  VALUES (org, ev, 'هدف', 'Goal', 'completions', 10, now() - interval '1 hour', now() + interval '1 day') RETURNING id INTO goal;
  INSERT INTO community_step (event_id, goal_id, threshold, reward) VALUES (ev, goal, 5, 'nothing') RETURNING id INTO step;
  INSERT INTO community_contributor (goal_id, enrollment_id, event_id, first_at) VALUES (goal, n, ev, now());
  INSERT INTO community_payout (step_id, enrollment_id, event_id) VALUES (step, n, ev);
  INSERT INTO event_session (organizer_id, event_id, kind, title_ar, title_en, starts_at, ends_at, access, created_by)
  VALUES (org, ev, 'talk', 'جلسة', 'Talk', now() + interval '1 hour', now() + interval '2 hours', 'open', staff)
  RETURNING id INTO ses;
  INSERT INTO session_registration (organizer_id, event_id, session_id, enrollment_id, player_id)
  VALUES (org, ev, ses, n, me);
  INSERT INTO session_attendance (organizer_id, event_id, session_id, enrollment_id, player_id, operator_id, walk_in)
  VALUES (org, ev, ses, n, me, other, false);
  INSERT INTO meet_pass (organizer_id, event_id, quest_id, enrollment_id, token_hash, expires_at)
  VALUES (org, ev, q, n2, sha256(convert_to('pass' || k, 'UTF8')), now() + interval '5 minutes') RETURNING id INTO pass;
  INSERT INTO meeting (organizer_id, event_id, quest_id, scanner_enrollment, shown_enrollment, pass_id, request_key,
                       scanner_completion, shown_completion)
  VALUES (org, ev, q, n, n2, pass, 'm1' || k, comp, comp2);
  INSERT INTO event_result (event_id, organizer_id) VALUES (ev, org);
  INSERT INTO final_rank (event_id, enrollment_id, rank) VALUES (ev, n, 1);
  INSERT INTO result_place (event_id, rank, enrollment_id, score, score_version) VALUES (ev, 1, n, 10, 1);
  INSERT INTO staff_assignment (organizer_id, event_id, player_id, abilities, can_play)
  VALUES (org, ev, me, ARRAY['scan_quests'], true) RETURNING id INTO sa;
  INSERT INTO staff_assignment_quest (assignment_id, event_id, quest_id) VALUES (sa, ev, q);
  INSERT INTO souvenir_work (event_id, enrollment_id) VALUES (ev, n) ON CONFLICT DO NOTHING;
  INSERT INTO desk_sale (organizer_id, event_id, enrollment_id, reward_id, operator_id, price, idempotency_key, offer_until)
  VALUES (org, ev, n, rw, other, 5, 'd1' || k, now() + interval '5 minutes');
  INSERT INTO ticket (player_id, organizer_id, event_id, enrollment_id, kind, body, idempotency_key)
  VALUES (me, org, ev, n, 'question', 'please help me ' || k, 't1' || k);
  INSERT INTO content_report (reporter_id, event_id, target_kind, target_id, snapshot, reason)
  VALUES (me, ev, 'quest', q, '{"title": "Booth"}', 'spam');

  INSERT INTO player_xp (player_id) VALUES (me) ON CONFLICT DO NOTHING;
  INSERT INTO achievement_earned (player_id, achievement_id, tier) VALUES (me, 'events-attended', 'bronze');
  INSERT INTO xp_entry (player_id, delta, source, achievement_id, tier) VALUES (me, 50, 'achievement', 'events-attended', 'bronze')
  ON CONFLICT DO NOTHING;
  INSERT INTO achievement_revocation (player_id, achievement_id, tier, change)
  VALUES (me, 'events-attended', 'bronze', 'revoke');
  INSERT INTO questify_award (player_id, quest_id) SELECT me, id FROM questify_quest LIMIT 1;
  INSERT INTO questify_streak_reward (player_id, days, xp) VALUES (me, 3, 50);
  INSERT INTO questify_streak_day (player_id, day) VALUES (me, current_date) ON CONFLICT DO NOTHING;
  INSERT INTO player_item (player_id, item_id, source, earned_at)
  VALUES (me, 'shop-map-reader', 'questify', now()) ON CONFLICT DO NOTHING;
  INSERT INTO achievement_earned (player_id, achievement_id, tier) VALUES (me, 'top-ten', 'gold') ON CONFLICT DO NOTHING;
  INSERT INTO player_item (player_id, item_id, source, source_achievement_id, source_tier, earned_at)
  VALUES (me, 'shop-moon-ring', 'achievement', 'top-ten', 'gold', now()) ON CONFLICT DO NOTHING;
  INSERT INTO item (id, kind, name_ar, name_en) VALUES ('seed-title-' || k, 'title', 'لقب', 'Title');
  INSERT INTO souvenir_rule (organizer_id, event_id, item_id, audience)
  VALUES (org, ev, 'seed-title-' || k, 'joined') RETURNING id INTO camp;
  INSERT INTO souvenir_receipt (rule_id, event_id, item_id, player_id, enrollment_id)
  SELECT camp, ev, r.item_id, me, n FROM souvenir_rule r WHERE r.id = camp;
  INSERT INTO player_equipment (player_id) VALUES (me) ON CONFLICT DO NOTHING;
  INSERT INTO daily_challenge (starts_on) VALUES (current_date + 400 + k::int % 1000) RETURNING id INTO streak;
  INSERT INTO daily_question (prompt_ar, prompt_en, options_ar, options_en, answer)
  SELECT 'سؤال ' || g, 'Question ' || g, ARRAY['أ', 'ب'], ARRAY['A', 'B'], 1 FROM generate_series(1, 3) g;
  INSERT INTO daily_challenge_question (challenge_id, position, question_id)
  SELECT streak, row_number() OVER (ORDER BY q.created_at, q.id), q.id
  FROM (SELECT * FROM daily_question ORDER BY created_at DESC, id LIMIT 3) q;
  INSERT INTO daily_play (player_id, kind, starts_on, challenge_id)
  VALUES (me, 'challenge', current_date, streak) RETURNING id INTO play;
  INSERT INTO daily_answer (play_id, position, choice, correct) VALUES (play, 1, 1, true);
  INSERT INTO daily_word (language, starts_on, word, display)
  VALUES ('en', current_date + 400 + k::int % 1000, word_norm('en', 'apple'), 'apple') RETURNING id INTO streak;
  INSERT INTO daily_play (player_id, kind, starts_on, word_id)
  VALUES (me, 'word', current_date, streak) RETURNING id INTO finish;
  INSERT INTO daily_guess (play_id, attempt, guess, marks) VALUES (finish, 1, 'apple', '22222');
  INSERT INTO daily_finish (play_id, player_id, kind, solved, xp) VALUES (finish, me, 'word', true, 5);
  SELECT x.id INTO xpe FROM xp_entry x WHERE x.player_id = me ORDER BY x.id LIMIT 1;
  INSERT INTO level_reached (player_id, level, xp_entry_id) VALUES (me, 2, xpe) ON CONFLICT DO NOTHING;
  INSERT INTO quest_item (organizer_id, event_id, name_ar, name_en, stock_total)
  VALUES (org, ev, 'كوب', 'Mug', 3) RETURNING id INTO goal;
  INSERT INTO quest_item_miss (organizer_id, event_id, enrollment_id, quest_item_id, source_completion_id, reason)
  VALUES (org, ev, n, goal, comp, 'out_of_stock');
  INSERT INTO audit_log (actor_type, actor_id, action, target_type, target_id, after)
  VALUES ('system', NULL, 'player.signup', 'player', me::text, '{"channel": "phone"}'),
         ('admin', staff, 'player.data_export', 'player', me::text, '{"source": "admin", "reasonCode": "legal_request"}');
END $seed$;
`);
  const { rows } = await owner.query<{ name: string; id: string }>("SELECT name, id FROM seed_ids");
  const id = (name: string): string => rows.find((row) => row.name === name)?.id ?? "";
  return {
    player: id("player"),
    other: id("other"),
    event: id("event"),
    org: id("org"),
    completion: id("completion"),
    phone: `+9665${k.padStart(8, "0")}`,
    email: `full${k}@example.com`,
    username: `full_${k}`,
    joinAnswer: `Jeddah ${k}`,
    submission: `my secret answer ${k}`,
    ticket: `please help me ${k}`,
  };
}
