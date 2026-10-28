import type { PushTexts } from "@questify/shared";
import type { FanOutResult, PushDoors } from "#src/push/doors";
import type { PushProvider, PushTarget } from "#src/push/provider";
import { runRound, type PushLog } from "#src/push/round";
import { SYSTEM_CLOCK, type PushClock } from "#src/push/send";
import { createTargetState } from "#src/push/targets";
import type { SettingsService } from "#src/settings/service";

/** The worker sleeps this long (give or take a fifth) when there is nothing to fan out or send. */
export const PUSH_IDLE_MS = 1000;
/** Settle runs this often, with the switch on or off. */
export const PUSH_SETTLE_MS = 10 * 60_000;
/** At most this many settle calls in a row while one reports `more`. */
const SETTLE_CALLS = 5;
const JITTER = 0.2;

export type PushWorkerDeps = Readonly<{
  doors: PushDoors;
  providers: readonly PushProvider[];
  settings: Pick<SettingsService, "forEvent">;
  log: PushLog;
  /** In production a platform without a provider is logged once at start (`push.provider_missing`). */
  production: boolean;
  clock?: PushClock;
  random?: () => number;
  /** The templates and texts; the shipped ones unless a test gives its own. */
  texts?: PushTexts;
}>;

export type PushWorker = Readonly<{ stop: () => Promise<void> }>;

const codeOf = (error: unknown): unknown => (error as { code?: unknown } | undefined)?.code ?? null;

/** The platforms with no provider at all: iOS needs an APNs target, Android FCM. */
export function missingPlatforms(providers: readonly PushProvider[]): Array<"ios" | "android"> {
  const has = (wanted: (target: PushTarget) => boolean) =>
    providers.some((provider) => wanted(provider.target));
  return [
    ...(has((target) => target.startsWith("apns:")) ? [] : (["ios"] as const)),
    ...(has((target) => target === "fcm") ? [] : (["android"] as const)),
  ];
}

/**
 * Logs a failed event batch (the database undid it and counted it): `push.fan_out_batch_failed`, and the alert
 * `push.notice_parked` once its third failure in a row parks the notice. Ids and SQLSTATEs only.
 */
function reportFanOut(log: PushLog, fanned: FanOutResult | undefined): void {
  if (fanned?.failed === undefined) return;
  const fields = { notice: fanned.failed, code: fanned.code ?? null };
  log("error", {
    event: fanned.parked === true ? "push.notice_parked" : "push.fan_out_batch_failed",
    ...fields,
  });
}

/** The platform switch (`features.pushNotifications`, on unless switched off); the claim checks it again. */
async function switchedOn(deps: PushWorkerDeps): Promise<boolean> {
  const config = await deps.settings.forEvent(undefined);
  return config.kind === "ok" && config.config.features["pushNotifications"]?.enabled !== false;
}

/**
 * The push worker (ADR-345): an in-process loop on its own small pool. While work exists it fans out (personal notices
 * first) and runs a claim round; idle, it sleeps about a second. Settle runs every 10 minutes, switch on or off; with
 * the switch off nothing is claimed, while the fan-out keeps writing the center. A failed step is logged (event and
 * SQLSTATE only, never a token, a text or a player) and the loop goes on after a pause. `stop()` lets the wave in
 * flight end, requeues the rest of the round and waits.
 */
export function startPushWorker(deps: PushWorkerDeps): PushWorker {
  const clock = deps.clock ?? SYSTEM_CLOCK;
  const random = deps.random ?? Math.random;
  const providers = new Map(deps.providers.map((provider) => [provider.target, provider] as const));
  const targets = createTargetState(clock.now, (fields) => deps.log("error", fields));
  const sleeping = new AbortController();
  let stopped = false;
  let settledAt = Number.NEGATIVE_INFINITY;
  if (deps.production) {
    for (const platform of missingPlatforms(deps.providers)) {
      deps.log("warn", { event: "push.provider_missing", platform });
    }
  }

  const step = async <T>(failed: string, work: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await work();
    } catch (error) {
      deps.log("error", { event: failed, code: codeOf(error) });
      return undefined;
    }
  };

  const settle = async (): Promise<void> => {
    for (let call = 0; call < SETTLE_CALLS; call += 1) {
      const summary = await deps.doors.settle();
      if (summary["more"] !== true) return;
    }
  };

  const round = async (): Promise<number> =>
    (await switchedOn(deps))
      ? runRound({
          doors: deps.doors,
          providers,
          targets,
          clock,
          log: deps.log,
          stopped: () => stopped,
          ...(deps.texts === undefined ? {} : { texts: deps.texts }),
        })
      : 0;

  const once = async (): Promise<void> => {
    if (clock.wallNow() - settledAt >= PUSH_SETTLE_MS) {
      settledAt = clock.wallNow();
      await step("push.settle_failed", settle);
    }
    const fanned = await step("push.fan_out_failed", deps.doors.fanOut);
    reportFanOut(deps.log, fanned);
    const sent = await step("push.round_failed", round);
    if (fanned?.more !== true && (sent ?? 0) === 0 && !stopped) {
      await clock.wait(
        Math.round(PUSH_IDLE_MS * (1 - JITTER + 2 * JITTER * random())),
        sleeping.signal,
      );
    }
  };

  const running = (async () => {
    for (;;) {
      if (stopped) return;
      await once();
    }
  })();

  return {
    stop: async () => {
      stopped = true;
      sleeping.abort();
      await running;
      await Promise.all(deps.providers.map((provider) => provider.close()));
    },
  };
}
