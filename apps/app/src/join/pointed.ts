import type { Language, LocalizedText } from "@questify/shared";
import type { JoinOutcome } from "#src/join/join-api.ts";

/**
 * The join field the card points at, with the API's words for it when the API refused it ("That name can't be used.
 * Enter another name.", ADR-817); null words when the app found it empty itself.
 */
export type Pointed = Readonly<{ field: string; problem: LocalizedText | null }>;

/** Where a refusal's words go: under the field the API named, else on the card's Problem line. */
export type Refusal = Readonly<{ pointed: Pointed | undefined; problem: LocalizedText | null }>;

/** The field the app found empty before sending, if any. */
export const pointAtMissing = (field: string | undefined): Pointed | undefined =>
  field === undefined ? undefined : { field, problem: null };

/** A refused join answer: its words at the field the API named, or on the Problem line when it named none. */
export const refusalOf = (outcome: Extract<JoinOutcome, { kind: "invalid_answers" }>): Refusal =>
  outcome.field === null
    ? { pointed: undefined, problem: outcome.problem }
    : { pointed: { field: outcome.field, problem: outcome.problem }, problem: null };

/** What the card says under a field: nothing when it is not the pointed one, the API's words, else `fallback`. */
export const pointedText = (
  pointed: Pointed | undefined,
  field: string,
  language: Language,
  fallback: string,
): string | undefined => {
  if (pointed?.field !== field) {
    return undefined;
  }
  return pointed.problem === null ? fallback : pointed.problem[language];
};

/** The route params that carry a refusal from sign-in to the card: its words, and the field it points at. */
export const refusalParams = (outcome: JoinOutcome): Readonly<Record<string, string>> => {
  if (outcome.kind !== "refused" && outcome.kind !== "invalid_answers") {
    return {};
  }
  const words =
    outcome.problem === null
      ? {}
      : { problemAr: outcome.problem.ar, problemEn: outcome.problem.en };
  return outcome.kind === "invalid_answers" && outcome.field !== null
    ? { ...words, problemField: outcome.field }
    : words;
};

/** The refusal the card opens with, read back from those params. */
export const refusalFromParams = (
  params: Readonly<{ problemAr?: string; problemEn?: string; problemField?: string }>,
): Refusal => {
  const problem =
    params.problemAr !== undefined && params.problemEn !== undefined
      ? { ar: params.problemAr, en: params.problemEn }
      : null;
  return params.problemField === undefined || params.problemField === ""
    ? { pointed: undefined, problem }
    : { pointed: { field: params.problemField, problem }, problem: null };
};
