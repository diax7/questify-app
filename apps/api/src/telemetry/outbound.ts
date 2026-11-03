import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { EmailSender } from "#src/auth/email/sender";
import type { SmsSender } from "#src/players/sms";
import type { PushProvider } from "#src/push/provider";
import { safeAttributes, type Operation } from "#src/telemetry/attributes";
import { instruments, SCOPE } from "#src/telemetry/instruments";

/**
 * Runs one call to an outside provider as a span, a duration and an outcome count. `outcomeOf` names what became of a
 * call that answered; a call that throws is `failed` and still throws. Provider and outcome are names from the code
 * (`msegat`, `fcm`, `sent`, `refused`), never an address, a token or a message.
 */
async function observed<T>(
  operation: Operation,
  provider: string,
  call: () => Promise<T>,
  outcomeOf: (result: T) => string,
): Promise<T> {
  const started = performance.now();
  const span = trace.getTracer(SCOPE).startSpan(`${operation} ${provider}`, {
    kind: SpanKind.CLIENT,
    attributes: safeAttributes({ "questify.operation": operation, "questify.provider": provider }),
  });
  let outcome = "failed";
  try {
    const result = await call();
    outcome = outcomeOf(result);
    return result;
  } catch (error) {
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw error;
  } finally {
    const attributes = safeAttributes({
      "questify.operation": operation,
      "questify.provider": provider,
      "questify.outcome": outcome,
    });
    span.setAttributes(safeAttributes({ "questify.outcome": outcome }));
    span.end();
    instruments().outboundRequests.add(1, attributes);
    instruments().outboundDuration.record((performance.now() - started) / 1000, attributes);
  }
}

/** An SMS gateway whose every message is counted by outcome (`sent`, `unknown`, `refused`). */
export function instrumentSms(sender: SmsSender, provider: string): SmsSender {
  return {
    ...sender,
    send: (message) =>
      observed(
        "sms",
        provider,
        () => sender.send(message),
        (result) => result.kind,
      ),
  };
}

/** An email sender whose every message is counted as `sent` or `failed`. */
export function instrumentEmail(sender: EmailSender, provider: string): EmailSender {
  return {
    ...sender,
    send: (message) =>
      observed(
        "email",
        provider,
        () => sender.send(message),
        () => "sent",
      ),
  };
}

/** A push provider whose every send is counted by what it came to (`sent`, `unknown`, `requeue`, `failed`, ...). */
export function instrumentPush(provider: PushProvider): PushProvider {
  return {
    ...provider,
    send: (message, deadline) =>
      observed(
        "push",
        provider.target,
        () => provider.send(message, deadline),
        (result) => result.kind,
      ),
  };
}
