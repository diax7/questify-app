/**
 * The personal-data catalog (T-708, ADR-482): a closed list of every table that can hold a row about a player, what the
 * data export shows of it and what an erasure does to it, plus every FK-less `uuid`, `uuid[]` and `jsonb` column in the
 * schema that is not a player link. `personal-data-catalog.int.test.ts` discovers the tables and columns on the migrated
 * database and fails on anything unclassified or stale, on an empty export section for a fully seeded player, and on
 * personal data left behind after an erasure. The export SQL and `erase_rows` are the product; this list is the proof.
 *
 * `rows` is the SQL condition of the rows that are about the player: `$1` is the player id, `$2` the phone and `$3` the
 * email. After an erasure, a `delete` or `clear` entry has no such row left; the rows of a `keep` entry are scanned for
 * the player's username, contacts and free text.
 */
export type CatalogEntry = Readonly<{
  /** The columns that point at a player, an enrollment or a row of the closure. */
  links: readonly string[];
  /** FK-less columns that hold the player's own data (an app install id, answers), removed with the row or cleared. */
  personal?: readonly string[];
  /** The export path that shows it (`events[].completions`), or why it is left out. */
  export: string | Readonly<{ excluded: string }>;
  erasure: "delete" | "clear" | "keep";
  rows: string;
  why?: string;
}>;

const E = (column: string): string =>
  `${column} IN (SELECT id FROM enrollment WHERE player_id = $1)`;
const P = (column: string): string => `${column} = $1`;
const COMPLETIONS = `completion_id IN (SELECT c.id FROM quest_completion c JOIN enrollment n ON n.id = c.enrollment_id
  WHERE n.player_id = $1)`;
const ASSIGNMENTS = (column: string): string =>
  `${column} IN (SELECT id FROM staff_assignment WHERE player_id = $1)`;
const PIDS = "pseudonymous: ids only, nothing maps the tombstone back to a person";
const STAFF_WORK =
  "a work record of the player acting as an organizer's staff; the role itself is in staffRoles";

