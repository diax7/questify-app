import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  TEST_DATABASE_URL,
  createTestDatabase,
  seedTwoTenants,
  type TestDatabase,
} from "#test/support/test-db";

/**
 * The outsider suite (T-012, NFR-017, NFR-018): `questify_outsider` holds only what PUBLIC holds, the same seat as
 * anyone who gets hold of a connection string without our role's rights. Every check reads the live catalog, so a
 * table, sequence, function or schema added later is covered without editing this file.
 */
describe.skipIf(TEST_DATABASE_URL === undefined)("outsider (public credential only)", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
    await seedTwoTenants(db.owner);
  });
  afterAll(async () => {
    await db.close();
  });

  const rows = async <T extends Record<string, unknown>>(sql: string): Promise<T[]> =>
    (await db.owner.query<T>(sql)).rows;

  const tables = async (): Promise<string[]> =>
    (
      await rows<{ name: string }>(
        `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') ORDER BY 1`,
      )
    ).map((row) => row.name);

  describe("live attempts", () => {
    it("cannot read or delete from any table", async () => {
      const all = await tables();
      expect(all.length).toBeGreaterThan(10);
      for (const table of all) {
        await expect(
          db.outsider.query(`SELECT * FROM public.${table} LIMIT 1`),
          table,
        ).rejects.toThrow(/permission denied/);
        await expect(db.outsider.query(`DELETE FROM public.${table}`), table).rejects.toThrow(
          /permission denied/,
        );
      }
    });

    it("cannot call the request-context functions", async () => {
      await expect(db.outsider.query("SELECT public.app_is_admin()")).rejects.toThrow(
        /permission denied/,
      );
    });

    it("cannot read or move Questify XP (T-401)", async () => {
      for (const sql of [
        "SELECT * FROM public.own_level(NULL)",
        "SELECT * FROM public.own_equipment()",
        "SELECT * FROM public.own_locker(NULL,NULL,30)",
        "SELECT public.equip_player('{}')",
        "SELECT public.see_owned_items('{}')",
        "SELECT public.public_player_profile('sara_k')",
        "SELECT public.own_level_items(NULL)",
        "SELECT public.item_json('level-2')",
        "SELECT public.backfill_level_items()",
        "SELECT public.xp_credit(NULL::public.ledger_entry)",
        "SELECT public.xp_reverse(NULL::public.ledger_entry)",
      ]) {
        await expect(db.outsider.query(sql), sql).rejects.toThrow(/permission denied/);
      }
    });

    it("cannot send, read or review submissions (T-301)", async () => {
      for (const sql of [
        "SELECT * FROM public.submit_quest(gen_random_uuid(), 'x', '1.0', 'k')",
        "SELECT * FROM public.own_submissions(gen_random_uuid())",
        "SELECT public.own_pending_points(gen_random_uuid())",
        "SELECT * FROM public.event_submissions(gen_random_uuid(), 'pending', NULL, 1)",
        "SELECT * FROM public.operator_submissions(gen_random_uuid(), NULL, 1)",
        "SELECT * FROM public.staff_review_submission(gen_random_uuid(), 1, 'approve', NULL, 'k', NULL)",
        "SELECT * FROM public.operator_review_submission(gen_random_uuid(), 1, 'approve', NULL, 'k')",
        "SELECT * FROM public.remove_submission(gen_random_uuid(), 1, 'x', 'k', NULL)",
        "SELECT public.mark_submissions_seen(gen_random_uuid(), '{}')",
        "SELECT * FROM public.submitters_of('{}')",
      ]) {
        await expect(db.outsider.query(sql), sql).rejects.toThrow(/permission denied/);
      }
    });

    it("cannot vote, play a quiz or read either (T-302)", async () => {
      for (const sql of [
        "SELECT * FROM public.vote_quest(gen_random_uuid(), '{a}', 'k')",
        "SELECT * FROM public.member_vote(gen_random_uuid())",
        "SELECT * FROM public.quest_vote_counts(gen_random_uuid(), gen_random_uuid())",
        "SELECT public.quiz_start(gen_random_uuid())",
        "SELECT public.quiz_next(gen_random_uuid())",
        "SELECT public.quiz_answer(gen_random_uuid(), 'q1', 'a')",
        "SELECT * FROM public.member_quiz(gen_random_uuid())",
        "SELECT public.finish_one_due_quiz()",
      ]) {
        await expect(db.outsider.query(sql), sql).rejects.toThrow(/permission denied/);
      }
    });

    it("cannot send, close, read or list a live poll (T-306)", async () => {
      for (const sql of [
        "SELECT * FROM public.send_poll(gen_random_uuid(), gen_random_uuid(), NULL)",
        "SELECT * FROM public.close_poll(gen_random_uuid(), gen_random_uuid(), NULL)",
        "SELECT * FROM public.member_poll(gen_random_uuid())",
        "SELECT * FROM public.poll_results(gen_random_uuid())",
        "SELECT public.live_state(gen_random_uuid())",
        "SELECT public.event_has_live(gen_random_uuid())",
        "SELECT public.team_poll(gen_random_uuid(), gen_random_uuid())",
        "SELECT public.is_live_poll('vote', '{}')",
        "SELECT public.polls_shown(NULL::public.event)",
      ]) {
        await expect(db.outsider.query(sql), sql).rejects.toThrow(/permission denied/);
      }
    });

    it("cannot answer a survey, share, read either or list stations (T-303)", async () => {
      for (const sql of [
        "SELECT * FROM public.submit_survey(gen_random_uuid(), '{}', 'k')",
        "SELECT public.member_survey(gen_random_uuid())",
        "SELECT public.survey_summary(gen_random_uuid(), gen_random_uuid())",
        "SELECT * FROM public.share_quest(gen_random_uuid(), 'k')",
        "SELECT * FROM public.member_share(gen_random_uuid())",
        "SELECT * FROM public.operator_stations(gen_random_uuid())",
        "SELECT public.play_quest(gen_random_uuid(), 'survey')",
        "SELECT public.survey_answers('{}', '{}')",
        "SELECT public.share_quests_on(gen_random_uuid())",
      ]) {
        await expect(db.outsider.query(sql), sql).rejects.toThrow(/permission denied/);
      }
    });

    it("cannot read a category bonus or reach the category rules (T-304)", async () => {
      for (const sql of [
        "SELECT * FROM public.category_bonus",
        "SELECT * FROM public.own_bonus(1)",
        "SELECT * FROM public.own_category_bonus(gen_random_uuid())",
        "SELECT public.pay_category_bonus(NULL::public.enrollment, gen_random_uuid(), NULL)",
        "SELECT public.category_lock(NULL::public.quest, gen_random_uuid())",
        "SELECT public.category_done(gen_random_uuid(), gen_random_uuid())",
        "SELECT public.category_cleared(gen_random_uuid(), gen_random_uuid())",
        "SELECT public.quest_done(gen_random_uuid(), gen_random_uuid())",
      ]) {
        await expect(db.outsider.query(sql), sql).rejects.toThrow(/permission denied/);
      }
    });

    it("cannot stamp a passport step or read either table (T-304b)", async () => {
      for (const sql of [
        "SELECT * FROM public.passport_step",
        "SELECT * FROM public.passport_stamp",
        "SELECT * FROM public.stamp_step(gen_random_uuid(), 1, 'k', NULL)",
        "SELECT * FROM public.member_passport(gen_random_uuid())",
        "SELECT * FROM public.stamped_steps(gen_random_uuid())",
        "SELECT public.passport_shape_check(gen_random_uuid())",
      ]) {
        await expect(db.outsider.query(sql), sql).rejects.toThrow(/permission denied/);
      }
    });

    it("cannot find a hidden category, read the reveals or reach the period helpers (T-304c)", async () => {
      for (const sql of [
        "SELECT * FROM public.category_reveal",
        "SELECT * FROM public.reveal_category(gen_random_uuid(), 1)",
        "SELECT public.sees_category(gen_random_uuid(), NULL::public.category)",
        "SELECT public.category_period_start(NULL::public.category, NULL::public.event)",
        "SELECT public.category_resets_at(NULL::public.category, NULL::public.event)",
        "SELECT public.period_count(gen_random_uuid(), NULL::public.quest)",
        "SELECT * FROM public.member_event_quests(gen_random_uuid())",
        "SELECT * FROM public.member_vote(gen_random_uuid())",
        "SELECT * FROM public.member_quiz(gen_random_uuid())",
      ]) {
        await expect(db.outsider.query(sql), sql).rejects.toThrow(/permission denied/);
      }
    });

    it("cannot read quest items or misses, or reach the item helpers (T-304d)", async () => {
      for (const sql of [
        "SELECT * FROM public.quest_item",
        "SELECT * FROM public.quest_item_miss",
        "SELECT public.give_item(NULL::public.enrollment, NULL, NULL, NULL, NULL)",
        "SELECT public.lock_quest_items(NULL::public.quest)",
        "SELECT * FROM public.own_quest_item(1)",
        "SELECT * FROM public.quest_items(gen_random_uuid())",
        "SELECT * FROM public.quest_item_misses(gen_random_uuid(), gen_random_uuid())",
        "SELECT public.credit_item(NULL::public.ledger_entry)",
        "SELECT public.credit_item_state(NULL::public.redemption)",
        "SELECT public.redemption_source(NULL::public.redemption)",
        "SELECT * FROM public.remove_award(gen_random_uuid(), 1, 'x', 'k', NULL)",
        "SELECT * FROM public.my_desk_items()",
        "SELECT * FROM public.my_redemptions(gen_random_uuid())",
        "SELECT * FROM public.desk_lookup(gen_random_uuid(), gen_random_uuid(), 1)",
        "SELECT * FROM public.desk_find(gen_random_uuid(), 'x', NULL)",
      ]) {
        await expect(db.outsider.query(sql), sql).rejects.toThrow(/permission denied/);
      }
    });

    it("cannot check in, read a position or reach the location helpers (T-303b)", async () => {
      for (const sql of [
        "SELECT * FROM public.completion_position",
        "SELECT * FROM public.complete_quest(gen_random_uuid(), 'location', NULL, NULL, 'k', NULL, '{}')",
        "SELECT * FROM public.record_completion(gen_random_uuid(), gen_random_uuid(), 'qr', 1, NULL, 'k', NULL, NULL, NULL, NULL, NULL, NULL)",
        "SELECT * FROM public.position_of('{}')",
        "SELECT public.distance_m(0, 0, 1, 1)",
        "SELECT public.rounded_m(1)",
        "SELECT * FROM public.location_tuning()",
        "SELECT public.check_in_check(NULL::public.quest, NULL)",
        "SELECT public.keep_position(1, NULL::public.enrollment, NULL)",
        "SELECT public.raise_location_flag(NULL::public.quest_completion, 'burst', '[]')",
        "SELECT * FROM public.previous_placed(NULL::public.quest_completion)",
        "SELECT public.place_gap_m(0, 0, 1, 0, 0, 1)",
        "SELECT public.raise_speed_flag(NULL::public.quest_completion)",
      ]) {
        await expect(db.outsider.query(sql), sql).rejects.toThrow(/permission denied/);
      }
    });

    it("cannot show or scan a meet code, read one, or reach the meet helpers (T-303c)", async () => {
      for (const sql of [
        "SELECT * FROM public.meet_pass",
        "SELECT * FROM public.meeting",
        "SELECT * FROM public.issue_meet_pass(gen_random_uuid(), '\\x00', NULL)",
        "SELECT * FROM public.meet_pass_state(1)",
        "SELECT * FROM public.meet_player('\\x00', 'k', NULL, NULL)",
        "SELECT public.meet_on(gen_random_uuid())",
        "SELECT public.meet_today(gen_random_uuid(), NULL::public.quest)",
        "SELECT public.meet_caps(NULL::public.enrollment, NULL::public.quest)",
        "SELECT public.meet_may_play(NULL::public.enrollment, NULL::public.quest)",
        "SELECT public.meet_pass_for('\\x00')",
        "SELECT public.meet_replay(gen_random_uuid(), 'k', 1)",
        "SELECT * FROM public.meet_answer(NULL::public.meeting, false)",
        "SELECT public.meet_refusal(NULL::public.meet_pass, NULL::public.enrollment, NULL::public.enrollment, NULL::public.quest)",
        "SELECT public.pay_meeting(NULL::public.meet_pass, NULL::public.enrollment, NULL::public.enrollment, NULL::public.quest, 'k', NULL, NULL)",
        "SELECT public.pay_completion(NULL::public.enrollment, gen_random_uuid(), 1, 'qr', 'k', NULL, NULL, NULL)",
      ]) {
        await expect(db.outsider.query(sql), sql).rejects.toThrow(/permission denied/);
      }
    });

    it("cannot start, read or finish a mini-game round, or reach the game helpers (T-305)", async () => {
      for (const sql of [
        "SELECT * FROM public.game_round",
        "SELECT * FROM public.start_game_round(gen_random_uuid(), 'k', NULL, 1)",
        "SELECT * FROM public.game_round_for_replay(1)",
        "SELECT * FROM public.finish_game_round(1, 'k', 'passed', '{}', NULL, false, 0)",
        "SELECT * FROM public.member_game(gen_random_uuid())",
        "SELECT public.close_one_due_round()",
        "SELECT public.games_on(gen_random_uuid())",
        "SELECT public.game_level('memory_match', 'easy')",
        "SELECT * FROM public.game_attempts(gen_random_uuid(), NULL::public.quest)",
        "SELECT public.game_left(gen_random_uuid(), NULL::public.quest)",
        "SELECT public.game_spent(gen_random_uuid(), NULL::public.quest)",
        "SELECT public.game_payable(NULL::public.enrollment)",
        "SELECT public.game_last_attempt(NULL::public.enrollment, NULL::public.quest)",
        "SELECT public.raise_game_flag(NULL::public.game_round, 'x')",
        "SELECT * FROM public.game_answer(NULL::public.game_round, false)",
        "SELECT public.game_issue_replay(gen_random_uuid(), 'k', gen_random_uuid())",
        "SELECT public.game_issue_check(NULL::public.enrollment, NULL::public.quest)",
      ]) {
        await expect(db.outsider.query(sql), sql).rejects.toThrow(/permission denied/);
      }
    });

    it("cannot read a community goal or reach the settling, paying and builder doors (T-306b)", async () => {
      for (const sql of [
        "SELECT * FROM public.community_goal",
        "SELECT * FROM public.community_step",
        "SELECT * FROM public.community_reach",
        "SELECT * FROM public.community_contributor",
        "SELECT * FROM public.community_payout",
        "SELECT * FROM public.community_tick_goals()",
        "SELECT public.settle_goal(gen_random_uuid(), true)",
        "SELECT * FROM public.pay_community_batch(500, NULL)",
        "SELECT public.community_health()",
        "SELECT public.save_community_goal(gen_random_uuid(), NULL, '{}', NULL)",
        "SELECT public.delete_community_goal(gen_random_uuid(), gen_random_uuid(), NULL)",
        "SELECT public.community_goals(gen_random_uuid())",
        "SELECT public.settle_community(gen_random_uuid(), true, NULL)",
        "SELECT * FROM public.community_paying(gen_random_uuid())",
        "SELECT * FROM public.community_pending(gen_random_uuid())",
        "SELECT public.community_settle_point()",
        "SELECT public.settle_point_of(now(), '{}', 0)",
        "SELECT public.community_on(NULL::public.event)",
        "SELECT public.community_close_at(now(), now())",
        "SELECT public.community_system_only()",
        "SELECT public.community_read_committed()",
        "SELECT * FROM public.community_read_slice(NULL::public.community_goal, now(), now(), now(), now())",
        "SELECT public.community_freeze_payees(NULL::public.community_goal, '{}', now())",
        "SELECT public.settle_goal_at(NULL::public.community_goal, NULL::public.event, '0', true)",
        "SELECT public.community_started(NULL::public.community_goal)",
        "SELECT * FROM public.community_body_steps('{}')",
        "SELECT public.community_locked_field(NULL::public.community_goal, '{}', now(), now())",
        "SELECT public.community_check_window(NULL::public.event, NULL, '{}', now(), now())",
        "SELECT public.member_community(NULL::public.event, gen_random_uuid())",
      ]) {
        await expect(db.outsider.query(sql), sql).rejects.toThrow(/permission denied/);
      }
    });

    it("cannot reach the unlock gate or its notes (T-306c)", async () => {
      for (const sql of [
        "SELECT public.quest_community_lock(NULL::public.quest)",
        "SELECT public.category_community_lock(gen_random_uuid())",
        "SELECT public.reward_community_lock(NULL::public.reward)",
        "SELECT public.community_lock_missed(gen_random_uuid())",
        "SELECT public.quest_lock_missed(NULL::public.quest)",
        "SELECT public.community_lock_note(gen_random_uuid())",
        "SELECT public.category_rule_lock(NULL::public.quest, gen_random_uuid())",
        "SELECT public.community_unlock_target(NULL::public.community_step, gen_random_uuid())",
        "SELECT public.community_check_unlocks(NULL::public.event, NULL, '{}')",
      ]) {
        await expect(db.outsider.query(sql), sql).rejects.toThrow(/permission denied/);
      }
    });

    it("cannot read a boost or reach the flash and boost doors and helpers (T-307)", async () => {
      for (const sql of [
        "SELECT * FROM public.boost",
        "SELECT * FROM public.launch_flash(gen_random_uuid(), gen_random_uuid(), 10, NULL)",
        "SELECT * FROM public.end_flash(gen_random_uuid(), gen_random_uuid(), NULL)",
        "SELECT public.save_boost(gen_random_uuid(), NULL, gen_random_uuid(), NULL, 30, NULL)",
        "SELECT public.delete_boost(gen_random_uuid(), gen_random_uuid(), NULL)",
        "SELECT * FROM public.end_boost(gen_random_uuid(), gen_random_uuid(), NULL)",
        "SELECT public.event_boosts(gen_random_uuid())",
        "SELECT public.completion_boost(1)",
        "SELECT public.flash_on(NULL::public.event)",
        "SELECT public.boosts_on(NULL::public.event)",
        "SELECT public.flash_shown(NULL::public.quest)",
        "SELECT public.boost_in_force(gen_random_uuid(), NULL::public.enrollment, now())",
        "SELECT public.quest_boost(NULL::public.quest, NULL::public.enrollment, now())",
        "SELECT public.team_flash(NULL::public.event, gen_random_uuid())",
        "SELECT public.boost_editable(NULL::public.event, gen_random_uuid())",
      ]) {
        await expect(db.outsider.query(sql), sql).rejects.toThrow(/permission denied/);
      }
    });

    it("cannot read a tag or a tap or reach the NFC doors and helpers (T-308)", async () => {
      for (const sql of [
        "SELECT * FROM public.nfc_tag",
        "SELECT * FROM public.nfc_tap",
        "SELECT public.prepare_nfc_tag(gen_random_uuid(), gen_random_uuid())",
        "SELECT * FROM public.register_nfc_tag(gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), '\x01020304', '', true, NULL)",
        "SELECT public.operator_nfc_tags(gen_random_uuid())",
        "SELECT * FROM public.tap_quest(gen_random_uuid(), NULL, false, 'k', NULL, NULL)",
        "SELECT public.quest_nfc_tags(gen_random_uuid(), gen_random_uuid())",
        "SELECT public.move_nfc_tag(gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), NULL)",
        "SELECT public.revoke_nfc_tag(gen_random_uuid(), gen_random_uuid(), NULL)",
        "SELECT public.revoke_quest_nfc_tags(gen_random_uuid(), gen_random_uuid(), NULL)",
        "SELECT public.nfc_writer(gen_random_uuid(), gen_random_uuid())",
        "SELECT public.raise_nfc_flag(NULL::public.quest_completion)",
        "SELECT public.team_nfc_tag(NULL::public.event, gen_random_uuid())",
        "SELECT public.quest_delete_nfc_tags()",
      ]) {
        await expect(db.outsider.query(sql), sql).rejects.toThrow(/permission denied/);
      }
    });

    it("cannot read a pairing request or a device or reach the device doors and helpers (T-309)", async () => {
      const bytes = "'\\x" + "00".repeat(32) + "'::bytea";
      for (const sql of [
        "SELECT * FROM public.device_request",
        "SELECT * FROM public.paired_device",
        `SELECT * FROM public.open_device_request(${bytes}, ${bytes}, 'screen', '')`,
        `SELECT public.renew_device_request(${bytes}, ${bytes})`,
        `SELECT * FROM public.device_session(${bytes})`,
        `SELECT public.activate_device(${bytes}, ${bytes})`,
        "SELECT public.device_view()",
        "SELECT * FROM public.screen_code_for_device()",
        "SELECT * FROM public.screen_code_for_operator(gen_random_uuid(), gen_random_uuid())",
        `SELECT public.operator_claim_device(${bytes}, gen_random_uuid(), 'station', gen_random_uuid(), 'x', NULL)`,
        `SELECT public.team_claim_device(${bytes}, gen_random_uuid(), 'screen', NULL, 'x', NULL)`,
        `SELECT * FROM public.preview_device(${bytes}, gen_random_uuid())`,
        "SELECT public.revoke_device(gen_random_uuid(), gen_random_uuid(), NULL)",
        "SELECT public.revoke_devices(gen_random_uuid(), NULL, NULL)",
        "SELECT public.event_devices(gen_random_uuid())",
        "SELECT public.operator_devices(gen_random_uuid())",
        "SELECT public.app_device_id()",
        "SELECT public.screen_window_of(now())",
        "SELECT * FROM public.screen_window()",
        "SELECT public.screen_window_ok(1, now())",
        "SELECT public.revoke_devices_of(NULL, NULL, NULL, 'x')",
        "SELECT public.device_alive(NULL::public.paired_device)",
        "SELECT public.current_device()",
        "SELECT public.screen_quest_state(NULL::public.quest)",
        "SELECT public.device_paused(NULL::public.paired_device)",
        "SELECT public.device_operator(gen_random_uuid(), 'station', gen_random_uuid())",
        `SELECT public.device_request_of(${bytes}, NULL::public.event, false)`,
        "SELECT public.device_claim_check(NULL::public.event, 'screen', NULL, 'x')",
        `SELECT public.make_device(${bytes}, NULL::public.event, 'screen', NULL, 'x', NULL, NULL, NULL)`,
        "SELECT public.device_json(NULL::public.paired_device)",
      ]) {
        await expect(db.outsider.query(sql), sql).rejects.toThrow(/permission denied/);
      }
    });

    it("cannot read a kiosk's scans or reach the kiosk door, its reader or the live code's window (T-309b)", async () => {
      for (const sql of [
        "SELECT * FROM public.kiosk_scan",
        "SELECT * FROM public.kiosk_complete_quest(gen_random_uuid(), 1, gen_random_uuid()::text)",
        "SELECT * FROM public.kiosk_scan_subject(gen_random_uuid())",
        "SELECT * FROM public.live_code_window()",
        "SELECT public.device_quest_state(NULL::public.quest, 'kiosk')",
      ]) {
        await expect(db.outsider.query(sql), sql).rejects.toThrow(/permission denied/);
      }
    });

    it("cannot read tickets or reach any help-desk door, the sweep included (T-310)", async () => {
      for (const sql of [
        "SELECT * FROM public.ticket",
        "SELECT * FROM public.open_ticket(gen_random_uuid(), 'question', NULL, NULL, 'x', 'k')",
        "SELECT * FROM public.own_tickets(NULL)",
        "SELECT public.own_unread_tickets(gen_random_uuid())",
        "SELECT public.mark_tickets_seen(NULL, '{}')",
        "SELECT * FROM public.staff_answer_ticket(gen_random_uuid(), 1, 'x', 'k', NULL)",
        "SELECT * FROM public.operator_answer_ticket(gen_random_uuid(), 1, 'x', 'k')",
        "SELECT * FROM public.answer_core(NULL::public.event, 1, 'x', 'k', NULL, NULL, NULL)",
        "SELECT * FROM public.event_tickets(gen_random_uuid(), 'open', NULL, NULL, 1)",
        "SELECT * FROM public.event_ticket_counts(gen_random_uuid())",
        "SELECT * FROM public.operator_ticket(gen_random_uuid(), 1)",
        "SELECT * FROM public.operator_inbox(gen_random_uuid(), NULL, NULL, NULL, 1)",
        "SELECT * FROM public.operator_inbox_count(gen_random_uuid())",
        "SELECT * FROM public.inbox_abilities(gen_random_uuid())",
        "SELECT * FROM public.inbox_rows(gen_random_uuid(), gen_random_uuid(), true, true)",
        "SELECT public.help_operator(gen_random_uuid())",
        "SELECT public.help_desk_on(NULL::public.event)",
        "SELECT public.operator_sees_ticket(NULL::public.ticket, gen_random_uuid())",
        "SELECT public.purge_ended_tickets(1)",
      ]) {
        await expect(db.outsider.query(sql), sql).rejects.toThrow(/permission denied/);
      }
    });

    it("cannot send outside an event, escalate, or reach Questify's queue (T-312)", async () => {
      for (const sql of [
        "SELECT * FROM public.open_platform_ticket('suggestion', 'x', NULL, NULL, NULL, NULL, 'k')",
        "SELECT public.ticket_device_fact('x', 'f', '.')",
        "SELECT * FROM public.staff_escalate_ticket(gen_random_uuid(), 1, 'x', NULL)",
        "SELECT public.ticket_admin()",
        "SELECT * FROM public.console_tickets('open', NULL, NULL, NULL, 1, NULL)",
        "SELECT * FROM public.console_ticket_counts()",
        "SELECT * FROM public.console_ticket(1, NULL)",
        "SELECT * FROM public.admin_answer_ticket(1, 'x', 'k', NULL)",
        "SELECT * FROM public.admin_return_ticket(1, 'x', NULL)",
      ]) {
        await expect(db.outsider.query(sql), sql).rejects.toThrow(/permission denied/);
      }
    });

    it("cannot practise a scan or read a station's numbers (T-311)", async () => {
      for (const sql of [
        "SELECT * FROM public.operator_practice_scan(gen_random_uuid(), gen_random_uuid(), 1)",
        "SELECT public.practice_wipe_owed(gen_random_uuid())",
        "SELECT * FROM public.operator_station_today(gen_random_uuid(), gen_random_uuid())",
      ]) {
        await expect(db.outsider.query(sql), sql).rejects.toThrow(/permission denied/);
      }
      // PUBLIC holds no EXECUTE on them either: the grants name the API's role alone (CTO MINOR-5).
      const open = await rows<{ proname: string }>(
        `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
         WHERE n.nspname = 'public' AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
           AND p.proname IN ('operator_practice_scan', 'practice_wipe_owed', 'operator_station_today')`,
      );
      expect(open).toEqual([]);
      // The same read finds the API role's grants, so an empty answer above is not a query that reads nothing.
      const granted = await rows<{ proname: string }>(
        `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
         WHERE n.nspname = 'public' AND a.grantee = 'questify_app'::regrole AND a.privilege_type = 'EXECUTE'
           AND p.proname IN ('operator_practice_scan', 'practice_wipe_owed', 'operator_station_today')
         ORDER BY 1`,
      );
      expect(granted.map((row) => row.proname)).toEqual([
        "operator_practice_scan",
        "operator_station_today",
        "practice_wipe_owed",
      ]);
    });

    it("cannot read a first-N bonus or its slots, set one, count one or claim one (T-313)", async () => {
      for (const sql of [
        "SELECT * FROM public.quest_first_bonus",
        "SELECT * FROM public.quest_bonus_slot",
        "SELECT public.set_quest_first_bonus(gen_random_uuid(), gen_random_uuid(), 5, 3, gen_random_uuid())",
        "SELECT * FROM public.first_bonus_left(gen_random_uuid())",
        "SELECT * FROM public.own_first_bonus(1)",
        "SELECT public.practice_first_bonus(gen_random_uuid())",
        "SELECT public.pay_first_bonus(NULL::public.enrollment, gen_random_uuid(), 1, 'k')",
        "SELECT public.first_bonus_place(NULL::public.quest_bonus_slot)",
      ]) {
        await expect(db.outsider.query(sql), sql).rejects.toThrow(/permission denied/);
      }
      const names = [
        "set_quest_first_bonus",
        "first_bonus_left",
        "own_first_bonus",
        "practice_first_bonus",
        "pay_first_bonus",
        "first_bonus_place",
      ];
      const grants = (grantee: string) =>
        rows<{ proname: string }>(
          `SELECT DISTINCT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
           WHERE n.nspname = 'public' AND a.grantee = ${grantee} AND a.privilege_type = 'EXECUTE'
             AND p.proname IN (${names.map((name) => `'${name}'`).join(", ")})
           ORDER BY 1`,
        );
      // PUBLIC holds nothing; the API's role holds the entry points only, never the claim or the rank.
      expect(await grants("0")).toEqual([]);
      expect((await grants("'questify_app'::regrole")).map((row) => row.proname)).toEqual([
        "first_bonus_left",
        "own_first_bonus",
        "practice_first_bonus",
        "set_quest_first_bonus",
      ]);
    });

    it("cannot read or write a streak, set or read one, or reach the streak helpers (T-405)", async () => {
      for (const sql of [
        "SELECT * FROM public.event_streak",
        "SELECT * FROM public.event_streak_day",
        "SELECT * FROM public.questify_streak_day",
        "SELECT * FROM public.questify_streak_milestone",
        "SELECT * FROM public.questify_streak_reward",
        "INSERT INTO public.questify_streak_day (player_id, day) VALUES (gen_random_uuid(), current_date)",
        "SELECT public.set_event_streak(gen_random_uuid(), true, 5, '{}', '{}', gen_random_uuid())",
        "SELECT public.event_streak_settings(gen_random_uuid())",
        "SELECT * FROM public.own_event_streak(gen_random_uuid())",
        "SELECT * FROM public.own_streak_bonus(1)",
        "SELECT public.own_daily_streak()",
        "SELECT public.questify_day(now())",
        "SELECT public.daily_streak_on()",
        "SELECT public.daily_streak_length(gen_random_uuid())",
        "SELECT public.daily_streak_of(gen_random_uuid())",
        "SELECT public.streak_due(gen_random_uuid())",
        "SELECT public.streak_record(NULL::public.ledger_entry)",
        "SELECT public.streak_day_closed(NULL::public.event_streak, current_date)",
        "SELECT public.prev_open_day(NULL::public.event, NULL::public.event_streak, current_date)",
      ]) {
        await expect(db.outsider.query(sql), sql).rejects.toThrow(/permission denied/);
      }
      const names = [
        "set_event_streak",
        "event_streak_settings",
        "own_event_streak",
        "own_streak_bonus",
        "own_daily_streak",
        "questify_day",
        "daily_streak_on",
        "daily_streak_length",
        "daily_streak_of",
        "streak_due",
        "streak_record",
        "streak_day_closed",
        "prev_open_day",
        "ledger_streak",
        "streak_append_only",
      ];
      const grants = (grantee: string) =>
        rows<{ proname: string }>(
          `SELECT DISTINCT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
           WHERE n.nspname = 'public' AND a.grantee = ${grantee} AND a.privilege_type = 'EXECUTE'
             AND p.proname IN (${names.map((name) => `'${name}'`).join(", ")})
           ORDER BY 1`,
        );
      // PUBLIC holds nothing; the API's role holds the settings door, its read and the three own reads only.
      expect(await grants("0")).toEqual([]);
      expect((await grants("'questify_app'::regrole")).map((row) => row.proname)).toEqual([
        "event_streak_settings",
        "own_daily_streak",
        "own_event_streak",
        "own_streak_bonus",
        "set_event_streak",
      ]);
      // No table right for the API role or PUBLIC on the five new tables.
      const held = await rows<{ relname: string }>(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) AS p(priv)
         WHERE n.nspname = 'public'
           AND c.relname IN ('event_streak', 'event_streak_day', 'questify_streak_day', 'questify_streak_milestone',
                             'questify_streak_reward')
           AND (has_table_privilege('questify_app', c.oid, p.priv) OR has_table_privilege('public', c.oid, p.priv))`,
      );
      expect(held).toEqual([]);
    });

    it("cannot sync, read achievements, events or cities, or reach the evaluator's helpers (T-403)", async () => {
      for (const sql of [
        "SELECT * FROM public.city",
        "SELECT * FROM public.achievement",
        "SELECT * FROM public.achievement_earned",
        "SELECT * FROM public.final_rank",
        "SELECT public.questify_sync()",
        "SELECT public.own_achievements()",
        "SELECT * FROM public.own_events(true, NULL, NULL, 20)",
        "SELECT public.city_list()",
        "SELECT * FROM public.player_metrics(gen_random_uuid())",
        "SELECT * FROM public.standing_credits(gen_random_uuid())",
        "SELECT * FROM public.achievements_due(gen_random_uuid())",
        "SELECT public.earned_tier(gen_random_uuid(), 'top-ten')",
        "SELECT public.played_enrollment('active', NULL)",
        "SELECT public.public_stamp(NULL::public.event)",
        "SELECT public.public_achievements(gen_random_uuid())",
        "SELECT public.public_passport(gen_random_uuid())",
        "SELECT * FROM public.all_places(NULL::public.event)",
        "SELECT public.backfill_final_ranks()",
      ]) {
        await expect(db.outsider.query(sql), sql).rejects.toThrow(/permission denied/);
      }
      const names = [
        "questify_sync",
        "own_achievements",
        "own_events",
        "city_list",
        "player_metrics",
        "standing_credits",
        "achievements_due",
        "earned_tier",
        "played_enrollment",
        "public_stamp",
        "public_achievements",
        "public_passport",
        "all_places",
        "backfill_final_ranks",
        "history_append_only",
        "event_city_guard",
      ];
      const grants = (grantee: string) =>
        rows<{ proname: string }>(
          `SELECT DISTINCT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
           WHERE n.nspname = 'public' AND a.grantee = ${grantee} AND a.privilege_type = 'EXECUTE'
             AND p.proname IN (${names.map((name) => `'${name}'`).join(", ")})
           ORDER BY 1`,
        );
      // PUBLIC holds nothing; the API's role holds the four doors only, never the evaluator's helpers.
      expect(await grants("0")).toEqual([]);
      expect((await grants("'questify_app'::regrole")).map((row) => row.proname)).toEqual([
        "city_list",
        "own_achievements",
        "own_events",
        "questify_sync",
      ]);
    });

    it("cannot read or change consent, preferences or the interest list, or choose a promotion's audience (T-407)", async () => {
      const probe = "gen_random_uuid()";
      for (const sql of [
        "SELECT * FROM public.interest",
        "SELECT * FROM public.player_preference",
        "SELECT * FROM public.marketing_consent",
        "SELECT * FROM public.marketing_state",
        "INSERT INTO public.marketing_consent (player_id, channel, granted, method, text_version) VALUES (gen_random_uuid(), 'sms', true, 'settings', '1')",
        "INSERT INTO public.marketing_state (player_id, channel, opted_in, changed_at) VALUES (gen_random_uuid(), 'sms', true, now())",
        "SELECT public.interest_list()",
        "SELECT public.own_marketing()",
        "SELECT public.own_preferences()",
        "SELECT public.own_for_you()",
        "SELECT public.set_marketing('{\"sms\":true}', 'settings', '1')",
        "SELECT public.set_preferences(NULL, '{}')",
        `SELECT public.marketing_opt_out(${probe}, 'sms')`,
        "SELECT * FROM public.marketing_audience('sms', NULL, NULL, NULL, 10)",
        `SELECT public.marketing_consent_history(${probe}, ${probe})`,
        "SELECT public.interests_clean('{sport}', 3)",
        "SELECT public.marketing_player()",
        "SELECT public.marketing_adult(1990::smallint)",
      ]) {
        await expect(db.outsider.query(sql), sql).rejects.toThrow(/permission denied/);
      }
      const names = [
        "interest_list",
        "own_marketing",
        "set_marketing",
        "own_preferences",
        "set_preferences",
        "own_for_you",
        "marketing_opt_out",
        "marketing_audience",
        "marketing_consent_history",
        "interests_clean",
        "marketing_player",
        "marketing_adult",
        "marketing_state_apply",
        "marketing_consent_append_only",
        "event_interests_guard",
      ];
      const grants = (grantee: string) =>
        rows<{ proname: string }>(
          `SELECT DISTINCT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
           WHERE n.nspname = 'public' AND a.grantee = ${grantee} AND a.privilege_type = 'EXECUTE'
             AND p.proname IN (${names.map((name) => `'${name}'`).join(", ")})
           ORDER BY 1`,
        );
      // PUBLIC holds nothing; the API's role holds the nine doors only, never the helpers or the triggers.
      expect(await grants("0")).toEqual([]);
      expect((await grants("'questify_app'::regrole")).map((row) => row.proname)).toEqual([
        "interest_list",
        "marketing_audience",
        "marketing_consent_history",
        "marketing_opt_out",
        "own_for_you",
        "own_marketing",
        "own_preferences",
        "set_marketing",
        "set_preferences",
      ]);
      const held = await rows<{ relname: string }>(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) AS p(priv)
         WHERE n.nspname = 'public'
           AND c.relname IN ('interest', 'player_preference', 'marketing_consent', 'marketing_state')
           AND (has_table_privilege('questify_app', c.oid, p.priv) OR has_table_privilege('public', c.oid, p.priv))`,
      );
      expect(held).toEqual([]);
    });

    it("cannot read Questify quests, run a console door or reach the quest evaluator (T-403b)", async () => {
      const probe = "gen_random_uuid()";
      for (const sql of [
        "SELECT * FROM public.questify_campaign",
        "SELECT * FROM public.questify_quest",
        "SELECT * FROM public.questify_award",
        "SELECT public.own_questify_quests()",
        "SELECT public.questify_admin_list()",
        `SELECT public.questify_campaign_save(NULL, '{}', ${probe})`,
        `SELECT public.questify_campaign_publish(${probe}, ${probe})`,
        `SELECT public.questify_campaign_retire(${probe}, ${probe})`,
        `SELECT public.questify_quest_save(NULL, '{}', ${probe})`,
        `SELECT public.questify_quest_retire(${probe}, ${probe})`,
        `SELECT * FROM public.questify_due(${probe})`,
        `SELECT public.questify_level_up(${probe}, '{}')`,
        "SELECT public.questify_admin()",
        "SELECT public.questify_home(NULL)",
        "SELECT public.questify_campaign_json(NULL::public.questify_campaign)",
        "SELECT public.questify_quest_json(NULL::public.questify_quest)",
        "SELECT public.questify_audit(NULL, 'x', 'y', NULL, NULL, NULL)",
        "SELECT public.questify_window_check(NULL::public.questify_campaign, NULL, NULL)",
        `SELECT * FROM public.standing_credits(${probe}, NULL, NULL)`,
        `SELECT * FROM public.player_metrics(${probe}, NULL, NULL)`,
      ]) {
        await expect(db.outsider.query(sql), sql).rejects.toThrow(/permission denied/);
      }
      const names = [
        "own_questify_quests",
        "questify_admin_list",
        "questify_campaign_save",
        "questify_campaign_publish",
        "questify_campaign_retire",
        "questify_quest_save",
        "questify_quest_retire",
        "questify_due",
        "questify_level_up",
        "questify_admin",
        "questify_home",
        "questify_campaign_json",
        "questify_quest_json",
        "questify_audit",
        "questify_window_check",
      ];
      const grants = (grantee: string) =>
        rows<{ proname: string }>(
          `SELECT DISTINCT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
           WHERE n.nspname = 'public' AND a.grantee = ${grantee} AND a.privilege_type = 'EXECUTE'
             AND p.proname IN (${names.map((name) => `'${name}'`).join(", ")})
           ORDER BY 1`,
        );
      // PUBLIC holds nothing; the API's role holds the player's list and the six console doors only.
      expect(await grants("0")).toEqual([]);
      expect((await grants("'questify_app'::regrole")).map((row) => row.proname)).toEqual([
        "own_questify_quests",
        "questify_admin_list",
        "questify_campaign_publish",
        "questify_campaign_retire",
        "questify_campaign_save",
        "questify_quest_retire",
        "questify_quest_save",
      ]);
      // The windowed overloads stay internal like the lifetime ones.
      const overloads = await rows<{ signature: string }>(
        `SELECT p.oid::regprocedure::text AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname IN ('standing_credits', 'player_metrics')
           AND has_function_privilege('questify_app', p.oid, 'EXECUTE')`,
      );
      expect(overloads).toEqual([]);
    });

    it("cannot read the gem record or the shop, sync, buy, or reach the gem helpers (T-404)", async () => {
      const probe = "gen_random_uuid()";
      for (const sql of [
        "SELECT * FROM public.gem_entry",
        "SELECT * FROM public.gem_purchase",
        "SELECT * FROM public.gem_shop_item",
        "SELECT public.gem_shop()",
        `SELECT public.gem_buy('shop-map-reader', 40, ${probe})`,
        "SELECT public.own_gems()",
        `SELECT public.gems_due(${probe})`,
        "SELECT * FROM public.gem_amounts()",
        "SELECT public.gem_amount('{}', 'levelUp', 20)",
        "SELECT public.questify_gems_of('{}', 0)",
      ]) {
        await expect(db.outsider.query(sql), sql).rejects.toThrow(/permission denied/);
      }
      const names = [
        "gem_shop",
        "gem_buy",
        "own_gems",
        "gems_due",
        "gem_amounts",
        "gem_amount",
        "gem_append_only",
        "questify_gems_of",
        "own_locker",
        "souvenir_catalog_guard",
        "owned_item_guard",
      ];
      const grants = (grantee: string) =>
        rows<{ proname: string }>(
          `SELECT DISTINCT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
           WHERE n.nspname = 'public' AND a.grantee = ${grantee} AND a.privilege_type = 'EXECUTE'
             AND p.proname IN (${names.map((name) => `'${name}'`).join(", ")})
           ORDER BY 1`,
        );
      // PUBLIC holds nothing; the API's role holds the three player doors and the locker read only.
      expect(await grants("0")).toEqual([]);
      expect((await grants("'questify_app'::regrole")).map((row) => row.proname)).toEqual([
        "gem_buy",
        "gem_shop",
        "own_gems",
        "own_locker",
      ]);
    });

    it("cannot read or play the daily games, set their content, or reach their helpers (T-406)", async () => {
      const dailyTables = [
        "daily_cadence",
        "daily_question",
        "daily_challenge",
        "daily_challenge_question",
        "daily_word",
        "word_guess_list",
        "daily_play",
        "daily_answer",
        "daily_guess",
        "daily_finish",
      ];
      const doors = [
        "own_daily",
        "daily_answer_submit",
        "daily_guess_submit",
        "daily_question_save",
        "daily_question_retire",
        "daily_challenge_set",
        "daily_challenge_clear",
        "daily_word_set",
        "daily_word_clear",
        "word_list_change",
        "daily_cadence_set",
        "daily_console",
        "daily_question_list",
        "word_list_page",
      ];
      const internals = [
        "daily_text_ok",
        "daily_options_ok",
        "daily_letters",
        "daily_display",
        "daily_fold",
        "word_norm",
        "daily_marks",
        "daily_cadence_guard",
        "daily_period",
        "daily_period_start",
        "daily_append_only",
        "daily_clearable",
        "daily_content_guard",
        "daily_slot_guard",
        "daily_question_guard",
        "daily_challenge_three",
        "daily_feature_on",
        "daily_xp_field",
        "daily_xp",
        "daily_has_content",
        "daily_coverage",
        "daily_cover_json",
        "daily_challenge_view",
        "daily_word_finished",
        "daily_word_view",
        "daily_player",
        "daily_current",
        "daily_play_of",
        "daily_finish_play",
        "daily_answer_reply",
        "daily_guess_reply",
        "daily_guess_check",
        "daily_audit",
        "daily_started",
        "daily_question_json",
        "daily_question_of",
        "daily_question_hold",
        "daily_challenge_json",
        "daily_challenge_hold",
        "daily_questions_check",
        "daily_word_json",
        "daily_unused",
        "daily_spans",
        "daily_cadence_json",
      ];
      for (const sql of [
        ...dailyTables.map((table) => `SELECT * FROM public.${table}`),
        "INSERT INTO public.daily_play (player_id, kind, starts_on, word_id) VALUES (gen_random_uuid(), 'word', current_date, 1)",
        "SELECT public.own_daily()",
        "SELECT public.daily_answer_submit(1, gen_random_uuid(), 1::smallint, 1::smallint)",
        "SELECT public.daily_guess_submit(1, 1::smallint, 'crane')",
        "SELECT public.daily_question_save(NULL, '{}', gen_random_uuid())",
        "SELECT public.daily_challenge_set(current_date, '{}', NULL, gen_random_uuid())",
        "SELECT public.daily_word_set('en', current_date, 'crane', gen_random_uuid())",
        "SELECT public.daily_cadence_set('word', 'daily', gen_random_uuid())",
        "SELECT public.daily_console(current_date, current_date)",
        "SELECT public.word_norm('en', 'crane')",
        "SELECT public.daily_marks('crane', 'slate')",
        "SELECT * FROM public.daily_period('word', current_date)",
        "SELECT public.daily_feature_on('word')",
        "SELECT * FROM public.daily_xp()",
        "SELECT * FROM public.daily_coverage('word', 'en')",
      ]) {
        await expect(db.outsider.query(sql), sql).rejects.toThrow(/permission denied/);
      }
      const grants = (grantee: string) =>
        rows<{ proname: string }>(
          `SELECT DISTINCT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
           WHERE n.nspname = 'public' AND a.grantee = ${grantee} AND a.privilege_type = 'EXECUTE'
             AND p.proname IN (${[...doors, ...internals].map((name) => `'${name}'`).join(", ")})
           ORDER BY 1`,
        );
      // PUBLIC holds nothing; the API's role holds the three player doors and the console's doors only.
      expect(await grants("0")).toEqual([]);
      expect((await grants("'questify_app'::regrole")).map((row) => row.proname)).toEqual(
        [...doors].toSorted(),
      );
      // Every function the migration made is listed above, so none is left open by being forgotten.
      const listed = new Set([...doors, ...internals]);
      const made = await rows<{ proname: string }>(
        `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND (p.proname LIKE 'daily\\_%' OR p.proname LIKE 'word\\_%')
           AND p.proname NOT IN ('daily_streak_on', 'daily_streak_length', 'daily_streak_of')`,
      );
      expect(made.map((row) => row.proname).filter((name) => !listed.has(name))).toEqual([]);
      // No table right for the API role or PUBLIC on the ten new dailyTables.
      const held = await rows<{ relname: string }>(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) AS p(priv)
         WHERE n.nspname = 'public' AND c.relname IN (${dailyTables.map((table) => `'${table}'`).join(", ")})
           AND (has_table_privilege('questify_app', c.oid, p.priv) OR has_table_privilege('public', c.oid, p.priv))`,
      );
      expect(held).toEqual([]);
      const secured = await rows<{ relname: string }>(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relrowsecurity AND c.relforcerowsecurity
           AND c.relname IN (${dailyTables.map((table) => `'${table}'`).join(", ")})`,
      );
      expect(secured).toHaveLength(dailyTables.length);
    });

    it("cannot read the XP boards, the Questify-wide ranking or its seasons, or reach their helpers (T-408)", async () => {
      for (const sql of [
        "SELECT * FROM public.xp_board",
        "INSERT INTO public.xp_board (board, player_id, xp, xp_version) VALUES ('all', gen_random_uuid(), 1, 1)",
        "SELECT public.questify_ranking('lifetime')",
        "SELECT public.questify_seasons()",
        "SELECT public.questify_season_top('2026-10')",
        "SELECT public.questify_month(now())",
        "SELECT public.xp_month_of(1)",
        "SELECT public.questify_ranking_on()",
        "SELECT public.questify_board_of('lifetime')",
        "SELECT public.xp_board_row(gen_random_uuid(), 1, 1)",
        "SELECT public.xp_board_json('all', NULL)",
        "SELECT public.questify_season_board('2026-10')",
        "SELECT public.xp_board_count('all')",
      ]) {
        await expect(db.outsider.query(sql), sql).rejects.toThrow(/permission denied/);
      }
      const doors = ["questify_ranking", "questify_seasons", "questify_season_top"];
      const internals = [
        "questify_month",
        "xp_month_of",
        "questify_ranking_on",
        "questify_board_of",
        "xp_board_row",
        "xp_board_json",
        "questify_season_board",
        "xp_board_count",
        "xp_apply",
      ];
      const grants = (grantee: string) =>
        rows<{ proname: string }>(
          `SELECT DISTINCT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
           WHERE n.nspname = 'public' AND a.grantee = ${grantee} AND a.privilege_type = 'EXECUTE'
             AND p.proname IN (${[...doors, ...internals].map((name) => `'${name}'`).join(", ")})
           ORDER BY 1`,
        );
      // PUBLIC holds nothing; the API's role holds the three doors only, never the helpers or xp_apply.
      expect(await grants("0")).toEqual([]);
      expect((await grants("'questify_app'::regrole")).map((row) => row.proname)).toEqual(
        [...doors].toSorted(),
      );
      const held = await rows<{ priv: string }>(
        `SELECT p.priv FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) AS p(priv)
         WHERE n.nspname = 'public' AND c.relname = 'xp_board'
           AND (has_table_privilege('questify_app', c.oid, p.priv) OR has_table_privilege('public', c.oid, p.priv))`,
      );
      expect(held).toEqual([]);
      const secured = await rows<{ relname: string }>(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = 'xp_board' AND c.relrowsecurity AND c.relforcerowsecurity`,
      );
      expect(secured).toHaveLength(1);
    });

    it("cannot read an invitation, request, approve, send or open one, or reach the consent pool (T-409)", async () => {
      const probe = "gen_random_uuid()";
      for (const sql of [
        "SELECT * FROM public.invitation_campaign",
        "SELECT * FROM public.invitation_recipient",
        "SELECT * FROM public.invitation_channel_hold",
        "INSERT INTO public.invitation_channel_hold (channel, hold_until, code) VALUES ('sms', now(), 'x')",
        `SELECT public.invitation_request(${probe}, '{}', ${probe})`,
        `SELECT public.invitation_cancel(${probe}, ${probe}, ${probe})`,
        `SELECT public.invitation_list(${probe})`,
        "SELECT public.invitation_admin_queue()",
        `SELECT public.invitation_admin_get(${probe})`,
        `SELECT public.invitation_approve(${probe}, '{sms}', 50, now(), NULL, NULL, NULL, ${probe})`,
        `SELECT public.invitation_refuse(${probe}, 'x', ${probe})`,
        `SELECT public.invitation_admin_cancel(${probe}, 'x', ${probe})`,
        "SELECT public.invitation_start_due()",
        "SELECT * FROM public.invitation_claim('{sms}', 5)",
        `SELECT public.invitation_ack(1, ${probe}, 'sent', NULL)`,
        "SELECT public.invitation_settle()",
        `SELECT public.invitation_open(${probe})`,
        "SELECT * FROM public.promo_pool('sms', NULL, NULL)",
        "SELECT * FROM public.invitation_claim_at('{sms}', 5, now())",
        `SELECT * FROM public.invitation_candidates(${probe})`,
        "SELECT public.invitation_on()",
      ]) {
        await expect(db.outsider.query(sql), sql).rejects.toThrow(/permission denied/);
      }
      const doors = [
        "invitation_request",
        "invitation_cancel",
        "invitation_list",
        "invitation_admin_queue",
        "invitation_admin_get",
        "invitation_approve",
        "invitation_refuse",
        "invitation_admin_cancel",
        "invitation_start_due",
        "invitation_claim",
        "invitation_ack",
        "invitation_settle",
        "invitation_open",
        "marketing_audience",
        "set_marketing",
      ];
      const internals = [
        "promo_pool",
        "invitation_on",
        "invitation_system_only",
        "invitation_event_ok",
        "invitation_bucket",
        "invitation_sms_quiet",
        "invitation_audit",
        "invitation_org_json",
        "invitation_admin_json",
        "invitation_candidates",
        "invitation_expire_leases",
        "invitation_skip_queued",
        "invitation_team_event",
        "invitation_criteria",
        "invitation_note",
        "invitation_claim_lock",
        "invitation_claim_campaigns",
        "invitation_skip_row",
        "invitation_claim_at",
        "invitation_settle_lock",
        "invitation_settle_unstarted",
        "invitation_settle_joined",
        "invitation_settle_finish",
        "invitation_settle_final",
        "invitation_settle_publish",
        "invitation_purge",
        "invitation_campaign_gone",
        "marketing_state_apply",
      ];
      const grants = (grantee: string) =>
        rows<{ proname: string }>(
          `SELECT DISTINCT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
           WHERE n.nspname = 'public' AND a.grantee = ${grantee} AND a.privilege_type = 'EXECUTE'
             AND p.proname IN (${[...doors, ...internals].map((name) => `'${name}'`).join(", ")})
           ORDER BY 1`,
        );
      // PUBLIC holds nothing; the API's role holds the doors only, never promo_pool, the fixed-time claim or a helper.
      expect(await grants("0")).toEqual([]);
      expect((await grants("'questify_app'::regrole")).map((row) => row.proname)).toEqual(
        [...doors].toSorted(),
      );
      // Every function the migration made has its place in the two lists above (a new one must be classified).
      const made = await rows<{ proname: string }>(
        `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND (left(p.proname, 11) = 'invitation_' OR p.proname = 'promo_pool') ORDER BY 1`,
      );
      expect(made.map((row) => row.proname).toSorted()).toEqual(
        [...doors, ...internals]
          .filter((name) => name.startsWith("invitation_") || name === "promo_pool")
          .toSorted(),
      );
      const held = await rows<{ relname: string }>(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE')) AS p(priv)
         WHERE n.nspname = 'public'
           AND c.relname IN ('invitation_campaign', 'invitation_recipient', 'invitation_channel_hold')
           AND (has_table_privilege('questify_app', c.oid, p.priv) OR has_table_privilege('public', c.oid, p.priv))`,
      );
      expect(held).toEqual([]);
      const secured = await rows<{ relname: string }>(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relrowsecurity AND c.relforcerowsecurity
           AND c.relname IN ('invitation_campaign', 'invitation_recipient', 'invitation_channel_hold')`,
      );
      expect(secured).toHaveLength(3);
      const [pool] = await rows<{ definer: boolean; config: string[] | null; can: boolean }>(
        `SELECT p.prosecdef AS definer, p.proconfig AS config,
                has_function_privilege('questify_app', p.oid, 'EXECUTE') AS can
         FROM pg_proc p WHERE p.proname = 'promo_pool'`,
      );
      // Plain SQL, no definer and no SET clause, so the planner can inline it; never callable by the API role.
      expect(pool).toEqual({ definer: false, config: null, can: false });
    });

    it("cannot read a recap, reach the window guard or change an event's window (T-410)", async () => {
      for (const sql of [
        "SELECT * FROM public.event_recap(gen_random_uuid())",
        "SELECT public.event_shop_window_guard()",
        "UPDATE public.event SET shop_days_after = 30",
        "SELECT * FROM public.reserve_reward(gen_random_uuid(), 'k')",
      ]) {
        await expect(db.outsider.query(sql), sql).rejects.toThrow(/permission denied/);
      }
      const grants = (grantee: string) =>
        rows<{ proname: string }>(
          `SELECT DISTINCT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
           WHERE n.nspname = 'public' AND a.grantee = ${grantee} AND a.privilege_type = 'EXECUTE'
             AND p.proname IN ('event_recap', 'event_shop_window_guard', 'reserve_reward')
           ORDER BY 1`,
        );
      // PUBLIC holds nothing; the API's role holds the two doors, never the trigger function.
      expect(await grants("0")).toEqual([]);
      expect((await grants("'questify_app'::regrole")).map((row) => row.proname)).toEqual([
        "event_recap",
        "reserve_reward",
      ]);
      const [recap] = await rows<{ definer: boolean; config: string[] | null }>(
        `SELECT p.prosecdef AS definer, p.proconfig AS config FROM pg_proc p
         WHERE p.proname = 'event_recap' AND p.pronamespace = 'public'::regnamespace`,
      );
      expect(recap).toEqual({ definer: true, config: ["search_path=public, pg_temp"] });
    });

    it("cannot create anything", async () => {
      await expect(db.outsider.query("CREATE TABLE public.sneaky (id int)")).rejects.toThrow(
        /permission denied/,
      );
      await expect(db.outsider.query("CREATE SCHEMA sneaky")).rejects.toThrow(/permission denied/);
    });
  });

  describe("catalog (every object, present and future)", () => {
    it("holds no right on any table, view or sequence", async () => {
      const held = await rows(
        `SELECT c.relname, p.priv FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(priv)
         WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
           AND has_table_privilege('questify_outsider', c.oid, p.priv)
         UNION ALL
         SELECT c.relname, p.priv FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN (VALUES ('USAGE'), ('SELECT'), ('UPDATE')) AS p(priv)
         WHERE n.nspname = 'public' AND c.relkind = 'S'
           AND has_sequence_privilege('questify_outsider', c.oid, p.priv)`,
      );
      expect(held).toEqual([]);
    });

    it("can run no function in the public schema", async () => {
      const held = await rows(
        `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND has_function_privilege('questify_outsider', p.oid, 'EXECUTE')`,
      );
      expect(held).toEqual([]);
    });

    it("cannot create in any schema or in the database", async () => {
      const held = await rows(
        `SELECT nspname FROM pg_namespace
         WHERE has_schema_privilege('questify_outsider', oid, 'CREATE')
         UNION ALL
         SELECT 'database' WHERE has_database_privilege('questify_outsider', current_database(), 'CREATE')`,
      );
      expect(held).toEqual([]);
    });

    it("has only the public schema to look at (a new schema must join this suite)", async () => {
      const schemas = await rows<{ nspname: string }>(
        `SELECT nspname FROM pg_namespace
         WHERE nspname NOT IN ('pg_catalog', 'information_schema') AND nspname NOT LIKE 'pg\\_%'`,
      );
      expect(schemas.map((row) => row.nspname)).toEqual(["public"]);
    });
  });

  describe("structure (deny by default)", () => {
    it("has row-level security forced on every table", async () => {
      const open = await rows(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT (c.relrowsecurity AND c.relforcerowsecurity)`,
      );
      expect(open).toEqual([]);
    });

    it("has no view, which would read with its owner's rights and skip row-level security", async () => {
      const views = await rows(
        `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind IN ('v', 'm')`,
      );
      expect(views).toEqual([]);
    });

    it("grants nothing on a table to PUBLIC", async () => {
      expect(
        await rows(
          "SELECT table_name FROM information_schema.role_table_grants WHERE grantee = 'PUBLIC' AND table_schema = 'public'",
        ),
      ).toEqual([]);
    });

    it("gives the app role no dangerous rights", async () => {
      const held = await rows(
        `SELECT c.relname, p.priv FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN (VALUES ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) AS p(priv)
         WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND has_table_privilege('questify_app', c.oid, p.priv)
         UNION ALL
         SELECT 'schema public', 'CREATE' WHERE has_schema_privilege('questify_app', 'public', 'CREATE')`,
      );
      expect(held).toEqual([]);
    });

    it("makes the app role neither a superuser nor able to skip row-level security", async () => {
      expect(
        await rows("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'questify_app'"),
      ).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    });
  });
});
