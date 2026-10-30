"use client";

import type { Language } from "@questify/shared";
import { useState } from "react";
import { translatorFor } from "#src/lib/language.ts";
import { Button } from "#src/ui/Button.tsx";
import { Field, Textarea } from "#src/ui/Field.tsx";
import { Dialog } from "#src/ui/Dialog.tsx";

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
 * A confirmation for one team action: what happens, an optional note, Cancel and the action, in the shared modal
 * `Dialog` (focus on its heading, Escape cancels, the page behind it shut out).
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
  const [note, setNote] = useState("");
  return (
    <Dialog
      titleId="confirm-title"
      describedById="confirm-body"
      title={title}
      busy={busy}
      cancel={cancel}
      actions={
        <>
          <Button variant="secondary" disabled={busy} onClick={cancel}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => confirm(note.trim())}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p id="confirm-body">{body}</p>
      {noteLabel === null ? null : (
        <Field label={noteLabel}>
          <Textarea
            dir="auto"
            maxLength={300}
            value={note}
            onChange={(changed) => setNote(changed.target.value)}
          />
        </Field>
      )}
    </Dialog>
  );
}