export const CATALOG: Readonly<Record<string, CatalogEntry>> = {
  player: {
    links: ["id"],
    export: "account",
    erasure: "clear",
    rows: "id = $1 AND (username IS NOT NULL OR birth_year IS NOT NULL OR status <> 'deleted')",
    why: "the tombstone keeps id, dates and status (FR-1776); username and birth year cleared",
  },
  achievement_earned: {
    links: ["player_id"],
    export: "questify.achievements",
    erasure: "keep",
    rows: P("player_id"),
    why: PIDS,
  },
  achievement_revocation: {
    links: ["player_id", "action_id"],
    export: "questify.achievementChanges",
    erasure: "keep",
    rows: P("player_id"),
    why: PIDS,
  },
  audit_log: {
    links: ["target_id", "actor_id"],
    export: "history",
    erasure: "keep",
    rows: "target_id = $1::text OR actor_id = $1",
    why: "ids and codes only by rule (rules.md 3); the record of requests must outlive the account (FR-1778)",
  },
  category_bonus: {
    links: ["enrollment_id", "completion_id", "entry_id"],
    export: "events[].categoryBonuses",
    erasure: "delete",
    rows: E("enrollment_id"),
  },
  category_reveal: {
    links: ["enrollment_id"],
    export: "events[].categoriesRevealed",
    erasure: "delete",
    rows: E("enrollment_id"),
  },
  cheer: {
    links: ["enrollment_id"],
    export: "events[].cheers",
    erasure: "keep",
    rows: E("enrollment_id"),
    why: PIDS,
  },
  community_contributor: {
    links: ["enrollment_id"],
    export: "events[].communityGoals",
    erasure: "keep",
    rows: E("enrollment_id"),
    why: PIDS,
  },
  community_payout: {
    links: ["enrollment_id", "entry_id"],
    export: "events[].communityRewards",
    erasure: "keep",
    rows: E("enrollment_id"),
    why: PIDS,
  },
  completion_position: {
    links: ["enrollment_id", "completion_id"],
    export: "events[].completionPlaces",
    erasure: "delete",
    rows: E("enrollment_id"),
  },
  content_report: {
    links: ["reporter_id", "target_id"],
    export: "reportsMade",
    erasure: "clear",
    rows: "reporter_id = $1 OR (target_kind = 'username' AND target_id = $1)",
    why: "reports made keep the report with reporter and note cleared; reports of the player's username are deleted",
  },
  team_alert: {
    links: ["target_id"],
    export: {
      excluded: "an internal moderation alert about a report, never the player's own data",
    },
    erasure: "delete",
    rows: "target_kind = 'username' AND target_id = $1",
    why: "an alert about a reported username is deleted with the report when the account is erased",
  },
  daily_answer: {
    links: ["play_id"],
    export: "questify.daily.plays[].answers",
    erasure: "keep",
    rows: "play_id IN (SELECT id FROM daily_play WHERE player_id = $1)",
    why: PIDS,
  },
  daily_finish: {
    links: ["play_id", "player_id"],
    export: "questify.daily.plays[].finish",
    erasure: "keep",
    rows: P("player_id"),
    why: PIDS,
  },
  daily_guess: {
    links: ["play_id"],
    export: "questify.daily.plays[].guesses",
    erasure: "keep",
    rows: "play_id IN (SELECT id FROM daily_play WHERE player_id = $1)",
    why: "the day's word guesses: dictionary words, no free text",
  },
  daily_play: {
    links: ["player_id"],
    export: "questify.daily.plays",
    erasure: "keep",
    rows: P("player_id"),
    why: PIDS,
  },
  desk_sale: {
    links: ["enrollment_id", "operator_id", "redemption_id"],
    export: "events[].deskSales",
    erasure: "delete",
    rows: E("enrollment_id"),
    why: "sales to the player are deleted; a sale the player offered as operator keeps the id only (withdrawn)",
  },
  enrollment: {
    links: ["player_id"],
    export: "events",
    erasure: "keep",
    rows: P("player_id"),
    why: "status left or banned, goal cleared; " + PIDS,
  },
  event_streak_day: {
    links: ["enrollment_id", "completion_id", "entry_id"],
    export: "events[].streakDays",
    erasure: "keep",
    rows: E("enrollment_id"),
    why: PIDS,
  },
  final_rank: {
    links: ["enrollment_id"],
    export: "events[].finalRank",
    erasure: "keep",
    rows: E("enrollment_id"),
    why: PIDS,
  },
  flag: {
    links: ["enrollment_id"],
    personal: ["device_id", "evidence"],
    export: { excluded: "fraud flags raised about the player (fraud prevention; Q-442)" },
    erasure: "delete",
    rows: E("enrollment_id"),
  },
  game_round: {
    links: ["enrollment_id", "completion_id"],
    personal: ["device_id", "params", "result"],
    export: "events[].gameRounds",
    erasure: "delete",
    rows: E("enrollment_id"),
  },
  join_answer: {
    links: ["enrollment_id"],
    export: "events[].joinAnswers",
    erasure: "delete",
    rows: E("enrollment_id"),
  },
  kiosk_scan: {
    links: ["completion_id", "device_id"],
    export: {
      excluded:
        "the kiosk's record of a completion already in events[].completions; names the kiosk only",
    },
    erasure: "keep",
    rows: COMPLETIONS,
    why: PIDS,
  },
  ledger_entry: {
    links: ["enrollment_id", "operator_id", "completion_id", "redemption_id", "reverses"],
    export: "events[].ledger",
    erasure: "keep",
    rows: `${E("enrollment_id")} OR operator_id = $1`,
    why: "the append-only points record (ADR-178); " + PIDS,
  },
  ledger_note: {
    links: ["entry_id"],
    export: { excluded: "the organizer's internal reason for a points change (Q-442)" },
    erasure: "clear",
    rows: `reason IS NOT NULL AND entry_id IN (SELECT l.id FROM ledger_entry l JOIN enrollment n ON n.id = l.enrollment_id
      WHERE n.player_id = $1)`,
    why: "reason cleared, the note row stays with the append-only ledger",
  },
  level_reached: {
    links: ["player_id", "xp_entry_id"],
    export: "questify.levelReached",
    erasure: "keep",
    rows: P("player_id"),
    why: PIDS,
  },
  manual_award_key: {
    links: ["enrollment_id", "operator_id", "entry_id"],
    export: { excluded: "the idempotency key of an award already in events[].ledger" },
    erasure: "keep",
    rows: `${E("enrollment_id")} OR operator_id = $1`,
    why: PIDS,
  },
  marketing_consent: {
    links: ["player_id"],
    export: "marketing.consents",
    erasure: "delete",
    rows: P("player_id"),
  },
  marketing_state: {
    links: ["player_id"],
    export: "marketing.state",
    erasure: "delete",
    rows: P("player_id"),
  },
  meet_pass: {
    links: ["enrollment_id"],
    personal: ["device_id"],
    export: { excluded: "a one-time meeting pass (a token hash, minutes long)" },
    erasure: "delete",
    rows: E("enrollment_id"),
  },
  meeting: {
    links: [
      "scanner_enrollment",
      "shown_enrollment",
      "pass_id",
      "scanner_completion",
      "shown_completion",
    ],
    export: "events[].meetings",
    erasure: "delete",
    rows: `${E("scanner_enrollment")} OR ${E("shown_enrollment")}`,
    why: "the export shows when, never the other player",
  },
  nfc_tag: {
    links: ["written_by"],
    export: { excluded: STAFF_WORK },
    erasure: "clear",
    rows: ASSIGNMENTS("written_by"),
    why: "written_by is set to NULL when the staff assignment is deleted",
  },
  nfc_tap: {
    links: ["completion_id", "tag_id"],
    export: { excluded: "the tag's record of a completion already in events[].completions" },
    erasure: "keep",
    rows: COMPLETIONS,
    why: PIDS,
  },
  operator_invite: {
    links: ["claimed_by"],
    export: {
      excluded: STAFF_WORK + "; the invited email is cleared when the invite is claimed (0026)",
    },
    erasure: "keep",
    rows: P("claimed_by"),
    why: PIDS,
  },
  paired_device: {
    links: ["paired_by_operator"],
    export: { excluded: STAFF_WORK },
    erasure: "clear",
    rows: ASSIGNMENTS("paired_by_operator"),
    why: "paired_by_operator is set to NULL when the staff assignment is deleted",
  },
  passport_stamp: {
    links: ["enrollment_id", "completion_id"],
    personal: ["device_id"],
    export: "events[].passportStamps",
    erasure: "delete",
    rows: E("enrollment_id"),
  },
  player_acceptance: {
    links: ["player_id"],
    export: "acceptances",
    erasure: "delete",
    rows: P("player_id"),
  },
  player_admin_action: {
    links: ["player_id"],
    export: "questifyActions",
    erasure: "delete",
    rows: P("player_id"),
    why: "the export keeps kind, reason code and time; the internal note and the admin stay out",
  },
  player_block: {
    links: ["blocker_id", "blocked_id"],
    export: "blocks",
    erasure: "delete",
    rows: "blocker_id = $1 OR blocked_id = $1",
    why: "the export lists whom the player blocked; who blocked the player is other players' data",
  },
  player_contact: {
    links: ["player_id"],
    export: "contacts",
    erasure: "delete",
    rows: P("player_id"),
  },
  player_contact_challenge: {
    links: ["player_id"],
    export: { excluded: "a contact-change code, minutes long (a security secret)" },
    erasure: "delete",
    rows: P("player_id"),
  },
  review_demo: {
    links: ["player_id"],
    export: {
      excluded: "Questify's App Review demo row; the reviewer account is Questify's own (Q-520)",
    },
    erasure: "keep",
    rows: P("player_id"),
    why: "names the reviewer tombstone by id; its phone is Questify's own reviewer SIM, never a player's",
  },
  review_demo_player: {
    links: ["player_id"],
    export: { excluded: "a mark that the App Review demo made the account (T-710)" },
    erasure: "keep",
    rows: P("player_id"),
    why: PIDS,
  },
  player_deletion_challenge: {
    links: ["player_id"],
    export: { excluded: "a deletion code, minutes long (a security secret)" },
    erasure: "delete",
    rows: P("player_id"),
  },
  player_equipment: {
    links: ["player_id", "character_id", "frame_id", "title_id"],
    export: "questify.equipment",
    erasure: "delete",
    rows: P("player_id"),
  },
  player_fingerprint: {
    links: ["player_id"],
    export: { excluded: "keyed fingerprints of the contacts (security; ADR-176)" },
    erasure: "delete",
    rows: P("player_id"),
  },
  player_item: {
    links: ["player_id", "item_id", "source_rule_id", "source_level", "source_achievement_id"],
    export: "questify.items",
    erasure: "delete",
    rows: P("player_id"),
  },
  player_preference: {
    links: ["player_id"],
    export: "preferences",
    erasure: "delete",
    rows: P("player_id"),
  },
  player_refresh: {
    links: ["player_id", "replaced_by"],
    personal: ["family"],
    export: { excluded: "refresh token hashes (the sessions are exported from player_session)" },
    erasure: "delete",
    rows: P("player_id"),
  },
  player_session: {
    links: ["player_id"],
    personal: ["refresh_family"],
    export: "sessions",
    erasure: "delete",
    rows: P("player_id"),
  },
  player_xp: {
    links: ["player_id"],
    export: "account",
    erasure: "keep",
    rows: P("player_id"),
    why: PIDS,
  },
  player_sign_in_device: {
    links: ["player_id"],
    personal: ["family"],
    export: "signedInDevices",
    erasure: "delete",
    rows: P("player_id"),
  },
  player_reauth_challenge: {
    links: ["player_id"],
    personal: ["family"],
    export: { excluded: "a re-authentication code, minutes long (a security secret)" },
    erasure: "delete",
    rows: P("player_id"),
  },
  push_device: {
    links: ["player_id"],
    personal: ["family"],
    export: "devices",
    erasure: "delete",
    rows: P("player_id"),
  },
  push_send: {
    links: ["device_id"],
    export: { excluded: "the delivery queue; the notification itself is in notifications" },
    erasure: "delete",
    rows: "device_id IN (SELECT id FROM push_device WHERE player_id = $1)",
  },
  push_topic_mute: {
    links: ["player_id"],
    export: "pushTopics.muted",
    erasure: "delete",
    rows: P("player_id"),
  },
  push_topic_on: {
    links: ["player_id"],
    export: "pushTopics.on",
    erasure: "delete",
    rows: P("player_id"),
  },
  quest_bonus_slot: {
    links: ["enrollment_id", "completion_id", "entry_id"],
    export: "events[].bonusPlaces",
    erasure: "keep",
    rows: E("enrollment_id"),
    why: PIDS,
  },
  quest_completion: {
    links: ["enrollment_id"],
    personal: ["device_id"],
    export: "events[].completions",
    erasure: "clear",
    rows: `${E("enrollment_id")} AND device_id IS NOT NULL`,
    why: "the completion stays with the ledger; the app install id is cleared",
  },
  quest_item_miss: {
    links: ["enrollment_id", "source_completion_id"],
    export: "events[].itemsMissed",
    erasure: "delete",
    rows: E("enrollment_id"),
  },
  quest_rating: {
    links: ["enrollment_id"],
    export: "events[].ratings",
    erasure: "keep",
    rows: E("enrollment_id"),
    why: PIDS,
  },
  quest_vote: {
    links: ["enrollment_id", "completion_id"],
    export: "events[].votes",
    erasure: "delete",
    rows: E("enrollment_id"),
  },
  questify_award: {
    links: ["player_id"],
    export: "questify.awards",
    erasure: "keep",
    rows: P("player_id"),
    why: PIDS,
  },
  questify_streak_day: {
    links: ["player_id"],
    export: "questify.streakDays",
    erasure: "keep",
    rows: P("player_id"),
    why: PIDS,
  },
  questify_streak_reward: {
    links: ["player_id"],
    export: "questify.streakRewards",
    erasure: "keep",
    rows: P("player_id"),
    why: PIDS,
  },
  quiz_answer: {
    links: ["attempt_id"],
    export: "events[].quizAnswers[].answers",
    erasure: "delete",
    rows: "attempt_id IN (SELECT t.id FROM quiz_attempt t JOIN enrollment n ON n.id = t.enrollment_id WHERE n.player_id = $1)",
  },
  quiz_attempt: {
    links: ["enrollment_id", "completion_id"],
    export: "events[].quizAnswers",
    erasure: "keep",
    rows: E("enrollment_id"),
    why: PIDS,
  },
  full_name_recheck: {
    links: ["after_enrollment"],
    export: {
      excluded: "the full-name sweep's cursor, the last answer key it checked, no name (ADR-817)",
    },
    erasure: "keep",
    rows: E("after_enrollment"),
    why: PIDS,
  },
  rank_top_snapshot: {
    links: ["enrollment_ids"],
    export: { excluded: "the last copy of the top-10 list, enrollment ids only (T-503)" },
    erasure: "keep",
    rows: "enrollment_ids && ARRAY(SELECT id FROM enrollment WHERE player_id = $1)",
    why: PIDS,
  },
  redemption: {
    links: ["enrollment_id", "offer_by", "operator_id", "source_completion_id"],
    export: "events[].redemptions",
    erasure: "keep",
    rows: `${E("enrollment_id")} OR offer_by = $1 OR operator_id = $1`,
    why:
      "handed-over prizes stay for the organizer's stock; reserved ones end with 'erasure'; " +
      PIDS,
  },
  result_place: {
    links: ["enrollment_id", "redemption_id"],
    export: "events[].resultPlace",
    erasure: "keep",
    rows: E("enrollment_id"),
    why: PIDS,
  },
  reward_code: {
    links: ["redemption_id"],
    export: { excluded: "the prize code, ciphered; the app shows it while the prize is valid" },
    erasure: "keep",
    rows: "redemption_id IN (SELECT d.id FROM redemption d JOIN enrollment n ON n.id = d.enrollment_id WHERE n.player_id = $1)",
    why: PIDS,
  },
  session_attendance: {
    links: ["enrollment_id", "player_id", "operator_id"],
    export: "events[].sessionsAttended",
    erasure: "keep",
    rows: "player_id = $1 OR operator_id = $1",
    why: PIDS,
  },
  session_registration: {
    links: ["enrollment_id", "player_id"],
    export: "events[].sessionsRegistered",
    erasure: "keep",
    rows: P("player_id"),
    why: PIDS,
  },
  souvenir_receipt: {
    links: ["player_id", "enrollment_id"],
    export: "questify.souvenirReceipts",
    erasure: "delete",
    rows: P("player_id"),
  },
  souvenir_work: {
    links: ["enrollment_id"],
    export: "events[].souvenirOnTheWay",
    erasure: "delete",
    rows: E("enrollment_id"),
    why: "only whether one is on the way; leases and errors stay out (T-402b)",
  },
  staff_assignment: {
    links: ["player_id"],
    export: "events[].staffRoles",
    erasure: "delete",
    rows: P("player_id"),
  },
  staff_assignment_quest: {
    links: ["assignment_id"],
    export: "events[].staffRoles[].quests",
    erasure: "delete",
    rows: ASSIGNMENTS("assignment_id"),
  },
  submission: {
    links: ["enrollment_id", "reviewed_by_operator", "completion_id", "photo"],
    export: "events[].submissions",
    erasure: "clear",
    rows: `${E("enrollment_id")} AND body IS NOT NULL`,
    why: "body cleared, a reviewer's reason kept only when the system wrote it; reviews the player made keep the id",
  },
  survey_response: {
    links: ["enrollment_id", "completion_id"],
    personal: ["answers"],
    export: "events[].surveyResponses",
    erasure: "delete",
    rows: E("enrollment_id"),
  },
  media_object: {
    links: ["uploaded_by_player"],
    export: {
      excluded:
        "a photo's row holds no image, only its key and size; the photo's place in the download is Q-765",
    },
    erasure: "keep",
    rows: P("uploaded_by_player"),
    why: "no image and no text: an attached photo goes with its submission or ticket at erasure (triggers, 0193), an unattached upload within 30 minutes (the sweep), and the bucket object after the worker's next run",
  },
  // Organizer images (0194): a map's picture and a sponsor's logo and banner are foreign keys to `media_object`, which
  // also holds player photos, so the closure reaches these organizer tables. Their image is never a player's photo
  // (media_images_use takes organizer kinds only), so no row is about a player.
  event_map: {
    links: ["image"],
    export: {
      excluded: "the organizer's map; its picture is an organizer image, never a player's photo",
    },
    erasure: "keep",
    rows: "image IN (SELECT id FROM media_object WHERE uploaded_by_player = $1)",
    why: "organizer content: no row names a player",
  },
  map_pin: {
    links: ["map_id"],
    export: { excluded: "the organizer's pins" },
    erasure: "keep",
    rows: "map_id IN (SELECT m.id FROM event_map m JOIN media_object o ON o.id = m.image WHERE o.uploaded_by_player = $1)",
    why: "organizer content: no row names a player",
  },
  sponsor: {
    links: ["logo", "banner"],
    export: {
      excluded: "the organizer's sponsor profile; its logo and banner are organizer images",
    },
    erasure: "keep",
    rows: "logo IN (SELECT id FROM media_object WHERE uploaded_by_player = $1) OR banner IN (SELECT id FROM media_object WHERE uploaded_by_player = $1)",
    why: "organizer content: no row names a player",
  },
  sponsor_tag: {
    links: ["sponsor_id"],
    export: { excluded: "the organizer's tags" },
    erasure: "keep",
    rows: "sponsor_id IN (SELECT s.id FROM sponsor s JOIN media_object o ON o.id IN (s.logo, s.banner) WHERE o.uploaded_by_player = $1)",
    why: "organizer content: no row names a player",
  },
  ticket: {
    links: [
      "player_id",
      "enrollment_id",
      "reported_enrollment_id",
      "answered_by_operator",
      "photo",
    ],
    export: "tickets",
    erasure: "delete",
    rows: P("player_id"),
    why: "the player's own requests are deleted; another player's report names the enrollment id only",
  },
  username_history: {
    links: ["player_id"],
    export: "usernames",
    erasure: "delete",
    rows: P("player_id"),
  },
  xp_entry: {
    links: [
      "player_id",
      "ledger_entry_id",
      "daily_finish_id",
      "streak_reward_id",
      "questify_award_id",
      "reverses",
    ],
    export: "questify.xpEntries",
    erasure: "keep",
    rows: P("player_id"),
    why: "the append-only XP record; " + PIDS,
  },
  // FK-less player links.
  notice: {
    links: ["player_id"],
    personal: ["params", "refs"],
    export: "notifications",
    erasure: "delete",
    rows: P("player_id"),
  },
  notification: {
    links: ["player_id", "notice_id"],
    export: "notifications",
    erasure: "delete",
    rows: P("player_id"),
  },
  invitation_recipient: {
    links: ["player_id"],
    export: "invitations",
    erasure: "delete",
    rows: P("player_id"),
  },
  xp_board: {
    links: ["player_id"],
    export: { excluded: "a ranking copy of the XP already in account" },
    erasure: "keep",
    rows: P("player_id"),
    why: PIDS,
  },
  // By name: no link column.
  player_login_challenge: {
    links: [],
    export: { excluded: "a sign-in code, minutes long; it holds the contact in clear" },
    erasure: "delete",
    rows: "contact IN ($2, $3)",
  },
  erased_mark: {
    links: [],
    export: { excluded: "keyed fingerprints left by a deleted account (ADR-176)" },
    erasure: "keep",
    rows: "true",
    why: "keyed hashes only",
  },
  staff_user: {
    links: [],
    export: { excluded: "operator and organizer identity, a separate account (Q-445)" },
    erasure: "keep",
    rows: "false",
    why: "not a player",
  },
};

