type Text = Readonly<{ ar: string | null; en: string | null }>;

/**
 * What a player is told about a community lock (T-306c, ADR-228; migration 0054's `community_lock_note`): the goal
 * and its numbers, never the target. `scheduled` until the goal starts (`startsAt`), `waiting` while it runs, `missed`
 * when the goal ended without reaching the step (the item stays locked).
 */
export type CommunityLock = Readonly<{
  goalId: string;
  title: Text;
  measure: "points" | "completions" | "players";
  threshold: number;
  state: "scheduled" | "waiting" | "missed";
  startsAt: string;
}>;

const textOf = (value: unknown): Text => {
  const both = (value ?? {}) as { ar?: unknown; en?: unknown };
  return {
    ar: typeof both.ar === "string" ? both.ar : null,
    en: typeof both.en === "string" ? both.en : null,
  };
};

/** The note as the database wrote it (jsonb), or null when nothing is locked. */
export function lockNoteOf(value: unknown): CommunityLock | null {
  if (value === null || value === undefined || typeof value !== "object") {
    return null;
  }
  const note = value as Record<string, unknown>;
  return {
    goalId: String(note["goalId"]),
    title: textOf(note["title"]),
    measure: note["measure"] as CommunityLock["measure"],
    threshold: Number(note["threshold"]),
    state: note["state"] as CommunityLock["state"],
    startsAt: new Date(String(note["startsAt"])).toISOString(),
  };
}
