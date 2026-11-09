import { formatEventTime, toInstant, toLocalInput, type Language } from "@questify/shared";
import type { Translate } from "#src/lib/language.ts";
import type { Results } from "#src/lib/prizes.ts";

export type ResultsStep = "confirm" | "reveal";

/** The deadline the owner picked, as an instant and in words; nothing while the field cannot be read. */
export function claimOf(local: string, timeZone: string, language: Language) {
  const at = local === "" ? null : toInstant(local, timeZone);
  return at === null || Number.isNaN(at.getTime())
    ? null
    : { at, shown: formatEventTime(at, timeZone, language) };
}

/** The deadline field's value: what the owner typed, else the default offered by the API, else empty. */
export const deadlineLocal = (
  typed: string | null,
  defaultClaimUntil: string | null,
  timeZone: string,
): string =>
  typed ?? (defaultClaimUntil === null ? "" : toLocalInput(new Date(defaultClaimUntil), timeZone));

/** The confirm sheet's words: the step's title and its action. */
export function stepWords(t: Translate, step: ResultsStep): { title: string; action: string } {
  return step === "confirm"
    ? { title: t("results.confirmTitle"), action: t("results.confirm") }
    : { title: t("results.revealTitle"), action: t("results.reveal") };
}

/** The confirm sheet's body: what confirming freezes (naming the flagged players), or the reveal's deadline. */
export function stepBody(
  t: Translate,
  step: ResultsStep,
  flagged: readonly string[],
  shownDeadline: string | undefined,
): string {
  if (step === "reveal") {
    return t("results.revealBody", { deadline: shownDeadline ?? "" });
  }
  return [
    t("results.confirmBody"),
    flagged.length === 0 ? "" : t("results.confirmFlagged", { names: flagged.join("، ") }),
  ]
    .filter((line) => line !== "")
    .join(" ");
}

/** The request a step sends, and what it says once done. */
export function stepRequest(
  t: Translate,
  step: ResultsStep,
  results: Pick<Results, "places">,
  claimAt: Date | undefined,
): { path: string; payload: object; said: string } {
  if (step === "confirm") {
    return {
      path: "/results/confirm",
      payload: { expected: results.places.map((p) => p.enrollmentId) },
      said: t("results.confirmed"),
    };
  }
  return {
    path: "/results/reveal",
    payload: { claimUntil: claimAt?.toISOString() ?? "" },
    said: t("results.revealed"),
  };
}
