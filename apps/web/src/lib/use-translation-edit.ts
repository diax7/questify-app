"use client";

import type { Language, MatrixRow } from "@questify/shared";
import { useCallback, useState } from "react";
import {
  bodyOf,
  canSave,
  draftOf,
  isDirty,
  keyPath,
  readSavedRow,
  revertBody,
  type RowDraft,
} from "#src/lib/console-translations.ts";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);

/** The row being edited with what has been typed into it. */
export type Editing = Readonly<{ row: MatrixRow; draft: RowDraft }>;

/** What was done last, so the page can say so: a key saved, or returned to the shipped text. */
export type Done = Readonly<{ kind: "saved" | "reverted"; key: string }>;

export type TranslationEdit = Readonly<{
  editing: Editing | null;
  busy: boolean;
  problem: string | null;
  done: Done | null;
  /** True while the open row holds a change that is not saved. */
  dirty: boolean;
  /** A step the person was about to take that waits for their answer to "save or discard?", or null. */
  waiting: (() => void) | null;
  start: (row: MatrixRow) => void;
  type: (language: Language, text: string) => void;
  discard: () => void;
  save: () => Promise<boolean>;
  revert: (row: MatrixRow) => Promise<void>;
  /** Runs `step` now, or after the person chose, when the open row holds a change that is not saved. */
  guard: (step: () => void) => void;
  /** The answer to "save or discard?": carry on with the step that waited, saving first when asked. */
  answer: (choice: "save" | "discard" | "keep") => Promise<void>;
}>;

type Sent = Readonly<{ row: MatrixRow }> | Readonly<{ problem: string }> | "signed-out";

/** One `PUT …/translations/:key`: the row it answers with, or what to tell the person. */
async function putRow(
  language: Language,
  key: string,
  body: Partial<Record<Language, string>>,
): Promise<Sent> {
  const result = await requestJson("PUT", keyPath(key), body);
  const code = errorCodeOf(result.body);
  if (code !== undefined && SESSION_LOST.has(code)) {
    return "signed-out";
  }
  const row = result.ok ? readSavedRow(result.body) : undefined;
  return row === undefined
    ? { problem: describeProblem(result.body, language, translatorFor(language)).text }
    : { row };
}

/**
 * Editing one row of the matrix at a time: its draft, the save and the revert (both `PUT …/translations/:key`, a blank
 * value returning a language to the shipped text) and the "save or discard?" a step away from an unsaved edit waits for.
 */
export function useTranslationEdit(
  language: Language,
  onSaved: (row: MatrixRow) => void,
): TranslationEdit {
  const [editing, setEditing] = useState<Editing | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [waiting, setWaiting] = useState<(() => void) | null>(null);
  const dirty = editing !== null && isDirty(editing.row, editing.draft);

  const send = async (key: string, body: Partial<Record<Language, string>>) => {
    setBusy(true);
    setProblem(null);
    const sent = await putRow(language, key, body);
    setBusy(false);
    if (sent === "signed-out") {
      window.location.assign(`/${language}/sign-in?ended=1`);
    } else if ("problem" in sent) {
      setProblem(sent.problem);
    } else {
      onSaved(sent.row);
      return sent.row;
    }
    return undefined;
  };

  const save = async (): Promise<boolean> => {
    if (editing === null || !canSave(editing.row, editing.draft)) {
      return false;
    }
    const saved = await send(editing.row.key, bodyOf(editing.row, editing.draft));
    if (saved !== undefined) {
      setEditing(null);
      setDone({ kind: "saved", key: saved.key });
    }
    return saved !== undefined;
  };

  const revert = async (row: MatrixRow): Promise<void> => {
    if ((await send(row.key, revertBody(row))) !== undefined) {
      setEditing((now) => (now?.row.key === row.key ? null : now));
      setDone({ kind: "reverted", key: row.key });
    }
  };

  const guard = useCallback(
    (step: () => void) => {
      if (dirty) {
        setWaiting(() => step);
      } else {
        step();
      }
    },
    [dirty],
  );

  const answer = async (choice: "save" | "discard" | "keep"): Promise<void> => {
    const step = waiting;
    setWaiting(null);
    if (choice === "keep" || step === null || (choice === "save" && !(await save()))) {
      return;
    }
    setEditing(null);
    step();
  };

  const start = (row: MatrixRow): void => {
    setEditing({ row, draft: draftOf(row) });
    setProblem(null);
    setDone(null);
  };

  const type = (code: Language, text: string): void =>
    setEditing((now) => (now === null ? now : { ...now, draft: { ...now.draft, [code]: text } }));

  const discard = (): void => {
    setEditing(null);
    setProblem(null);
  };

  return {
    editing,
    busy,
    problem,
    done,
    dirty,
    waiting,
    start,
    type,
    discard,
    save,
    revert,
    guard,
    answer,
  };
}
