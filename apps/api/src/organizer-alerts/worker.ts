import { ORGANIZER_ALERT_TYPES, type OrganizerAlertType } from "@questify/shared";
import type { Pool, PoolClient } from "pg";
import type { EmailSender } from "#src/auth/email/sender";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { organizerAlertEmail } from "#src/organizer-alerts/templates";

/** Rows claimed per round: at 8 seconds a send, a round stays inside the 60-second lease. */
const CLAIM_SIZE = 5;
/** At most this many rounds a run; the rest waits for the next run. */
const ROUNDS_PER_RUN = 10;
/** The whole attempt at one send; a send that takes longer is recorded as not known (it may still arrive). */
export const ALERT_SEND_DEADLINE_MS = 8000;
const REPEAT_CALLS = 5;
const FLAG_SCAN_LIMIT = 2000;
const JITTER = 0.2;

export type OrganizerAlertWorkerDeps = Readonly<{
  pool: Pool;
  /**
   * Where the mail goes. Without one (production until Saudi-region transport or the counsel-approved transfer
   * extension, ADR-360) nothing is sent: every queued row is skipped as `transport_off` and no address is read.
   */
  transport?: EmailSender;
  dashboardOrigin: string;
  intervalMs: number;
  log: (level: "info" | "error", fields: Record<string, unknown>) => void;
  /** Spreads several API instances apart; replaced in tests. */
  random?: () => number;
  /** The whole attempt at one send, in milliseconds; replaced in tests. */
  sendDeadlineMs?: number;
}>;

export type OrganizerAlertWorker = Readonly<{
  /** Stops the timer and waits for a run in progress. */
  stop: () => Promise<void>;
  /** One run now (for tests). */
  runOnce: () => Promise<OrganizerAlertTotals>;
}>;

export type OrganizerAlertTotals = Readonly<{ sent: number; uncertain: number; flags: number }>;

type Claimed = Readonly<{
  alert_id: string;
  lease: string;
  kind: string;
  organizer: string;
  event: string | null;
  address: string;
}>;

type Ack = Readonly<{
  id: string;
  lease: string;
  outcome: "sent" | "uncertain";
  code: string | null;
}>;

const codeOf = (error: unknown): unknown => (error as { code?: unknown } | undefined)?.code ?? null;
const isAlertType = (value: string): value is OrganizerAlertType =>
  (ORGANIZER_ALERT_TYPES as readonly string[]).includes(value);

const system = <T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> =>
  withConnection(pool, (client) => withRequestContext(client, {}, () => work(client)));

/** Settles the outbox (expired leases and rows, rows left while the transport is off, old finished rows). */
async function settleOutbox(pool: Pool, transportOn: boolean): Promise<void> {
  for (let call = 0; call < REPEAT_CALLS; call += 1) {
    const more = await system(pool, async (client) => {
      const { rows } = await client.query<{ r: { more: boolean } }>(
        "SELECT alert_settle($1) AS r",
        [transportOn],
      );
      return rows[0]?.r.more === true;
    });
    if (!more) return;
  }
}

/** Queues the alerts of flags raised lately (the scan, never a trigger in the completion); answers how many rows. */
const scanFlags = (pool: Pool): Promise<number> =>
  system(pool, async (client) => {
    const { rows } = await client.query<{ n: number }>("SELECT alert_scan_flags($1) AS n", [
      FLAG_SCAN_LIMIT,
    ]);
    return rows[0]?.n ?? 0;
  });

/** Hands out queued rows that pass the send-time checks of `alert_claim`, each with its lease and current address. */
const claimRows = (pool: Pool): Promise<Claimed[]> =>
  system(pool, async (client) => {
    const { rows } = await client.query<Claimed>("SELECT * FROM alert_claim($1)", [CLAIM_SIZE]);
    return rows;
  });

const ackRows = (pool: Pool, rows: readonly Ack[]): Promise<number> =>
  system(pool, async (client) => {
    const { rows: done } = await client.query<{ n: number }>(
      "SELECT alert_ack($1::bigint[], $2::uuid[], $3::text[], $4::text[]) AS n",
      [
        rows.map((row) => row.id),
        rows.map((row) => row.lease),
        rows.map((row) => row.outcome),
        rows.map((row) => row.code),
      ],
    );
    return done[0]?.n ?? 0;
  });

