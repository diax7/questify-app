/** A number input's change: the new number, or null for an emptied field (it keeps its last value). */
export function numberFieldPatch<Key extends string>(
  key: Key,
  raw: string,
): Record<Key, number> | null {
  return raw === "" ? null : ({ [key]: Number(raw) } as Record<Key, number>);
}
