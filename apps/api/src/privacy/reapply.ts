import { randomUUID } from "node:crypto";
import type { Client } from "pg";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The player ids to erase again after a restore (RUNBOOK "Re-apply erasures", ADR-484), from text the operator
 * gathered: the API's `player.deleted` log lines (JSON, `player` field) and plain ids one per line (from the old
 * database's `player.delete` audit entries). Other lines are skipped; each id comes back once, lower-cased.
 */
export function erasedIdsFrom(text: string): string[] {
  const ids = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (UUID.test(line)) {
      ids.add(line.toLowerCase());
      continue;
    }
    if (!line.startsWith("{")) {
      continue;
    }
    try {
      const entry = JSON.parse(line) as { event?: unknown; player?: unknown };
      if (
        entry.event === "player.deleted" &&
        typeof entry.player === "string" &&
        UUID.test(entry.player)
      ) {
        ids.add(entry.player.toLowerCase());
      }
    } catch {
      // A truncated or foreign log line names no erasure; the operator's file may hold any log output.
    }
  }
  return [...ids];
}

export type ReapplyCount = Readonly<{ erased: number; alreadyDeleted: number; unknown: number }>;

/** Calls the owner-only `reapply_erasure` door for each id, one transaction each, and counts the outcomes. */
export async function reapplyErasures(
  owner: Client,
  ids: readonly string[],
): Promise<ReapplyCount> {
  const counts = { erased: 0, alreadyDeleted: 0, unknown: 0 };
  for (const id of ids) {
    const { rows } = await owner.query<{ r: string }>("SELECT reapply_erasure($1, $2) AS r", [
      id,
      randomUUID(),
    ]);
    const outcome = rows[0]?.r;
    if (outcome === "erased") counts.erased += 1;
    else if (outcome === "already_deleted") counts.alreadyDeleted += 1;
    else counts.unknown += 1;
  }
  return counts;
}
