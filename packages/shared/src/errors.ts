/** Text shown to people, always in both languages (NFR-011). */
export type LocalizedText = Readonly<{ ar: string; en: string }>;

/** The one error body every API route returns (docs/API.md, Conventions). */
export type ApiErrorEnvelope = Readonly<{
  code: string;
  message: LocalizedText;
  details: Readonly<Record<string, unknown>>;
}>;

const MACHINE_CODE = /^[a-z][a-z0-9_]*$/;

/**
 * Builds an error envelope.
 *
 * @throws RangeError when the code is not lower snake case or a language is empty.
 */
export function apiError(
  code: string,
  message: LocalizedText,
  details: Readonly<Record<string, unknown>> = {},
): ApiErrorEnvelope {
  if (!MACHINE_CODE.test(code)) {
    throw new RangeError(
      `Error code "${code}" must be lower snake case, for example "event_full".`,
    );
  }
  if (message.ar.trim() === "" || message.en.trim() === "") {
    throw new RangeError(`Error "${code}" needs a non-empty Arabic and English message.`);
  }
  return { code, message, details };
}
