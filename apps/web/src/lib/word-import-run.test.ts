import type { WordListChange } from "@questify/shared";
import { describe, expect, it } from "vitest";
import { IMPORT_CALL_WORDS, REFUSED_SHOWN, parseWordLines } from "#src/lib/console-daily-forms.ts";
import {
  runImport,
  startOutcome,
  type ImportCall,
  type ImportOutcome,
} from "#src/lib/word-import-run.ts";

const words = (count: number) => Array.from({ length: count }, (_, index) => `w${String(index)}`);

const change = (fields: Partial<WordListChange>): { change: WordListChange } => ({
  change: { added: 0, removed: 0, refused: [], total: 0, ...fields },
});

/** A fake API: answers the calls in order and records the words each one carried. */
function scripted(answers: Awaited<ReturnType<ImportCall>>[]) {
  const seen: (readonly string[])[] = [];
  const call: ImportCall = (chunk) => {
    seen.push(chunk);
    const answer = answers[seen.length - 1];
    if (answer === undefined) {
      throw new Error("a call nobody expected");
    }
    return Promise.resolve(answer);
  };
  return { call, seen };
}

const start = startOutcome(parseWordLines("a\nb"));

describe("runImport", () => {
  it("adds up every call, passes the running sum on after each, and reports no problem", async () => {
    const { call, seen } = scripted([
      change({ added: 500, total: 500, refused: ["x1"] }),
      change({ added: 480, total: 980, refused: ["x2"] }),
      change({ added: 250, total: 1230 }),
    ]);
    const progress: ImportOutcome[] = [];

    const run = await runImport(words(1_250), start, call, (outcome) => progress.push(outcome));

    expect(seen.map((chunk) => chunk.length)).toEqual([500, 500, 250]);
    expect(run).toEqual({
      outcome: expect.objectContaining({
        added: 1_230,
        total: 1_230,
        refused: ["x1", "x2"],
        refusedCount: 2,
      }),
      sent: 1_250,
      problem: null,
    });
    expect(progress.map((outcome) => outcome.total)).toEqual([500, 980, 1_230]);
  });

  it("keeps the first call's counts when the second call fails, and sends nothing after it", async () => {
    const { call, seen } = scripted([
      change({ added: 500, removed: 0, total: 500, refused: ["bad"] }),
      { problem: "The server is busy." },
      change({ added: 250, total: 750 }),
    ]);
    const progress: ImportOutcome[] = [];

    const run = await runImport(words(1_250), start, call, (outcome) => progress.push(outcome));

    expect(seen).toHaveLength(2);
    expect(run.problem).toBe("The server is busy.");
    expect(run.sent).toBe(IMPORT_CALL_WORDS);
    expect(run.outcome).toEqual({
      ...start,
      added: 500,
      total: 500,
      refused: ["bad"],
      refusedCount: 1,
    });
    expect(progress).toEqual([run.outcome]);
  });

  it("changes nothing when the first call fails", async () => {
    const { call } = scripted([{ problem: "No." }]);
    const progress: ImportOutcome[] = [];

    const run = await runImport(words(600), start, call, (outcome) => progress.push(outcome));

    expect(run).toEqual({ outcome: start, sent: 0, problem: "No." });
    expect(progress).toEqual([]);
  });

  it("shows no more refused lines than the API would, and notes when a call hit its cap", async () => {
    const many = Array.from({ length: REFUSED_SHOWN }, (_, index) => `r${String(index)}`);
    const { call } = scripted([change({ refused: many }), change({ refused: ["late"] })]);

    const { outcome } = await runImport(words(501), start, call, () => undefined);

    expect(outcome.refused).toEqual(many);
    expect(outcome.refusedCount).toBe(REFUSED_SHOWN + 1);
    expect(outcome.refusedCapped).toBe(true);
  });
});
