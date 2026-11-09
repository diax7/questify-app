import type { HttpError } from "#src/http-error";

/** One answer per refusal kind of `R`, each taking its own kind's fields (and `A`, whatever else the mapper is given). */
export type RefusalTable<R extends Readonly<{ kind: string }>, A extends unknown[] = []> = {
  readonly [K in R["kind"]]: (result: Extract<R, { kind: K }>, ...rest: A) => HttpError;
};

/**
 * Turns a table of answers into the function that throws the one for a refusal's kind. The lookup is a Map, so a kind
 * that names an inherited property (`constructor`, `__proto__`) never matches. A kind outside the type is no refusal:
 * the function returns nothing, as the switch statements this replaces did.
 */
export function refusalThrower<R extends Readonly<{ kind: string }>, A extends unknown[] = []>(
  table: RefusalTable<R, A>,
): (result: R, ...rest: A) => never {
  const answers = new Map<string, (result: never, ...rest: A) => HttpError>(Object.entries(table));
  return (result, ...rest) => {
    const answer = answers.get(result.kind);
    if (answer === undefined) {
      return undefined as never;
    }
    throw answer(result as never, ...rest);
  };
}
