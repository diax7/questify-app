import { randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";
import type { RequestContext } from "#src/db/context";
import { questifyFixture } from "#test/support/questify";
import { addMember } from "#test/support/test-db";

/** A call's SQLSTATE, or "none" when it succeeds. */
export const sqlstate = (work: Promise<unknown>): Promise<string> =>
  work.then(
    () => "none",
    (error: { code?: string }) => error.code ?? "unknown",
  );

/** Noon in Riyadh on an ordinary day: outside every quiet band, for claims at a fixed moment. */
export const NOON = new Date("2026-10-27T12:00:00+03:00");

export type CampaignRow = Readonly<{
  id: string;
  event_id: string;
  state: string;
  end_reason: string | null;
  name_ar: string | null;
  name_en: string | null;
  cap: number | null;
  planned: number;
  sent: number;
  unknown: number;
  failed: number;
  skipped: number;
  cancelled: number;
  opened: number;
  joined: number;
  published_sent: number | null;
  published_opened: number | null;
  published_joined: number | null;
  published_at: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
  final_at: Date | null;
}>;

export type RecipientRow = Readonly<{
  id: string;
  link: string;
  player_id: string;
  state: string;
  skip_reason: string | null;
  error_code: string | null;
  lease_token: string | null;
  sent_at: Date | null;
  opened_at: Date | null;
  joined_at: Date | null;
}>;

export type Claimed = Readonly<{
  recipient_id: string;
  lease: string;
  channel: string;
  language: string;
  phone: string;
  player_id: string;
  link: string;
  name_ar: string | null;
  name_en: string | null;
}>;

/** A request body: the smallest size, and any field replaced. */
const body = (over: Record<string, unknown> = {}) => ({ size: 50, ...over });

export type PoolOptions = Readonly<{
  cityId?: string;
  interests?: readonly string[];
  language?: "ar" | "en" | null;
  /** This year minus the birth year (default 30). */
  age?: number;
  /** Without one the player has an email only (default true). */
  phone?: boolean;
}>;

/**
 * Fixtures for T-409's database suites (migration 0073): an admin, an editor, a limited editor and organizer B's owner;
 * the platform switch; eligible events; players opted in to promotional SMS in bulk; and every door called from its
 * seat. `isolate` turns everyone's SMS consent off first, so a fill sees only the players a test made.
 */
export async function invitationFixture() {
  const f = await questifyFixture();
  const [staff] = await f.owner<{ id: string }>(
    "INSERT INTO staff_user (email, password_hash, platform_role) VALUES ('iv-admin@questify.test', 'h', 'admin') RETURNING id",
  );
  const admin = staff?.id ?? "";
  const editor = await addMember(f.db.owner, f.ids.orgA, "editor");
  const ownerB = await addMember(f.db.owner, f.ids.orgB, "owner");
  const owner: RequestContext = f.team();
  const adminSeat: RequestContext = { isAdmin: true, staffUserId: admin };
  const system: RequestContext = {};
  let batch = 0;
  let phones = 0;

  const one = async <T>(context: RequestContext, sql: string, values: unknown[] = []) =>
    (await f.run<{ r: T }>(context, sql, values))[0]?.r as T;

  const switchOn = (enabled = true) =>
    f.owner(
      `INSERT INTO platform_setting (key, value)
       VALUES ('features', jsonb_build_object('invitationCampaigns', jsonb_build_object('enabled', $1::boolean)))
       ON CONFLICT (key) DO UPDATE SET value = platform_setting.value || excluded.value`,
      [enabled],
    );

  /** Turns every player's SMS consent off, so the next fill sees only players made after it. */
  const isolate = () =>
    f.owner(
      `INSERT INTO marketing_consent (player_id, channel, granted, method)
       SELECT s.player_id, 'sms', false, 'settings' FROM marketing_state s WHERE s.channel = 'sms' AND s.opted_in`,
    );

  /** `n` new active players opted in to promotional SMS (by default adults with a phone, no city or interests). */
  const optedIn = async (n: number, options: PoolOptions = {}): Promise<string[]> => {
    batch += 1;
    const made = await f.owner<{ id: string }>(
      `INSERT INTO player (username, birth_year)
       SELECT 'iv' || $1 || '_' || g, extract(year FROM now() AT TIME ZONE 'Asia/Riyadh')::integer - $3
       FROM generate_series(1, $2) g RETURNING id`,
      [batch, n, options.age ?? 30],
    );
    const ids = made.map((row) => row.id);
    const withPhone = options.phone !== false;
    await f.owner(
      `INSERT INTO player_contact (player_id, phone_e164, email)
       SELECT id, CASE WHEN $3 THEN '+9665' || lpad(($2 + ordinality)::text, 8, '0') END,
              CASE WHEN $3 THEN NULL ELSE 'iv' || ($2 + ordinality) || '@mail.test' END
       FROM unnest($1::uuid[]) WITH ORDINALITY AS u(id, ordinality)`,
      [ids, phones, withPhone],
    );
    phones += n;
    await f.owner(
      `INSERT INTO marketing_consent (player_id, channel, granted, method, text_version, language)
       SELECT id, 'sms', true, 'settings', '1', $2 FROM unnest($1::uuid[]) id`,
      [ids, options.language ?? null],
    );
    if (options.cityId !== undefined || options.interests !== undefined) {
      await f.owner(
        `INSERT INTO player_preference (player_id, city_id, interests)
         SELECT id, $2, $3::text[] FROM unnest($1::uuid[]) id`,
        [ids, options.cityId ?? null, options.interests ?? []],
      );
    }
    return ids;
  };

  /** A public event, scheduled to start tomorrow and end in three days: eligible as made. */
  const eligibleEvent = (organizer?: string) =>
    f.newEvent({ phase: "scheduled", ...(organizer === undefined ? {} : { organizer }) });

  const request = <T = { id: string; state: string }>(
    event: string,
    over: Record<string, unknown> = {},
    seat: RequestContext = owner,
    key: string = randomUUID(),
  ) =>
    one<T>(seat, "SELECT invitation_request($1, $2::jsonb, $3) AS r", [
      event,
      JSON.stringify(body(over)),
      key,
    ]);

  const eventNames = async (event: string) =>
    (
      await f.owner<{ name_ar: string | null; name_en: string | null }>(
        "SELECT name_ar, name_en FROM event WHERE id = $1",
        [event],
      )
    )[0] ?? { name_ar: null, name_en: null };

  type Approval = Readonly<{
    cap?: number;
    at?: Date;
    note?: string | null;
    channels?: string[];
    names?: Readonly<{ name_ar: string | null; name_en: string | null }>;
  }>;
  const approve = async <T = { id: string; state: string }>(
    campaign: string,
    over: Approval = {},
  ): Promise<T> => {
    const event = (await campaignRow(campaign)).event_id;
    const names = over.names ?? (await eventNames(event));
    return one<T>(
      adminSeat,
      "SELECT invitation_approve($1, $2::text[], $3, $4, $5, $6, $7, $8) AS r",
      [
        campaign,
        over.channels ?? ["sms"],
        over.cap ?? 1000,
        over.at ?? new Date(),
        over.note ?? null,
        names.name_ar,
        names.name_en,
        randomUUID(),
      ],
    );
  };

  const startDue = () => one<string>(system, "SELECT invitation_start_due() AS r");
  const claimAt = (size = 5, at: Date = NOON, allowed: string[] = ["sms"]) =>
    f.owner<Claimed & QueryResultRow>("SELECT * FROM invitation_claim_at($1::text[], $2, $3)", [
      allowed,
      size,
      at,
    ]);
  const ack = (claimed: Pick<Claimed, "recipient_id" | "lease">, outcome: string, code = "") =>
    one<string>(system, "SELECT invitation_ack($1, $2, $3, $4) AS r", [
      claimed.recipient_id,
      claimed.lease,
      outcome,
      code === "" ? null : code,
    ]);
  const settle = () =>
    one<Record<string, number | boolean>>(system, "SELECT invitation_settle() AS r");
  const adminCancel = (campaign: string, note = "Stopped by Questify") =>
    one<{ state: string }>(adminSeat, "SELECT invitation_admin_cancel($1, $2, $3) AS r", [
      campaign,
      note,
      randomUUID(),
    ]);

  const campaignRow = async (campaign: string): Promise<CampaignRow> => {
    const [row] = await f.owner<CampaignRow & QueryResultRow>(
      "SELECT * FROM invitation_campaign WHERE id = $1",
      [campaign],
    );
    if (row === undefined) throw new Error(`No campaign ${campaign}.`);
    return row;
  };
  const recipients = (campaign: string) =>
    f.owner<RecipientRow & QueryResultRow>(
      "SELECT * FROM invitation_recipient WHERE campaign_id = $1 ORDER BY id",
      [campaign],
    );
  const statesOf = async (campaign: string): Promise<Record<string, number>> => {
    const counts: Record<string, number> = {};
    for (const row of await recipients(campaign)) counts[row.state] = (counts[row.state] ?? 0) + 1;
    return counts;
  };

  /**
   * A clean slate for a test that starts or claims: no campaign or channel hold left by an earlier test (the fill takes
   * the oldest due campaign and the claim any sending one), and no player opted in.
   */
  const reset = async () => {
    await f.owner("DELETE FROM invitation_campaign");
    await f.owner("DELETE FROM invitation_channel_hold");
    await isolate();
  };

  /** A started campaign over `players` new opted-in players (after a reset): the event, the campaign and its ids. */
  const launch = async (players = 50, options: PoolOptions & Readonly<{ cap?: number }> = {}) => {
    await reset();
    const ids = await optedIn(players, options);
    const event = await eligibleEvent();
    const campaign = (await request(event)).id;
    await approve(campaign, options.cap === undefined ? {} : { cap: options.cap });
    const outcome = await startDue();
    return { event, campaign, players: ids, outcome };
  };

  /** Moves an event's end (and its start, so the end stays after it) relative to now. */
  const endEventIn = (event: string, interval: string) =>
    f.owner(
      `UPDATE event SET starts_at = least(starts_at, now() + $2::interval - interval '1 hour'),
                        ends_at = now() + $2::interval WHERE id = $1`,
      [event, interval],
    );

  return {
    ...f,
    admin,
    editor,
    ownerB,
    ownerSeat: owner,
    adminSeat,
    system,
    one,
    switchOn,
    isolate,
    reset,
    optedIn,
    eligibleEvent,
    request,
    eventNames,
    approve,
    startDue,
    claimAt,
    ack,
    settle,
    adminCancel,
    campaignRow,
    recipients,
    statesOf,
    launch,
    endEventIn,
  };
}

export type InvitationFixture = Awaited<ReturnType<typeof invitationFixture>>;
