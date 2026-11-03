import { context, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { safeAttributes, type Tick } from "#src/telemetry/attributes";
import { gaugeSources, instruments, SCOPE } from "#src/telemetry/instruments";

/** Notes that a loop is alive: it finished a run now. The stalled-loop alerts read the age of this. */
export function markRun(tick: Tick, now: number = Date.now()): void {
  gaugeSources.lastRuns.set(tick, now);
}

/**
 * Runs one pass of a background loop as its own trace, with its duration and outcome counted and its last-run time
 * noted. A pass that throws is counted `failed` and still throws, so the loop's own error handling is unchanged. The
 * loops log their step failures themselves (`community.settle_failed` and the like); those lines are counted by
 * `countLogEvent`, so a pass that "succeeds" with a failed step still shows.
 */
export async function trackRun(tick: Tick, run: () => Promise<unknown>): Promise<void> {
  const started = performance.now();
  const span = trace.getTracer(SCOPE).startSpan(`tick ${tick}`, {
    kind: SpanKind.INTERNAL,
    root: true,
    attributes: safeAttributes({ "questify.tick": tick }),
  });
  let outcome = "ok";
  try {
    await context.with(trace.setSpan(ROOT_CONTEXT, span), run);
  } catch (error) {
    outcome = "failed";
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw error;
  } finally {
    span.end();
    const attributes = safeAttributes({ "questify.tick": tick, "questify.outcome": outcome });
    instruments().tickRuns.add(1, attributes);
    instruments().tickDuration.record((performance.now() - started) / 1000, attributes);
    markRun(tick);
  }
}
