import { HttpError } from "#src/http-error";

/** What a refusal mapper answered: the HTTP answer's parts, or "returned" when it threw nothing. */
export type Answer =
  | "returned"
  | Readonly<{
      status: number;
      code: string;
      message: string;
      details: unknown;
      denied: boolean;
    }>;

export const describeError = (error: HttpError): Answer => ({
  status: error.status,
  code: error.envelope.code,
  message: error.envelope.message.en,
  details: error.envelope.details,
  denied: error.denied,
});

/** Runs a mapper that throws its answer; anything but an HttpError is rethrown. */
export function answerOf(run: () => unknown): Answer {
  try {
    run();
  } catch (error) {
    if (error instanceof HttpError) {
      return describeError(error);
    }
    throw error;
  }
  return "returned";
}
