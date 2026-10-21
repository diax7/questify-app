/**
 * The one row a database function always returns (a definer's single answer).
 *
 * @throws Error naming the function when it returned none: a broken migration, never a caller's mistake.
 */
export function onlyRow<T>(rows: readonly T[], name: string): T {
  const [row] = rows;
  // Stryker disable next-line ConditionalExpression,BlockStatement,StringLiteral: unreachable: these functions return exactly one row
  if (row === undefined) {
    throw new Error(`${name} returned no row.`);
  }
  return row;
}