const ADMIN = "an admin's or a team member's staff_user id (no FK by design)";
const ORG = "the organizer's or event's id, never a player";
const OPAQUE = "an opaque request, lease, cursor or batch id";

/** Every FK-less `uuid`, `uuid[]` and `jsonb` column that is not a player link, with why (`table.column`). */
export const NOT_PLAYER: Readonly<Record<string, string>> = {
  "announcement.created_by": ADMIN,
  "full_name_recheck.after_field": "a join field's id in the sweep's cursor, never a player",
  "audit_log.after": "codes and ids only by rule; the audit assertion scans it after an erasure",
  "audit_log.before": "codes and ids only by rule; the audit assertion scans it after an erasure",
  "audit_log.event_id": ORG,
  "audit_log.organizer_id": ORG,
  "media_delete.organizer_id": ORG,
  "media_delete.claim": OPAQUE,
  "media_object.quest_id":
    "the quest a submission photo was sent for (no FK: the event's cascade removes the row)",
  "audit_log.request_id": OPAQUE,
  "audit_log.support_grant_id": OPAQUE,
  "bulk_award.staff_user_id": ADMIN,
  "change_set.created_by": ADMIN,
  "change_set_item.before": "the organizer's content before a change",
  "change_set_item.body": "the organizer's content after a change",
  "change_set_item.error": "a change's error codes",
  "change_set_item.target_id": "the organizer's quest, reward or category",
  "content_hold.target_id": "the organizer's content Questify holds",
  "content_report.snapshot":
    "what was reported; a username report is deleted with the reported account",
  "daily_cadence.set_by": ADMIN,
  "daily_challenge.set_by": ADMIN,
  "daily_question.created_by": ADMIN,
  "daily_word.set_by": ADMIN,
  "event.config": "the event's configuration",
  "event_join_field.options": "the organizer's answer options",
  "event_map.created_by": ADMIN,
  "event_rehearsal.erase_counts": "counts of a rehearsal's wiped rows",
  "event_session.created_by": ADMIN,
  "event_setup.updated_by": ADMIN,
  "review_demo.created_by": ADMIN,
  "review_demo.prepared_by": ADMIN,
  "feature_request.decided_by": ADMIN,
  "feature_request.requested_by": ADMIN,
  "event_template.body": "the organizer's template",
  "group_push.cursor_player": OPAQUE,
  "invitation_campaign.request_id": OPAQUE,
  "invitation_recipient.campaign_id": ORG,
  "invitation_recipient.lease_token": OPAQUE,
  "invitation_recipient.link": OPAQUE,
  "kiosk_scan.event_id": ORG,
  "kiosk_scan.organizer_id": ORG,
  "ledger_entry.staff_user_id": ADMIN,
  "legal_version.published_by": ADMIN,
  "manual_award_key.staff_user_id": ADMIN,
  "map_pin.created_by": ADMIN,
  "map_pin.organizer_id": ORG,
  "nfc_tap.event_id": ORG,
  "nfc_tap.organizer_id": ORG,
  "notice.fan_cursor": OPAQUE,
  "notification.event_id": ORG,
  "operator_invite.batch_id": OPAQUE,
  "organizer_alert.lease_token": OPAQUE,
  "organizer_alert.staff_user_id": ADMIN,
  "organizer_invite.event_scope": ORG,
  "organizer_feature_override.set_by": ADMIN,
  "organizer_member.event_scope": ORG,
  "platform_setting.value": "a platform setting",
  "quest.deleted_by": ADMIN,
  "quest.paused_by": ADMIN,
  "quest.skipped_by": ADMIN,
  "quest.type_config": "the quest's configuration",
  "quest_points_change.request_id": OPAQUE,
  "quest_points_change.staff_user_id": ADMIN,
  "session_attendance.organizer_id": ORG,
  "session_message.created_by": ADMIN,
  "session_message.organizer_id": ORG,
  "session_registration.organizer_id": ORG,
  "souvenir_command.event_id": ORG,
  "souvenir_command.result_id": OPAQUE,
  "souvenir_command.staff_user_id": ADMIN,
  "souvenir_scan.cursor_id": OPAQUE,
  "souvenir_work.lease_token": OPAQUE,
  "sponsor.created_by": ADMIN,
  "sponsor_tag.created_by": ADMIN,
  "staff_assignment.invite_id": OPAQUE,
  "staff_briefing.created_by": ADMIN,
  "submission.reviewed_by_staff": ADMIN,
  "survey_share.created_by": ADMIN,
  "team_alert.change_id": "a staff account's email change, never a player",
  "team_alert.event_id": ORG,
  "team_alert.lease": OPAQUE,
  "team_alert.organizer_id": ORG,
  "team_alert.report_id": "the report the alert is about; its player link is the report's",
  "xp_entry.quest_id": "a Questify quest's id",
  "push_send.lease_token": OPAQUE,
};

/**
 * Where a player's data lives outside the tables, and what an erasure does there (ADR-482). Checked by review; listed
 * so the next store is added here too.
 */
export const NON_TABLE_STORES: Readonly<Record<string, string>> = {
  "redis ranking copy":
    "enrollment ids and scores, rebuilt from the ledger; ranking_repair drops an erased player",
  "idempotency store":
    "remembered answers under player:<id>, forgotten after every erasure (deletion.ts, data-requests)",
  "api structured log":
    "ids only (rules.md 3); player.deleted lines are what the re-apply after a restore reads",
  "rate-limit buckets": "keyed hashes in throttle rows that expire with their windows",
  "push providers":
    "device tokens, deleted with push_device; providers keep nothing addressable after that",
};
