import type { FastifyReply } from "fastify";
import { apiError, type ApiErrorEnvelope, type LocalizedText } from "@questify/shared";

/** An error a route throws on purpose; the error handler returns it as the standard envelope. */
export class HttpError extends Error {
  readonly status: number;
  readonly envelope: ApiErrorEnvelope;
  /**
   * A refusal of access that answers like something else (a 404 that hides another tenant's door): logged as
   * `authz.denied` like a 403, while the caller sees only the envelope (ADR-703).
   */
  readonly denied: boolean;
  /** Why access was refused, for the `authz.denied` line only (never sent): such as `wrong_surface` (T-810d). */
  readonly reason: string | undefined;

  constructor(
    status: number,
    code: string,
    message: LocalizedText,
    details: Readonly<Record<string, unknown>> = {},
    options: Readonly<{ denied?: boolean; reason?: string }> = {},
  ) {
    super(`${code}: ${message.en}`);
    this.status = status;
    this.envelope = apiError(code, message, details);
    this.denied = options.denied ?? false;
    this.reason = options.reason;
  }
}

/** Sets `Retry-After` on a throttled answer: the seconds the caller should wait before asking again. */
export function waitThen(reply: FastifyReply, seconds: number): void {
  reply.header("retry-after", String(seconds));
}
