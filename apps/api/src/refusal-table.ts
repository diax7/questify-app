import type { HttpError } from "#src/http-error";

/** One answer per refusal kind of `R`, each taking its own kind's fields (and `A`, whatever else the mapper is given). */
export type RefusalTable<R extends Readonly<{ kind: string }>, A extends unknown[] = []> = {
  readonly [K in R["kind"]]: (result: Extract<R, { kind: K }>, ...rest: A) => HttpError;
};

/**
 * Turns a table of answers into the function that throws the one for a refusal's kind. The lookup is a Map, so a kind
 * that names an inherited property (`constructor`, `__proto__`) never matches. A kind the table does not hold goes to
 * `otherwise`, the thrower of the refusals `O` that this one sits beside; with no `otherwise` it is no refusal and the
 * function returns nothing, as the switch statements this replaces did.
 */
export function refusalThrower<
  R extends Readonly<{ kind: string }>,
  A extends unknown[] = [],
  O extends Readonly<{ kind: string }> = never,
>(
  table: RefusalTable<R, A>,
  otherwise?: (result: O, ...rest: A) => never,
): (result: R | O, ...rest: A) => never {
  const answers = new Map<string, (result: never, ...rest: A) => HttpError>(Object.entries(table));
  return (result, ...rest) => {
    const answer = answers.get(result.kind);
    if (answer === undefined) {
      return otherwise === undefined ? (undefined as never) : otherwise(result as O, ...rest);
    }
    throw answer(result as never, ...rest);
  };
}
