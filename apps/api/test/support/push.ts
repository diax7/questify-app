import { randomBytes, randomUUID } from "node:crypto";
import type { RequestContext } from "#src/db/context";
import { questifyFixture } from "#test/support/questify";

/** A call's SQLSTATE, or "none" when it succeeds. */
export const sqlstate = (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "none",
    (error: { code?: string }) => error.code ?? "unknown",
  );

export type KindOptions = Readonly<{
  class?: "personal" | "event" | "promo";
  topic?: "announcements" | "rank" | "community" | "reminders" | null;
  membership?: "active" | "decided" | "none";
  beforeStart?: boolean;
  ttl?: string;
}>;

export type NoticeOptions = Readonly<{
  event?: string | null;
  player?: string | null;
  refs?: Record<string, unknown>;
  params?: Record<string, unknown>;
  dedupe?: string;
  until?: Date | null;
}>;

/** A sign-in of a player: its refresh family and the hash of its live access token. */
export type SignIn = Readonly<{ family: string; session: Buffer; refresh: Buffer }>;

export type SendRow = Readonly<{
  id: string;
  notification_id: string;
  device_id: string;
  notice_id: string;
  target: string;
  state: string;
  attempts: number;
  code: string | null;
  lease_token: string | null;
}>;

export type Claimed = Readonly<{
  send_id: string;
  lease: string;
  target: string;
  token: string;
  language: string;
  kind: string;
  notification_id: string;
  attempts: number;
  priority: number;
}>;

const hex = (bytes: number) => randomBytes(bytes).toString("hex");

/**
 * Fixtures for T-501's database suites (migration 0076): test kinds inserted as the owner (0076 seeds none), notices
 * through notice_create, sign-ins with a live refresh family, devices through the register door, and the worker's
 * doors run in the system context.
 */
