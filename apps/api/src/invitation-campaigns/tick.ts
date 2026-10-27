import type { Pool, PoolClient } from "pg";
import type { AuthKeys } from "#src/auth/keys";
import { withConnection } from "#src/db/connection";
import { withRequestContext } from "#src/db/context";
import {
  invitationToken,
  invitationUrl,
  renderInvitation,
} from "#src/invitation-campaigns/message";
import { invitationSmsClaimable } from "#src/invitation-campaigns/quiet-hours";
import { invitationOutcome, type InvitationOutcome } from "#src/invitation-campaigns/sender";
import { optOutUrl } from "#src/marketing/opt-out";
import type { SmsSender } from "#src/players/sms";
import type { SettingsService } from "#src/settings/service";

/** How long one tick sends before it leaves the rest to the next (ADR-333 (1)). */
export const INVITATION_BUDGET_MS = 3000;
/** One round: the send concurrency and the most the claim leases at once. */
export const INVITATION_ROUND = 5;
/** Settle runs this often, with the switch on or off. */
export const INVITATION_SETTLE_MS = 10 * 60 * 1000;
/** At most this many settle calls a tick while one reports `more`. */
const SETTLE_CALLS = 5;
/** The fill's own statement limit (the API's is 5 s, pool-options.ts). */
export const FILL_TIMEOUT = "60s";
/** Each wait is the interval, give or take a fifth, so instances started together drift apart. */
const JITTER = 0.2;

export type InvitationTickDeps = Readonly<{
  pool: Pool;
  settings: Pick<SettingsService, "forEvent">;
  /** The promotional Msegat sender; without it no SMS is ever claimed. */
  promoSms?: SmsSender;
  keys: Pick<AuthKeys, "optOutTag">;
  intervalMs: number;
  log: (level: "info" | "error", fields: Record<string, unknown>) => void;
  /** Spreads several API instances apart; replaced in tests. */
  random?: () => number;
  /** The clock for the budget, the quiet hours and settle; replaced in tests. */
  now?: () => number;
}>;

type Claim = Readonly<{
  recipient_id: string;
  lease: string;
  channel: "sms";
  language: "ar" | "en";
  phone: string;
  player_id: string;
  link: string;
  name_ar: string | null;
  name_en: string | null;
}>;

const codeOf = (error: unknown): unknown => (error as { code?: unknown } | undefined)?.code ?? null;

const system = <T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> =>
  withConnection(pool, (client) => withRequestContext(client, {}, () => work(client)));

/** Whether the platform switch is on (off when absent, ADR-330 (7)); the database checks it again in every door. */
async function switchedOn(deps: InvitationTickDeps): Promise<boolean> {
  const config = await deps.settings.forEvent(undefined);
  return config.kind === "ok" && config.config.features["invitationCampaigns"]?.enabled === true;
}

/** The text exactly as sent: the claim's copied names, the landing link and the signed opt-out link. */
export function messageOf(deps: Pick<InvitationTickDeps, "keys">, claim: Claim): string {
  return renderInvitation({
    language: claim.language,
    names: { ar: claim.name_ar, en: claim.name_en },
    link: invitationUrl(claim.language, invitationToken(claim.link)),
    optOut: optOutUrl(
      deps.keys,
      { playerId: claim.player_id, channel: claim.channel },
      claim.language,
    ),
  });
}

/** Sends one claimed message and acknowledges it; contact and text never reach a log. */
async function sendOne(
  deps: InvitationTickDeps,
  sender: SmsSender,
  claim: Claim,
): Promise<InvitationOutcome["outcome"]> {
  let result: InvitationOutcome;
  try {
    result = invitationOutcome(
      await sender.send({ to: claim.phone, text: messageOf(deps, claim) }),
    );
  } catch {
    // The sender answers every failure itself; one that throws may still have reached Msegat.
    result = { outcome: "unknown", code: "sender_error" };
  }
  if (result.outcome === "hold") {
    deps.log("error", {
      event: "invitation.channel_hold",
      channel: claim.channel,
      code: result.code,
    });
  }
  try {
    await system(deps.pool, (client) =>
      client.query("SELECT invitation_ack($1, $2, $3, $4)", [
        claim.recipient_id,
        claim.lease,
        result.outcome,
        result.code,
      ]),
    );
  } catch (error) {
    // The lease expires within a minute and settle records the message as unknown: never sent twice.
    deps.log("error", { event: "invitation.ack_failed", code: codeOf(error) });
  }
  return result.outcome;
}

