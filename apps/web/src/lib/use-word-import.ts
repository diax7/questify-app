"use client";

import type { DailyLanguage, Language } from "@questify/shared";
import { useMemo, useState, type ChangeEvent } from "react";
import { API, readListChange } from "#src/lib/console-daily.ts";
import {
  REFUSED_SHOWN,
  chunkWords,
  parseWordLines,
  shownRefusals,
} from "#src/lib/console-daily-forms.ts";
import { translatorFor } from "#src/lib/language.ts";
import { isTransientFailure, requestJson } from "#src/lib/post-json.ts";
import { problemText } from "#src/lib/use-daily-console.ts";
import { useRequestKey } from "#src/lib/use-request-key.ts";

/** A pasted list is a text file of at most this size (far more than any list of five-letter words). */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

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

/**
 * Sends a pasted list to the guess list, to add or remove, in calls of at most `IMPORT_CALL_WORDS` words. It stops at the first
 * failure and keeps what the earlier calls did. Each call carries an Idempotency-Key, so a retry after a dropped
 * answer replays instead of repeating; a refusal ends the key, so the retry after it is a new request.
 */
export function useWordImport(
  language: Language,
  listLanguage: DailyLanguage,
  changed: (total: number) => void,
) {
  const t = translatorFor(language);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  const request = useRequestKey();
  const parsed = useMemo(() => parseWordLines(text), [text]);

  const send = async (mode: "add" | "remove") => {
    if (parsed.words.length === 0) {
      setProblem(t("console.words.importEmpty"));
      return;
    }
    setBusy(true);
    setProblem(null);
    setOutcome(null);
    let done: ImportOutcome = {
      added: 0,
      removed: 0,
      total: 0,
      refused: [],
      refusedCount: 0,
      refusedCapped: false,
      tooLong: parsed.tooLong,
      longSamples: parsed.longSamples,
    };
    for (const chunk of chunkWords(parsed.words)) {
      const body = mode === "add" ? { add: chunk, remove: [] } : { add: [], remove: chunk };
      const result = await requestJson("POST", `${API}/word-list/${listLanguage}`, body, {
        "idempotency-key": request.keyFor(`${mode} ${listLanguage}\n${chunk.join("\n")}`),
      });
      const change = result.ok ? readListChange(result.body) : undefined;
      if (change === undefined) {
        if (!isTransientFailure(result)) {
          request.forget();
        }
        setProblem(problemText(result.body, language));
        break;
      }
      request.forget();
      done = {
        ...done,
        added: done.added + change.added,
        removed: done.removed + change.removed,
        total: change.total,
        refused: shownRefusals([...done.refused, ...change.refused]),
        refusedCount: done.refusedCount + change.refused.length,
        refusedCapped: done.refusedCapped || change.refused.length >= REFUSED_SHOWN,
      };
      setOutcome(done);
      changed(change.total);
    }
    setBusy(false);
  };

  const load = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file === undefined) {
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setProblem(t("console.words.fileTooBig"));
      return;
    }
    try {
      setText(await file.text());
      setProblem(null);
    } catch {
      setProblem(t("console.words.fileFailed"));
    }
  };

  return { text, setText, busy, problem, outcome, send, load, ready: parsed.words.length };
}