export async function pushFixture() {
  const f = await questifyFixture();
  const system: RequestContext = {};
  let kinds = 0;

  const one = async <T>(context: RequestContext, sql: string, values: unknown[] = []) =>
    (await f.run<{ r: T }>(context, sql, values))[0]?.r as T;
  const count = async (from: string, values: unknown[] = []): Promise<number> =>
    (await f.owner<{ n: number }>(`SELECT count(*)::int AS n FROM ${from}`, values))[0]?.n ?? 0;

  /** A new notice kind; personal by default, a day to live. */
  const kind = async (options: KindOptions = {}): Promise<string> => {
    kinds += 1;
    const name = `test_kind_${[...String(kinds)].map((digit) => "abcdefghij"[Number(digit)]).join("")}`;
    const cls = options.class ?? "personal";
    await f.owner(
      `INSERT INTO notice_kind (kind, class, topic, membership, before_start, priority, ttl)
       VALUES ($1, $2, $3, $4, $5, $6, $7::interval)`,
      [
        name,
        cls,
        options.topic ?? null,
        options.membership ?? "active",
        options.beforeStart ?? false,
        { personal: 0, event: 1, promo: 2 }[cls],
        options.ttl ?? "1 day",
      ],
    );
    return name;
  };

  /** notice_create as a producer calls it (internal: the owner calls it here); the new id or null. */
  const notice = async (name: string, options: NoticeOptions = {}): Promise<string | null> => {
    const event = options.event ?? null;
    const organizer =
      event === null
        ? null
        : ((
            await f.owner<{ organizer_id: string }>(
              "SELECT organizer_id FROM event WHERE id = $1",
              [event],
            )
          )[0]?.organizer_id ?? null);
    const [row] = await f.owner<{ id: string | null }>(
      "SELECT notice_create($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8) AS id",
      [
        name,
        organizer,
        event,
        options.player ?? null,
        JSON.stringify(options.refs ?? {}),
        JSON.stringify(options.params ?? {}),
        options.dedupe ?? randomUUID(),
        options.until ?? null,
      ],
    );
    return row?.id ?? null;
  };

  /** A sign-in: a live refresh token in a new family and a live access session (as issue_player_tokens writes them). */
  const signIn = async (player: string): Promise<SignIn> => {
    const family = randomUUID();
    const session = randomBytes(32);
    const refresh = randomBytes(32);
    await f.owner(
      `INSERT INTO player_refresh (player_id, family, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + interval '180 days')`,
      [player, family, refresh],
    );
    await f.owner(
      `INSERT INTO player_session (player_id, token_hash, expires_at, refresh_family)
       VALUES ($1, $2, now() + interval '1 hour', $3)`,
      [player, session, family],
    );
    return { family, session, refresh };
  };

  const register = (
    player: string,
    session: Buffer,
    device: Readonly<{
      platform?: string;
      token?: string;
      environment?: string | null;
      language?: string;
    }> = {},
  ) =>
    one({ playerId: player }, "SELECT push_device_register($1, $2, $3, $4, $5, '1.0.0') AS r", [
      session,
      device.platform ?? "ios",
      device.token ?? hex(32),
      device.environment === undefined ? "production" : device.environment,
      device.language ?? "ar",
    ]);

  /** A signed-in phone with a registered device (iOS production by default); answers its sign-in and token. */
  const phone = async (
    player: string,
    device: Readonly<{
      platform?: "ios" | "android";
      environment?: "sandbox" | "production";
      language?: string;
    }> = {},
  ): Promise<SignIn & Readonly<{ token: string; deviceId: string }>> => {
    const sign = await signIn(player);
    const platform = device.platform ?? "ios";
    const token = platform === "ios" ? hex(32) : `fcm_${hex(40)}`;
    await register(player, sign.session, {
      platform,
      token,
      environment: platform === "ios" ? (device.environment ?? "production") : null,
      language: device.language ?? "ar",
    });
    const [row] = await f.owner<{ id: string }>("SELECT id FROM push_device WHERE family = $1", [
      sign.family,
    ]);
    return { ...sign, token, deviceId: row?.id ?? "" };
  };

  /** A new player with a phone. */
  const playerWithPhone = async (device?: Parameters<typeof phone>[1]) => {
    const who = await f.newPlayer();
    return { who, ...(await phone(who, device)) };
  };

  /** Runs the fan-out until it reports nothing more. */
  const fanOut = async (): Promise<number> => {
    let rows = 0;
    for (let call = 0; call < 200; call += 1) {
      const done = await one<{ rows: number; more: boolean }>(system, "SELECT push_fan_out() AS r");
      rows += done.rows;
      if (!done.more) return rows;
    }
    throw new Error("the fan-out never finished");
  };

  const claim = (
    targets: readonly string[] = ["apns:production", "apns:sandbox", "fcm"],
    size = 200,
    seat = system,
  ) => f.run<Claimed>(seat, "SELECT * FROM push_claim($1, $2)", [[...targets], size]);

  const ack = (
    rows: ReadonlyArray<
      Readonly<{
        id: string;
        lease: string;
        outcome: string;
        code?: string | null;
        attempts: number;
      }>
    >,
  ) =>
    one<number>(
      system,
      "SELECT push_ack($1::bigint[], $2::uuid[], $3::text[], $4::text[], $5::smallint[]) AS r",
      [
        rows.map((row) => row.id),
        rows.map((row) => row.lease),
        rows.map((row) => row.outcome),
        rows.map((row) => row.code ?? null),
        rows.map((row) => row.attempts),
      ],
    );

  const settle = () => one<Record<string, unknown>>(system, "SELECT push_settle() AS r");

  /** A queue of `rows` sends of one new notice on one device, written straight into the tables, for random players. */
  const syntheticQueue = async (kindName: string, rows: number, deviceId: string) => {
    const [made] = await f.owner<{ id: string }>(
      `INSERT INTO notice (kind, audience, dedupe, expires_at, fanned_at)
       VALUES ($1, 'event', $2, now() + interval '1 day', now()) RETURNING id`,
      [kindName, randomUUID()],
    );
    await f.owner(
      `WITH c AS (INSERT INTO notification (notice_id, player_id)
                  SELECT $1, gen_random_uuid() FROM generate_series(1, $2) RETURNING id)
       INSERT INTO push_send (notification_id, device_id, notice_id, target, priority, expires_at)
       SELECT c.id, $3, $1, 'apns:production', 1, now() + interval '1 day' FROM c`,
      [made?.id, rows, deviceId],
    );
    return made?.id ?? "";
  };

  /** `n` players signed in on one iOS phone each, with one queued personal notice each, written straight in. */
  const personalQueue = async (kindName: string, n: number) => {
    await f.owner(
      `WITH p AS (INSERT INTO player (username)
                  SELECT 'pq_' || $2 || '_' || g FROM generate_series(1, $3) g RETURNING id),
            r AS (INSERT INTO player_refresh (player_id, family, token_hash, expires_at)
                  SELECT id, gen_random_uuid(), sha256(convert_to(id::text, 'UTF8')), now() + interval '180 days'
                  FROM p RETURNING player_id, family),
            d AS (INSERT INTO push_device (player_id, family, platform, token, environment, language, app_version)
                  SELECT player_id, family, 'ios', md5(family::text) || md5(player_id::text), 'production', 'ar', '1'
                  FROM r RETURNING id, player_id),
            nt AS (INSERT INTO notice (kind, player_id, audience, dedupe, expires_at, fanned_at)
                   SELECT $1, d.player_id, 'player', d.id::text, now() + interval '1 day', now() FROM d
                   RETURNING id, player_id),
            c AS (INSERT INTO notification (notice_id, player_id)
                  SELECT nt.id, nt.player_id FROM nt RETURNING id, notice_id, player_id)
       INSERT INTO push_send (notification_id, device_id, notice_id, target, priority, expires_at)
       SELECT c.id, d.id, c.notice_id, 'apns:production', 0, now() + interval '1 day'
       FROM c JOIN d ON d.player_id = c.player_id`,
      [kindName, randomUUID().slice(0, 8), n],
    );
  };

  /** Ends every queued or leased send left by earlier tests, so a claim sees only the test's own rows. */
  const drain = () =>
    f.owner(
      `UPDATE push_send SET state = 'expired', code = 'expired', finished_at = now(), lease_token = NULL,
                            lease_until = NULL
       WHERE state IN ('queued', 'sending')`,
    );

  /** The players with a center row for a notice. */
  const recipients = async (noticeId: string | null): Promise<string[]> =>
    (
      await f.owner<{ player_id: string }>(
        "SELECT player_id FROM notification WHERE notice_id = $1 ORDER BY player_id",
        [noticeId],
      )
    ).map((row) => row.player_id);

  /** The sends of a notice (or of every notice). */
  const sends = (noticeId?: string | null) =>
    f.owner<SendRow>(
      `SELECT id, notification_id, device_id, notice_id, target, state, attempts, code, lease_token FROM push_send
       WHERE $1::bigint IS NULL OR notice_id = $1 ORDER BY id`,
      [noticeId ?? null],
    );

  const switchPush = (enabled: boolean) =>
    f.owner(
      `INSERT INTO platform_setting (key, value)
       VALUES ('features', jsonb_build_object('pushNotifications', jsonb_build_object('enabled', $1::boolean)))
       ON CONFLICT (key) DO UPDATE SET value = platform_setting.value || excluded.value`,
      [enabled],
    );

  /** Consent to promotional push (an adult, as promo_pool requires). */
  const consentPush = async (player: string, granted = true) => {
    await f.owner("UPDATE player SET birth_year = 1990 WHERE id = $1", [player]);
    await f.owner(
      `INSERT INTO marketing_consent (player_id, channel, granted, method, text_version)
       VALUES ($1, 'push', $2, 'settings', CASE WHEN $2 THEN '1' END)`,
      [player, granted],
    );
  };

  /**
   * Runs `work` with a shipped kind's row missing (its notices removed first), then puts the row back: a producer then
   * meets an unknown kind, which must write nothing and raise nothing (plan § Review 2, "a broken kind").
   */
  const withoutKind = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
    const [row] = await f.owner<Record<string, unknown>>(
      "SELECT kind, class, topic, membership, before_start, priority, ttl::text AS ttl FROM notice_kind WHERE kind = $1",
      [name],
    );
    await f.owner("DELETE FROM notice WHERE kind = $1", [name]);
    await f.owner("DELETE FROM notice_kind WHERE kind = $1", [name]);
    try {
      return await work();
    } finally {
      await f.owner(
        `INSERT INTO notice_kind (kind, class, topic, membership, before_start, priority, ttl)
         VALUES ($1, $2, $3, $4, $5, $6, $7::interval)`,
        [
          row?.["kind"],
          row?.["class"],
          row?.["topic"],
          row?.["membership"],
          row?.["before_start"],
          row?.["priority"],
          row?.["ttl"],
        ],
      );
    }
  };

  const erase = async (player: string) => {
    const token = await f.deletionToken(player);
    const [erased] = await f.run<{ outcome: string }>(
      { playerId: player },
      "SELECT outcome FROM erase_player($1, true, $2)",
      [token, randomUUID()],
    );
    return erased?.outcome;
  };

  return {
    ...f,
    system,
    one,
    count,
    kind,
    notice,
    signIn,
    register,
    phone,
    playerWithPhone,
    fanOut,
    claim,
    ack,
    settle,
    drain,
    syntheticQueue,
    personalQueue,
    recipients,
    sends,
    switchPush,
    consentPush,
    withoutKind,
    erase,
  };
}

export type PushFixture = Awaited<ReturnType<typeof pushFixture>>;
