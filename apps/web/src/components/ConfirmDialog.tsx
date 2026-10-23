"use client";

import type { Language } from "@questify/shared";
import { useState } from "react";
import { useFocusOnMount } from "#src/components/QuestBuilderParts.tsx";
import { translatorFor } from "#src/lib/language.ts";
import styles from "#src/components/layout.module.css";

type Props = Readonly<{
  language: Language;
  title: string;
  body: string;
  confirmLabel: string;
  /** The label of an optional note field (at most 300 characters), or null for none. */
  noteLabel: string | null;
  busy: boolean;
  cancel: () => void;
  confirm: (note: string) => void;
}>;

/**
 * A confirmation sheet for one team action: what happens, an optional note, Cancel and the action. Escape cancels;
 * the heading takes focus when it opens. The caller makes the panel behind it inert.
 */
export function ConfirmDialog({
  language,
  title,
  body,
  confirmLabel,
  noteLabel,
  busy,
  cancel,
  confirm,
}: Props) {
  const t = translatorFor(language);
  const heading = useFocusOnMount<HTMLHeadingElement>();
  const [note, setNote] = useState("");
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
      aria-describedby="confirm-body"
      className={styles.card}
      onKeyDown={(pressed) => {
        if (pressed.key === "Escape" && !busy) {
          cancel();
        }
      }}
    >
      <h2 id="confirm-title" ref={heading} tabIndex={-1} className={styles.subtitle}>
        {title}
      </h2>
      <p id="confirm-body">{body}</p>
      {noteLabel === null ? null : (
        <label className={styles.field}>
          <span>{noteLabel}</span>
          <textarea
            className={styles.input}
            dir="auto"
            maxLength={300}
            value={note}
            onChange={(changed) => setNote(changed.target.value)}
          />
        </label>
      )}
      <div className={styles.actions}>
        <button type="button" className={styles.quiet} disabled={busy} onClick={cancel}>
          {t("common.cancel")}
        </button>
        <button
          type="button"
          className={styles.button}
          disabled={busy}
          onClick={() => confirm(note.trim())}
        >
          {confirmLabel}
        </button>
      </div>
    </div>
  );
}
