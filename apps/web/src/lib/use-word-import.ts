"use client";

import { formatNumber, type DailyLanguage, type Language } from "@questify/shared";
import { useMemo, useState, type ChangeEvent } from "react";
import { API, readListChange } from "#src/lib/console-daily.ts";
import { parseWordLines } from "#src/lib/console-daily-forms.ts";
import { translatorFor } from "#src/lib/language.ts";
import { isTransientFailure, requestJson } from "#src/lib/post-json.ts";
import { problemText } from "#src/lib/use-daily-console.ts";
import { useRequestKey } from "#src/lib/use-request-key.ts";
import {
  runImport,
  startOutcome,
  type ImportCall,
  type ImportOutcome,
} from "#src/lib/word-import-run.ts";

/** A pasted list is a text file of at most this size (far more than any list of five-letter words). */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/**
 * Sends a pasted list to the guess list, to add or remove, in calls of at most `IMPORT_CALL_WORDS` words. It stops at the first
 * failure and keeps what the earlier calls did, and says how far it got. Each call carries an Idempotency-Key, so a
 * retry after a dropped answer replays instead of repeating; a refusal ends the key, so the retry after it is a new
 * request. Sending the list again after a stop repeats the calls that went through with new keys: adds change nothing
 * already there, and each call leaves one audit row (ADR-328).
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

  const callFor =
    (mode: "add" | "remove"): ImportCall =>
    async (chunk) => {
      const body = mode === "add" ? { add: chunk, remove: [] } : { add: [], remove: chunk };
      const result = await requestJson("POST", `${API}/word-list/${listLanguage}`, body, {
        "idempotency-key": request.keyFor(`${mode} ${listLanguage}\n${chunk.join("\n")}`),
      });
      const change = result.ok ? readListChange(result.body) : undefined;
      if (change === undefined) {
        if (!isTransientFailure(result)) {
          request.forget();
        }
        return { problem: problemText(result.body, language) };
      }
      request.forget();
      return { change };
    };

  const send = async (mode: "add" | "remove") => {
    if (parsed.words.length === 0) {
      setProblem(t("console.words.importEmpty"));
      return;
    }
    setBusy(true);
    setProblem(null);
    setOutcome(null);
    const run = await runImport(parsed.words, startOutcome(parsed), callFor(mode), (progress) => {
      setOutcome(progress);
      changed(progress.total);
    });
    if (run.problem !== null) {
      const stopped = t("console.words.importStopped", {
        done: formatNumber(run.sent, language),
        total: formatNumber(parsed.words.length, language),
      });
      setProblem(run.sent === 0 ? run.problem : `${run.problem} ${stopped}`);
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
