import { trace } from "@opentelemetry/api";
import { safeAttributes } from "#src/telemetry/attributes";
import { instruments } from "#src/telemetry/instruments";

/** pino's numeric levels at or above `info`. */
const LEVEL_NAMES: ReadonlyMap<number, "info" | "warn" | "error"> = new Map([
  [30, "info"],
  [40, "warn"],
  [50, "error"],
  [60, "error"],
]);

/**
 * Counts one log line that names an event. The event name is the only label: it is a constant written in the code
 * (`community.settle_failed`). A line whose `event` is missing or not shaped like one is not counted, so a stray string
 * can never become a label.
 */
export function countLogEvent(event: unknown, level: "info" | "warn" | "error"): void {
  if (typeof event !== "string") return;
  const attributes = safeAttributes({ "questify.event": event, "questify.log.level": level });
  if (attributes["questify.event"] === undefined) return;
  instruments().logEvents.add(1, attributes);
}

/** What each log line carries: the ids of the span it was written in, when there is one. */
function traceFields(): Record<string, string> {
  const span = trace.getActiveSpan()?.spanContext();
  return span === undefined ? {} : { trace_id: span.traceId, span_id: span.spanId };
}

type LogMethod = (this: unknown, ...args: unknown[]) => void;

/**
 * The pieces of the server's pino options that connect logs to telemetry (ADR-602): the trace and span ids on every line
 * written inside a request or a background run, and a count of every line that names an event, which is what turns the
 * existing log events into alert signals. Neither reads any other field of a line.
 */
export function logTelemetry(): {
  mixin: () => Record<string, string>;
  hooks: {
    logMethod: (this: unknown, args: unknown[], method: LogMethod, level: number) => void;
  };
} {
  return {
    mixin: traceFields,
    hooks: {
      logMethod(args, method, level) {
        const name = LEVEL_NAMES.get(level);
        const first = args[0];
        if (name !== undefined && typeof first === "object" && first !== null) {
          countLogEvent((first as { event?: unknown }).event, name);
        }
        method.apply(this, args);
      },
    },
  };
}
