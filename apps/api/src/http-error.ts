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

  constructor(
    status: number,
    code: string,
    message: LocalizedText,
    details: Readonly<Record<string, unknown>> = {},
    options: Readonly<{ denied?: boolean }> = {},
  ) {
    super(`${code}: ${message.en}`);
    this.status = status;
    this.envelope = apiError(code, message, details);
    this.denied = options.denied ?? false;
  }
}
