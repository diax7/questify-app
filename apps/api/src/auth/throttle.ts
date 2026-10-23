import type { Client, PoolClient } from "pg";

type Db = Client | PoolClient;

export const BUCKETS = {
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