/** Rounds of at most 5 while the budget lasts: claim, send them together, acknowledge each as it returns. */
async function sendRounds(
  deps: InvitationTickDeps,
  sender: SmsSender,
  started: number,
): Promise<void> {
  const now = deps.now ?? Date.now;
  while (now() - started < INVITATION_BUDGET_MS) {
    if (!invitationSmsClaimable(new Date(now()))) return;
    const claims = await system(deps.pool, async (client) => {
      const { rows } = await client.query<Claim>("SELECT * FROM invitation_claim($1, $2)", [
        ["sms"],
        INVITATION_ROUND,
      ]);
      return rows;
    });
    if (claims.length === 0) return;
    const outcomes = await Promise.all(claims.map((claim) => sendOne(deps, sender, claim)));
    // An account refusal holds the channel: no further round until the hold ends (ADR-333 (3)).
    if (outcomes.includes("hold")) return;
  }
}

/** Starts at most one due campaign, then sends; only while the switch is on and a promotional sender exists. */
async function send(deps: InvitationTickDeps, started: number): Promise<void> {
  if (!(await switchedOn(deps))) return;
  const outcome = await system(deps.pool, async (client) => {
    // A fill of 100,000 players takes seconds (ADR-334 (4)): it gets its own limit, not the API's 5 s, so a slow
    // database never kills it half-way and retries it every tick.
    await client.query(`SET LOCAL statement_timeout = '${FILL_TIMEOUT}'`);
    const { rows } = await client.query<{ outcome: string }>(
      "SELECT invitation_start_due() AS outcome",
    );
    return rows[0]?.outcome;
  });
  if (outcome !== undefined && !["off", "busy", "idle"].includes(outcome)) {
    deps.log("info", { event: "invitation.start", outcome });
  }
  // Without the promotional sender nothing is claimed: SMS is v1's only channel (ADR-331 (1)).
  if (deps.promoSms === undefined) return;
  await sendRounds(deps, deps.promoSms, started);
}

/** Settle until it reports nothing more to do, at most a few calls a tick. */
async function settle(deps: InvitationTickDeps): Promise<void> {
  for (let call = 0; call < SETTLE_CALLS; call += 1) {
    const summary = await system(deps.pool, async (client) => {
      const { rows } = await client.query<{ summary: Record<string, unknown> }>(
        "SELECT invitation_settle() AS summary",
      );
      return rows[0]?.summary;
    });
    if (summary === undefined || summary["more"] !== true) return;
  }
}

export type InvitationTick = Readonly<{ stop: () => Promise<void> }>;

/**
 * The invitation tick (ADR-333): every interval, settle when 10 minutes have passed since the last one (switch on or
 * off), then, while the switch is on, start one due campaign and send rounds of 5 for up to 3 s. Logs carry events,
 * outcomes and SQLSTATEs only, never a phone, a text or a player. A failure is logged and the next run tries again.
 */
export function startInvitationTick(deps: InvitationTickDeps): InvitationTick {
  const random = deps.random ?? Math.random;
  const now = deps.now ?? Date.now;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;
  let settledAt = Number.NEGATIVE_INFINITY;

  const step = async (failed: string, work: () => Promise<void>): Promise<void> => {
    try {
      await work();
    } catch (error) {
      deps.log("error", { event: failed, code: codeOf(error) });
    }
  };

  const run = async (): Promise<void> => {
    const started = now();
    if (started - settledAt >= INVITATION_SETTLE_MS) {
      settledAt = started;
      await step("invitation.settle_failed", () => settle(deps));
    }
    await step("invitation.send_failed", () => send(deps, started));
  };

  const schedule = (): void => {
    const wait = Math.round(deps.intervalMs * (1 - JITTER + 2 * JITTER * random()));
    timer = setTimeout(() => {
      running = run().finally(() => {
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
  };
}
