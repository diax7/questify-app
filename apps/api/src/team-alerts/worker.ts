import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { mailApplied, type Applied, type EmailChangeDeps } from "#src/auth/email-change";
import { EmailSendError } from "#src/auth/email/sender";
import { BUCKETS, countRecent, record } from "#src/auth/throttle";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import { readModerationAddresses } from "#src/console/moderation/addresses";
import { trackRun } from "#src/telemetry/runs";
import { teamAlertDigest, type AlertLine } from "#src/team-alerts/templates";

/** The team mail's own budget (ADR-494, plan review MAJOR 2), never the sign-in transport's `outboundMailPerDay`. */
export const TEAM_ALERT_BUDGET = {
  /** One digest at most in this many seconds. */
  spacingSeconds: 600,
  /** Digests at most a day; past it only the console badge shows the alerts. */
  perDay: 100,
} as const;
/** Rows one digest claims at most (the mail lists 20 and counts the rest). */
const CLAIM_SIZE = 50;
/** The whole attempt at one send; a send that takes longer is recorded `uncertain` (it may still arrive). */
export const TEAM_ALERT_DEADLINE_MS = 8000;
const JITTER = 0.2;
const BUDGET_KEY = createHash("sha256").update("questify.team_alert_mail").digest();

export type TeamAlertWorkerDeps = EmailChangeDeps &
  Readonly<{
    /** Where the digest goes while `moderation.alertEmail` is unset (`MAIL_FROM`). */
    mailFrom: string;
    intervalMs: number;
    log: (level: "info" | "error", fields: Record<string, unknown>) => void;
    random?: () => number;
    sendDeadlineMs?: number;
    now?: () => Date;
  }>;

export type TeamAlertTotals = Readonly<{
  applied: number;
  digest: "none" | "wait" | "capped" | "sent" | "failed" | "uncertain";
  lines: number;
}>;

type Claimed = Readonly<{ id: string; doc: AlertLine }>;
type Claim = Readonly<
  { kind: "wait" | "none" | "capped" } | { kind: "send"; lease: string; rows: Claimed[] }
>;

const system = <T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> =>
  withConnection(pool, (client) => withRequestContext(client, {}, () => work(client)));

const ack = (client: PoolClient, rows: readonly Claimed[], lease: string, outcome: string) =>
  client.query("SELECT team_alert_ack($1::bigint[], $2, $3)", [
    rows.map((row) => row.id),
    lease,
    outcome,
  ]);

/**
 * In one transaction under one lock (so two instances never send two digests): waits while a digest went out in the
 * last 10 minutes; claims the waiting rows; past 100 digests a day closes them `skipped`; else records one digest in
 * the budget and hands the rows over.
 */
const claim = (pool: Pool): Promise<Claim> =>
  system(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1::bigint)", [
      BUDGET_KEY.readBigInt64BE(0).toString(),
    ]);
    const recent = await countRecent(
      client,
      BUCKETS.teamAlertMail,
      BUDGET_KEY,
      TEAM_ALERT_BUDGET.spacingSeconds,
    );
    if (recent.count > 0) return { kind: "wait" };
    const lease = randomUUID();
    const { rows } = await client.query<Claimed>("SELECT * FROM team_alert_claim($1, $2)", [
      lease,
      CLAIM_SIZE,
    ]);
    if (rows.length === 0) return { kind: "none" };
    const today = await countRecent(client, BUCKETS.teamAlertMail, BUDGET_KEY, 86_400);
    if (today.count >= TEAM_ALERT_BUDGET.perDay) {
      await ack(client, rows, lease, "skipped");
      return { kind: "capped" };
    }
    await record(client, BUCKETS.teamAlertMail, BUDGET_KEY);
    return { kind: "send", lease, rows };
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

