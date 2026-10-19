import { apiError, type ApiErrorEnvelope, type LocalizedText } from "@questify/shared";

/** An error a route throws on purpose; the error handler returns it as the standard envelope. */
export class HttpError extends Error {
  readonly status: number;
  readonly envelope: ApiErrorEnvelope;

  constructor(
    status: number,
    code: string,
    message: LocalizedText,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(`${code}: ${message.en}`);
    this.status = status;
    this.envelope = apiError(code, message, details);
  }
}
