import { held, isPlayerCode, isRepeat, memoryIn, type ScanMemory } from "#src/operator/station.ts";

/**
 * What a camera read comes to at the station: the same code still held up (`repeat`, its window slides), a read while
 * another is being answered (`busy`), something that cannot be a player's code (`invalid`, red at once), or a code to
 * send (`send`).
 */
export type Admission = Readonly<{
  memory: ScanMemory;
  action: "repeat" | "busy" | "invalid" | "send";
}>;

/**
 * Takes a read into the station's memory (FR-923). A code still in front of the camera keeps its one scan for as long
 * as it stays; otherwise the read becomes the last scan unless one is already being answered.
 */
export function admit(
  memory: ScanMemory,
  practice: boolean,
  read: Readonly<{ code: string; questId: string; now: number; busy: boolean }>,
): Admission {
  const current = memoryIn(memory, practice);
  const { last } = current;
  if (last !== null && isRepeat(last, read.code, read.questId, read.now)) {
    return { memory: { ...current, last: held(last, read.now) }, action: "repeat" };
  }
  if (read.busy) {
    return { memory: current, action: "busy" };
  }
  const next = {
    ...current,
    last: { code: read.code, questId: read.questId, at: read.now },
  };
  return { memory: next, action: isPlayerCode(read.code) ? "send" : "invalid" };
}

/** What the station does with an answer that is not a result: leave operator mode, sign out, or let the code retry. */
export type Outcome = "removed" | "signed_out" | "retry";

export const outcomeOf = (kind: string): Outcome =>
  kind === "removed" || kind === "signed_out" ? kind : "retry";

/** Whether the answer settles the scan's key: only a lost reply leaves it pending. */
export const settlesKey = (kind: string): boolean => kind !== "network";