/** Rejects after `ms`; the timer never keeps the process alive. */
function deadline(ms: number): { late: Promise<never>; cancel: () => void } {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("send deadline")), ms);
    timer.unref();
  });
  return { late, cancel: () => clearTimeout(timer) };
}

/** One send: `sent` when the transport took it, else `uncertain` (a throw or a late answer may still have arrived). */
async function sendOne(
  deps: OrganizerAlertWorkerDeps,
  transport: EmailSender,
  row: Claimed,
): Promise<Ack> {
  const base = { id: row.alert_id, lease: row.lease };
  if (!isAlertType(row.kind)) return { ...base, outcome: "uncertain", code: "unknown_type" };
  const mail = organizerAlertEmail(row.kind, {
    origin: deps.dashboardOrigin,
    organizerId: row.organizer,
    eventId: row.event,
  });
  const limit = deadline(deps.sendDeadlineMs ?? ALERT_SEND_DEADLINE_MS);
  try {
    await Promise.race([transport.send({ to: row.address, ...mail }), limit.late]);
    return { ...base, outcome: "sent", code: null };
  } catch {
    return { ...base, outcome: "uncertain", code: "send_failed" };
  } finally {
    limit.cancel();
  }
}

/** Claims, sends and acknowledges in small rounds; stops early when the worker is stopped. */
async function sendRounds(
  deps: OrganizerAlertWorkerDeps,
  transport: EmailSender,
  stopped: () => boolean,
): Promise<{ sent: number; uncertain: number }> {
  let sent = 0;
  let uncertain = 0;
  for (let round = 0; round < ROUNDS_PER_RUN && !stopped(); round += 1) {
    const claimed = await claimRows(deps.pool);
    if (claimed.length === 0) break;
    const acks: Ack[] = [];
    for (const row of claimed) acks.push(await sendOne(deps, transport, row));
    await ackRows(deps.pool, acks);
    sent += acks.filter((one) => one.outcome === "sent").length;
    uncertain += acks.filter((one) => one.outcome === "uncertain").length;
  }
  return { sent, uncertain };
}

/**
 * The organizer alert worker (T-503, FR-1727, ADR-362, ADR-360's transfer rule): each run settles the outbox, scans for
 * new flags, and, only when a transport is given, claims queued rows and sends one email each. The database re-checks the
 * member, the account, the event limit and the switch when it hands a row over (`alert_claim`); the address is read then
 * and held in memory for that one send. A send that throws or runs past its deadline is recorded `uncertain` and never
 * sent again (the retry allowlist is empty). Logs carry counts and SQLSTATEs only, never an address or a text.
 */
export function startOrganizerAlertWorker(deps: OrganizerAlertWorkerDeps): OrganizerAlertWorker {
  const random = deps.random ?? Math.random;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<unknown> | undefined;
  let stopped = false;

  const run = async (): Promise<OrganizerAlertTotals> => {
    await settleOutbox(deps.pool, deps.transport !== undefined);
    const flags = await scanFlags(deps.pool);
    const totals =
      deps.transport === undefined
        ? { sent: 0, uncertain: 0 }
        : await sendRounds(deps, deps.transport, () => stopped);
    return { ...totals, flags };
  };

  const guarded = async (): Promise<void> => {
    try {
      const totals = await run();
      if (totals.sent + totals.uncertain > 0) {
        deps.log(totals.uncertain > 0 ? "error" : "info", {
          event: "organizer_alert.run",
          ...totals,
        });
      }
    } catch (error) {
      deps.log("error", { event: "organizer_alert.run_failed", code: codeOf(error) });
    }
  };

  const schedule = (): void => {
    const wait = Math.round(deps.intervalMs * (1 - JITTER + 2 * JITTER * random()));
    timer = setTimeout(() => {
      running = guarded().finally(() => {
        running = undefined;
        if (!stopped) schedule();
      });
    }, wait);
    timer.unref();
  };

  schedule();
  return {
    stop: async () => {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
    runOnce: run,
  };
}
