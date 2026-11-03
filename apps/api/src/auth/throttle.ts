import type { Client, PoolClient } from "pg";

type Db = Client | PoolClient;

export const BUCKETS = {
  profileRead: "profile_read",
  questifySync: "questify_sync",
  gemPurchase: "gem_purchase",
  dailyAnswer: "daily_answer",
  dailyGuess: "daily_guess",
  marketingWrite: "marketing_write",
  marketingOptOut: "marketing_opt_out",
  pushDevice: "push_device",
  invitationOpen: "invitation_open",
  surveyResultsOpen: "survey_results_open",
  failEmail: "fail_email",
  failAddress: "fail_address",
  challengeUser: "challenge_user",
  resetEmail: "reset_email",
  resetAddress: "reset_address",
  signupEmail: "signup_email",
  signupAddress: "signup_address",
  organizerCreate: "organizer_create",
  outboundMail: "outbound_mail",
  inviteOrganizer: "invite_organizer",
  inviteAddress: "invite_address",
  codePlayerQuest: "code_player_quest",
  codePlayer: "code_player",
  codeDevice: "code_device",
  checkInPlayerQuest: "checkin_player_quest",
  playerCodeContact: "player_code_contact",
  playerCodeDevice: "player_code_device",
  playerCodeAddress: "player_code_address",
  playerFailContact: "player_fail_contact",
  playerFailAddress: "player_fail_address",
  smsPlatform: "sms_platform",
  playerEmailPlatform: "player_email_platform",
  joinCodeMiss: "join_code_miss",
  contactCodePlayer: "contact_code_player",
  contactFailPlayer: "contact_fail_player",
  awardFind: "award_find",
  deskFind: "desk_find",
  meetPass: "meet_pass",
  meetState: "meet_state",
  meetRefused: "meet_refused",
  gameRound: "game_round",
  gameResult: "game_result",
  nfcPrepare: "nfc_prepare",
  nfcConfirm: "nfc_confirm",
  nfcTap: "nfc_tap",
  deviceRequest: "device_request",
  devicePoll: "device_poll",
  deviceWrite: "device_write",
  deviceScreenCode: "device_screen_code",
  deviceScene: "device_scene",
  operatorScreenCode: "operator_screen_code",
  kioskScan: "kiosk_scan",
  kioskBadCode: "kiosk_bad_code",
  liveCode: "live_code",
  ticketRead: "ticket_read",
  inboxRead: "inbox_read",
  ticketLookup: "ticket_lookup",
  consoleTicket: "console_ticket",
  consoleOrganizer: "console_organizer",
  consoleSuspend: "console_suspend",
  consoleHealth: "console_health",
  consoleAdmins: "console_admins",
  consoleSessionEnd: "console_session_end",
  consoleCatalog: "console_catalog",
  consoleCatalogWrite: "console_catalog_write",
  consolePlayerSearch: "console_player_search",
  consolePlayerRead: "console_player_read",
  consolePlayerContact: "console_player_contact",
  consolePlayerChange: "console_player_change",
  consolePlayerBan: "console_player_ban",
  dataExportOwn: "data_export_own",
  consoleDataExport: "console_data_export",
  consoleDataErase: "console_data_erase",
  consoleWords: "console_words",
  consoleWordsWrite: "console_words_write",
  playerBlock: "player_block",
  consoleReports: "console_reports",
  consoleModeration: "console_moderation",
  consoleFlags: "console_flags",
  consoleOwnerEmail: "console_owner_email",
  consoleOwnerEmailChange: "console_owner_email_change",
  supportView: "support_view",
  emailChangeAddress: "email_change_address",
  teamAlertMail: "team_alert_mail",
  stationToday: "station_today",
  deviceClaim: "device_claim",
  deviceMissEvent: "device_miss_event",
  deviceMissOrganizer: "device_miss_organizer",
  deviceMissPlatform: "device_miss_platform",
  featureRequest: "feature_request",
} as const;

export type Bucket = (typeof BUCKETS)[keyof typeof BUCKETS];

export type Window = Readonly<{ count: number; retryAfterSeconds: number }>;

/**
 * Takes a lock on a key for the rest of the transaction, or says no without waiting. Counting and
 * recording under this lock cannot race, and a flood of requests for one key never parks pooled connections.
 */
export async function tryLock(db: Db, key: Buffer): Promise<boolean> {
  const { rows } = await db.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_xact_lock($1::bigint) AS locked",
    [key.readBigInt64BE(0).toString()],
  );
  return rows[0]?.locked === true;
}

/**
 * Takes a lock on a key for the rest of the transaction, waiting for it under the pool's lock timeout. Only for callers
 * that are already signed in and whose second call is not an attack (a console page reading several tabs at once).
 */
export async function waitLock(db: Db, key: Buffer): Promise<void> {
  await db.query("SELECT pg_advisory_xact_lock($1::bigint)", [key.readBigInt64BE(0).toString()]);
}

/** How many attempts a key has in the window, and how long until the oldest one leaves it. */
export async function countRecent(
  db: Db,
  bucket: Bucket,
  key: Buffer,
  windowSeconds: number,
): Promise<Window> {
  const { rows } = await db.query<{ count: number; retry_after: number | null }>(
    `SELECT count(*)::int AS count,
            ceil(extract(epoch FROM min(at) + make_interval(secs => $3) - now()))::int AS retry_after
     FROM auth_throttle
     WHERE bucket = $1 AND key = $2 AND at > now() - make_interval(secs => $3)`,
    [bucket, key, windowSeconds],
  );
  const row = rows[0];
  return { count: row?.count ?? 0, retryAfterSeconds: Math.max(row?.retry_after ?? 0, 1) };
}

/** Records one attempt and returns its exact time (as text, so no precision is lost) to undo it later. */
export async function record(db: Db, bucket: Bucket, key: Buffer): Promise<string> {
  const { rows } = await db.query<{ at: string }>(
    "INSERT INTO auth_throttle (bucket, key, at) VALUES ($1, $2, clock_timestamp()) RETURNING at::text AS at",
    [bucket, key],
  );
  return rows[0]?.at ?? "";
}

/** Removes the attempt recorded at `at`, for example when the sign-in it was reserved for succeeded. */
export async function forget(db: Db, bucket: Bucket, key: Buffer, at: string): Promise<void> {
  await db.query(
    "DELETE FROM auth_throttle WHERE bucket = $1 AND key = $2 AND at = $3::timestamptz",
    [bucket, key, at],
  );
}

/** Removes every attempt of a key (the runbook's way to free a locked-out person). */
export async function clearKey(db: Db, bucket: Bucket, key: Buffer): Promise<void> {
  await db.query("DELETE FROM auth_throttle WHERE bucket = $1 AND key = $2", [bucket, key]);
}

/** Deletes attempts older than a day. */
export async function sweepThrottle(db: Db): Promise<void> {
  await db.query("DELETE FROM auth_throttle WHERE at < now() - interval '1 day'");
}
