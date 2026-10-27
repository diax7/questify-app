import type { WordListChange } from "@questify/shared";
import {
  REFUSED_SHOWN,
  chunkWords,
  shownRefusals,
  type ImportLines,
} from "#src/lib/console-daily-forms.ts";

export type ImportOutcome = Readonly<{
  added: number;
  removed: number;
  total: number;
  /** The first refused lines (at most `REFUSED_SHOWN`). */
  refused: readonly string[];
  /** Every refused line the API reported, shown or not. */
  refusedCount: number;
  /** A call reported the most it ever does, so there may be more refused lines than were reported. */
  refusedCapped: boolean;
  tooLong: number;
  longSamples: readonly string[];
}>;

/** One call to the API: what it changed, or the text to show when it failed. */
export type ImportCall = (
  words: readonly string[],
) => Promise<Readonly<{ change: WordListChange }> | Readonly<{ problem: string }>>;

export type ImportRun = Readonly<{
  /** The sum of the calls that went through. */
  outcome: ImportOutcome;
  /** How many words were in those calls. */
  sent: number;
  /** Why the run stopped, or null when every call went through. */
  problem: string | null;
}>;

/** Nothing done yet; the lines held back for being too long are already known. */
export const startOutcome = (parsed: ImportLines): ImportOutcome => ({
  added: 0,
  removed: 0,
  total: 0,
  refused: [],
  refusedCount: 0,
  refusedCapped: false,
  tooLong: parsed.tooLong,
  longSamples: parsed.longSamples,
});

function withChange(outcome: ImportOutcome, change: WordListChange): ImportOutcome {
  return {
    ...outcome,
    added: outcome.added + change.added,
    removed: outcome.removed + change.removed,
    total: change.total,
    refused: shownRefusals([...outcome.refused, ...change.refused]),
    refusedCount: outcome.refusedCount + change.refused.length,
    refusedCapped: outcome.refusedCapped || change.refused.length >= REFUSED_SHOWN,
  };
}

/**
 * Sends a list in calls one after another. It stops at the first call that fails and keeps the counts of the calls
 * before it; `onProgress` is told the running sum after each call that went through.
 */
export async function runImport(
  words: readonly string[],
  start: ImportOutcome,
  call: ImportCall,
  onProgress: (outcome: ImportOutcome) => void,
): Promise<ImportRun> {
  let outcome = start;
  let sent = 0;
  for (const chunk of chunkWords(words)) {
    const answer = await call(chunk);
    if ("problem" in answer) {
      return { outcome, sent, problem: answer.problem };
    }
    outcome = withChange(outcome, answer.change);
    sent += chunk.length;
    onProgress(outcome);
  }
  return { outcome, sent, problem: null };
}