/** One digest: `sent`; `failed` when the transport refused (retried); `uncertain` on the deadline (never resent). */
async function sendDigest(
  deps: TeamAlertWorkerDeps,
  rows: readonly Claimed[],
): Promise<"sent" | "failed" | "uncertain"> {
  const addresses = await readModerationAddresses(deps.pool);
  const content = teamAlertDigest(
    rows.map((row) => row.doc),
    { origin: deps.dashboardOrigin, now: deps.now?.() ?? new Date() },
  );
  const limit = deadline(deps.sendDeadlineMs ?? TEAM_ALERT_DEADLINE_MS);
  try {
    await Promise.race([
      deps.email.send({ to: addresses.alertEmail ?? deps.mailFrom, ...content }),
      limit.late,
    ]);
    return "sent";
  } catch (error) {
    return error instanceof EmailSendError ? "failed" : "uncertain";
  } finally {
    limit.cancel();
  }
}

/**
 * Applies the held email changes whose 24 hours passed and mails their notices; answers how many it handled. A change
 * with no recorded notice closed instead (ADR-815): it is logged and nothing is mailed.
 */
async function applyDue(deps: TeamAlertWorkerDeps): Promise<number> {
  const applied = await system(deps.pool, async (client) => {
    const { rows } = await client.query<{ r: Applied }>("SELECT owner_email_apply_due(50) AS r");
    return rows.map((row) => row.r);
  });
  for (const one of applied) {
    if (one.outcome === "confirmed") {
      await mailApplied(deps, one, (event, fields) => deps.log("error", { event, ...fields }));
    } else if (one.outcome === "send_failed") {
      deps.log("error", { event: "team_alert.hold_unsent", change: one.changeId ?? "" });
    }
  }
  return applied.length;
}

/** One run: due email changes, then at most one digest. */
async function runOnce(deps: TeamAlertWorkerDeps): Promise<TeamAlertTotals> {
  const applied = await applyDue(deps);
  const claimed = await claim(deps.pool);
  if (claimed.kind !== "send") return { applied, digest: claimed.kind, lines: 0 };
  const outcome = await sendDigest(deps, claimed.rows);
  await system(deps.pool, (client) => ack(client, claimed.rows, claimed.lease, outcome));
  return { applied, digest: outcome, lines: claimed.rows.length };
}

/** Logs a run that did something; a digest not sent as planned is an error. */
function logTotals(deps: TeamAlertWorkerDeps, totals: TeamAlertTotals): void {
  const quiet = totals.applied === 0 && totals.lines === 0 && totals.digest !== "capped";
  if (quiet) return;
  const fine = totals.digest === "sent" || totals.digest === "none" || totals.digest === "wait";
  deps.log(fine ? "info" : "error", { event: "team_alert.run", ...totals });
}

export type TeamAlertWorker = Readonly<{
  stop: () => Promise<void>;
  runOnce: () => Promise<TeamAlertTotals>;
}>;

/**
 * The team alert worker (T-701b, FR-1732, FR-1784, ADR-494): each run applies the held owner email changes that are
 * due, then sends at most one digest of the queued alerts to `moderation.alertEmail` (else `MAIL_FROM`) through the
 * sign-in transport: one per 10 minutes, 100 a day on its own budget. Logs carry counts and outcomes only.
 */
export function startTeamAlertWorker(deps: TeamAlertWorkerDeps): TeamAlertWorker {
  const random = deps.random ?? Math.random;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<unknown> | undefined;
  let stopped = false;

  const guarded = async (): Promise<void> => {
    try {
      logTotals(deps, await runOnce(deps));
    } catch (error) {
      deps.log("error", {
        event: "team_alert.run_failed",
        code: (error as { code?: unknown } | undefined)?.code ?? null,
      });
    }
  };

  const schedule = (): void => {
    const wait = Math.round(deps.intervalMs * (1 - JITTER + 2 * JITTER * random()));
    timer = setTimeout(() => {
      running = trackRun("team_alerts", guarded).finally(() => {
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
    runOnce: () => runOnce(deps),
  };
}
