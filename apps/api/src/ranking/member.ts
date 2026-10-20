/** The largest ledger entry id (`bigint`), so every inverted version is a non-negative 19-digit number. */
const MAX_VERSION = 9_223_372_036_854_775_807n;
const DIGITS = 19;
const MEMBER = /^([0-9]{19}):([0-9a-f-]{36})$/;

/**
 * A ranking member in Redis (ADR-118): `{inverted version}:{enrollment id}`. Points are the sorted set's score; among
 * equal points Redis orders members by their bytes, so in a highest-first read the lowest version (the player who
 * reached those points first, FR-606) comes first. Versions are ledger entry ids, never larger than a `bigint`.
 *
 * @throws RangeError when the version is not a ledger id (negative or beyond `bigint`).
 */
export function memberOf(version: bigint, enrollmentId: string): string {
  if (version < 0n || version > MAX_VERSION) {
    throw new RangeError(`A ranking version must be a ledger id; got ${version}.`);
  }
  return `${(MAX_VERSION - version).toString().padStart(DIGITS, "0")}:${enrollmentId}`;
}

/** The enrollment and version a member stands for, or undefined for anything that is not one. */
export function parseMember(
  member: string,
): Readonly<{ version: bigint; enrollmentId: string }> | undefined {
  const match = MEMBER.exec(member);
  if (match?.[1] === undefined || match[2] === undefined) {
    return undefined;
  }
  return { version: MAX_VERSION - BigInt(match[1]), enrollmentId: match[2] };
}
