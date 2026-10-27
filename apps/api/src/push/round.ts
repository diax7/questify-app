import type { PushTexts } from "@questify/shared";
import type { AckRow, PushDoors } from "#src/push/doors";
import { pushMessageOf, type ClaimedSend } from "#src/push/message";
import type { PushProvider, PushTarget } from "#src/push/provider";
import { sendRow, type Attempted, type PushClock, type SendContext } from "#src/push/send";
import type { TargetState } from "#src/push/targets";

/** The most rows one claim leases (push_claim caps it too). */
export const ROUND_SIZE = 200;
/** The most sends in flight per target; each wave is acknowledged as it ends. */
export const WAVE_SIZE = 50;
/** The claim's lease (push_claim) and the margin the worker keeps before it. */
export const LEASE_MS = 60_000;
export const LEASE_MARGIN_MS = 2000;
/** The mass-invalid guard (plan § Review 4): at least this many answers in a round from one target... */
export const GUARD_MIN_ANSWERS = 20;
/** ...of which more than half ambiguous holds that target this long and invalidates none of them. */
export const GUARD_HOLD_MS = 15 * 60_000;

export type PushLog = (level: "info" | "warn" | "error", fields: Record<string, unknown>) => void;

export type RoundDeps = Readonly<{
  doors: PushDoors;
  providers: ReadonlyMap<PushTarget, PushProvider>;
  targets: TargetState;
  clock: PushClock;
  log: PushLog;
  /** True once the worker is stopping: the wave in flight ends, the rest of the round is requeued. */
  stopped: () => boolean;
  /** The templates and texts; the shipped ones unless a test gives its own. */
  texts?: PushTexts;
}>;

const codeOf = (error: unknown): unknown => (error as { code?: unknown } | undefined)?.code ?? null;

const ackRow = (claim: ClaimedSend, attempted: Attempted): AckRow => ({
  id: claim.send_id,
  lease: claim.lease,
  outcome: attempted.outcome,
  code: attempted.code,
  attempts: attempted.attempts,
});

const untried = (claim: ClaimedSend, code: string): AckRow => ({
  id: claim.send_id,
  lease: claim.lease,
  outcome: "requeue",
  code,
  attempts: claim.attempts,
});

/** One bulk acknowledgement; a failure is logged and the leases expire to `unknown` (never sent twice). */
async function acknowledge(deps: RoundDeps, rows: readonly AckRow[]): Promise<void> {
  if (rows.length === 0) return;
  try {
    await deps.doors.ack(rows);
  } catch (error) {
    deps.log("error", { event: "push.ack_failed", code: codeOf(error), rows: rows.length });
  }
}

/** Sends one wave of one target's rows together; a kind with no template fails untried (never pushed). */
async function sendWave(
  deps: RoundDeps,
  context: SendContext,
  provider: PushProvider,
  wave: readonly ClaimedSend[],
): Promise<Array<Readonly<{ claim: ClaimedSend; attempted: Attempted }>>> {
  return Promise.all(
    wave.map(async (claim) => {
      const message = pushMessageOf(claim, deps.texts);
      const attempted: Attempted =
        message === null
          ? {
              outcome: "failed",
              code: "no_template",
              attempts: claim.attempts,
              answered: false,
              ambiguous: false,
            }
          : await sendRow(context, provider, message, claim.attempts);
      return { claim, attempted };
    }),
  );
}

/**
 * One target's rows in waves of 50, each acknowledged as it ends; a wave that cannot start (the target held, the worker
 * stopping) is requeued untried. Ambiguous invalid-token answers wait for the round's end: when 20 or more answers came
 * from the target and more than half were ambiguous, the target is held and those rows are requeued, none invalidated
 * (plan § Review 4); below that each invalidates its device.
 */
async function sendTarget(
  deps: RoundDeps,
  context: SendContext,
  provider: PushProvider,
  rows: readonly ClaimedSend[],
): Promise<void> {
  const deferred: AckRow[] = [];
  let answers = 0;
  for (let start = 0; start < rows.length; start += WAVE_SIZE) {
    const wave = rows.slice(start, start + WAVE_SIZE);
    if (deps.stopped() || deps.targets.held(provider.target)) {
      await acknowledge(
        deps,
        wave.map((claim) => untried(claim, deps.stopped() ? "stopping" : "hold")),
      );
      continue;
    }
    const results = await sendWave(deps, context, provider, wave);
    answers += results.filter((one) => one.attempted.answered).length;
    const ambiguous = results.filter((one) => one.attempted.ambiguous);
    deferred.push(...ambiguous.map((one) => ackRow(one.claim, one.attempted)));
    await acknowledge(
      deps,
      results
        .filter((one) => !one.attempted.ambiguous)
        .map((one) => ackRow(one.claim, one.attempted)),
    );
  }
  const mass = answers >= GUARD_MIN_ANSWERS && deferred.length * 2 > answers;
  if (mass) {
    deps.targets.hold(provider.target, GUARD_HOLD_MS, "mass_invalid");
    deps.log("error", { event: "push.mass_invalid", target: provider.target });
  }
  await acknowledge(
    deps,
    deferred.map((row) =>
      mass ? { ...row, outcome: "requeue" as const, code: "mass_invalid" } : row,
    ),
  );
}

/**
 * One claim round (ADR-345): the deadline is read on the monotonic clock before the claim (its moment plus the lease
 * minus 2 s), so no attempt can outlive `lease_until` whatever the database's clock says; up to 200 rows for the
 * targets with a provider and no hold; each target's rows go in waves in parallel with the other targets'. Answers how
 * many rows were claimed.
 */
export async function runRound(deps: RoundDeps): Promise<number> {
  const targets = deps.targets.available([...deps.providers.keys()]);
  if (targets.length === 0) return 0;
  const deadline = deps.clock.now() + LEASE_MS - LEASE_MARGIN_MS;
  const claimed = await deps.doors.claim(targets, ROUND_SIZE);
  const context: SendContext = { clock: deps.clock, targets: deps.targets, deadline };
  await Promise.all(
    targets.map((target) => {
      const provider = deps.providers.get(target);
      const rows = claimed.filter((claim) => claim.target === target);
      return provider === undefined || rows.length === 0
        ? acknowledge(
            deps,
            rows.map((claim) => untried(claim, "no_provider")),
          )
        : sendTarget(deps, context, provider, rows);
    }),
  );
  return claimed.length;
}
