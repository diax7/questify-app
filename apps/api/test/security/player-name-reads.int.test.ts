import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, TEST_DATABASE_URL, type TestDatabase } from "#test/support/test-db";

const MASKED =
  "masked: a player the reader blocked keeps a place without a name, or is not found (T-705)";
const OWN = "own: the caller's own name, own list or own report";
const STAFF =
  "staff: an organizer's team, a station or the prize desk reads its own event's players; a block is a player's choice and binds no team (ADR-431)";
const ADMIN = "admin: Questify's console, an active platform admin only";
const LIST = "list: the username word lists and retired names, no player's name is answered";
const SCREEN =
  "screen: the big screen is one picture for the room, not one viewer's (plan section 4)";
const HELPER = "helper: answers no row to a reader by itself; each caller is in this map";

/**
 * Every database function whose source names a player (`username`, a full name) is either one of the reads a block
 * masks or allowed with a reason (T-705, plan section 4, "Gate test"). A later read that names a player fails here until
 * its author decides whether a blocker may see the name through it.
 */
const PLAYER_NAME_READS: Readonly<Record<string, string>> = {
  ranking_top: MASKED,
  ranking_day_top: MASKED,
  ranking_rows: MASKED,
  ranking_names: MASKED,
  event_results: MASKED,
  public_player_profile: MASKED,
  xp_board_json: MASKED,
  create_player: OWN,
  rename_player: OWN,
  username_next_change: OWN,
  own_blocks: OWN,
  own_tickets: `${OWN}: the player's own report names the member they reported`,
  open_ticket: `${OWN}: the reporter names the member; reporting a blocked player stays possible`,
  meet_answer:
    "meet: answers the two players of a meeting that happened; a blocked pair cannot meet (meet_refusal)",
  meet_refusal: "meet: refuses a blocked pair with not_for_them before already_met names anyone",
  meet_pass_state:
    "meet: the pass owner sees who scanned them, a meeting that happened in person before any block",
  block_target: "block: the doors' own name lookup, it answers an id to block_player only",
  record_username: "history: the trigger that records a name change",
  username_history_append_only: "history: the append-only guard",
  username_blocked: LIST,
  text_marked: LIST,
  erase_rows: "erasure: removes the account's names",
  admin_rename_player: ADMIN,
  admin_erase_player: `${ADMIN}: compares the typed username before an erasure, answers no name`,
  data_export_account: `${OWN}: the player's own name in their data export (or an admin's legal export)`,
  data_export_support: `${OWN}: whom the player blocked, a list the app already shows them`,
  admin_unretire_username: LIST,
  admin_word_add: LIST,
  admin_word_remove: LIST,
  console_words: LIST,
  console_retired_usernames: LIST,
  console_player_record: ADMIN,
  console_review_demo: `${ADMIN}: the App Review demo's own reviewer account (T-710)`,
  review_demo_provision:
    "review demo: makes the reviewer account with a free name, answers an id only (T-710)",
  review_demo_seed_players:
    "review demo: makes the 12 fictional players with free names, answers nothing (T-710)",
  review_demo_username: "review demo: finds a free name for a demo account it makes (T-710)",
  console_report: ADMIN,
  admin_report_resolve: "report: closes reports with an outcome code, answers no name (T-705b)",
  report_content:
    "report: resolves the reported name to an id for the reporter's own report; answers no name (T-705b)",
  report_snapshot:
    "report: keeps what was reported for Questify's queue (console_report); no player reads it (T-705b)",
  report_team_alert_forget:
    "trigger: deletes a username report's alert when an erasure deletes the report, reads no name (T-701b)",
  report_ticket_text: "report: the team ticket's fixed text, names no one (T-705b)",
  console_player_search: ADMIN,
  console_ticket: ADMIN,
  console_tickets: ADMIN,
  control_feed: STAFF,
  desk_find: STAFF,
  desk_full_name: STAFF,
  desk_items: STAFF,
  device_json: STAFF,
  event_flags: STAFF,
  event_name_display_guard: "setting: checks the event's name setting, answers no name",
  event_name_notice: "setting: the event's name setting, answers no name",
  event_player_names: "setting: the event's name setting, answers no name",
  event_operator_invites: STAFF,
  event_operators: STAFF,
  event_players: STAFF,
  event_tickets: STAFF,
  export_completions: STAFF,
  export_players: STAFF,
  export_redemptions: STAFF,
  export_submissions: STAFF,
  flag_detail: STAFF,
  inbox_rows: STAFF,
  join_requests: STAFF,
  kiosk_scan_subject: STAFF,
  manual_awards: STAFF,
  member_ledger: STAFF,
  operator_activity_recent: STAFF,
  operator_activity_rows: STAFF,
  operator_find_player: STAFF,
  operator_scan_subject: STAFF,
  operator_ticket: STAFF,
  quest_item_misses: STAFF,
  quest_nfc_tags: STAFF,
  queue_rows: STAFF,
  resolve_bulk_targets: STAFF,
  results_places: STAFF,
  session_check_in: STAFF,
  staff_full_name: STAFF,
  public_full_name: `${HELPER} (ranking_names and event_results mask it)`,
  xp_board_row: `${HELPER} (xp_board_json masks it; the admin season views have no reader)`,
  full_name_blocked:
    "check: whether a full name holds a word from the username lists, answers no name (ADR-817)",
  join_answer_name_flag:
    "check: the trigger that sets a Full name answer's flag from the username lists, answers no name (ADR-817)",
  full_name_part: `${HELPER} (the big screen)`,
  names_part: `${HELPER} (the big screen)`,
  screen_finale: SCREEN,
  screen_ranking: SCREEN,
};

/** API files that read a player row with a name outside those functions: each reads the caller's own row only. */
const API_PLAYER_ROW_READS = ["players/profile.ts", "players/sign-in.ts", "ranking/ranking.ts"];

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return sources(path);
    }
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("which reads name a player, and whether a block hides it", () => {
  it("lists every API file that reads a player row with a name", () => {
    const root = join(import.meta.dirname, "..", "..", "src");
    const naming = sources(root)
      .filter((path) => {
        const text = readFileSync(path, "utf8");
        return (
          /(FROM|JOIN) player [a-z]|FROM player WHERE/.test(text) && /username|full_name/.test(text)
        );
      })
      .map((path) => relative(root, path).replaceAll("\\", "/"));
    expect(naming.toSorted()).toEqual(API_PLAYER_ROW_READS.toSorted());
  });

  describe.skipIf(TEST_DATABASE_URL === undefined)("in the database", () => {
    let db: TestDatabase;
    beforeAll(async () => {
      db = await createTestDatabase();
    });
    afterAll(async () => {
      await db.close();
    });

    it("has every function that names a player masked or allowed with a reason", async () => {
      const { rows } = await db.owner.query<{ proname: string }>(
        `SELECT DISTINCT p.proname FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND p.prosrc ~* '(username|public_full_name|full_name_part)'`,
      );
      expect(rows.map((row) => row.proname).toSorted()).toEqual(
        Object.keys(PLAYER_NAME_READS).toSorted(),
      );
    });
  });
});
