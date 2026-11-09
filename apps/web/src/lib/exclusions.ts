/** One exclusion-list entry: a phone (masked by the API) or an email domain. */
export type Exclusion = Readonly<{ id: string; kind: "phone" | "email_domain"; value: string }>;

/** The list with a new entry first; an entry of the same id is replaced, not repeated. */
export function withExclusionAdded(
  current: readonly Exclusion[] | null,
  added: Exclusion,
): Exclusion[] {
  return [added, ...(current ?? []).filter((entry) => entry.id !== added.id)];
}

/** The list without the entry of that id. */
export function withoutExclusion(current: readonly Exclusion[] | null, id: string): Exclusion[] {
  return (current ?? []).filter((row) => row.id !== id);
}
