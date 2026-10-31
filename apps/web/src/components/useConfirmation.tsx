"use client";

import type { Language } from "@questify/shared";
import { useState, type ReactNode } from "react";
import { ConfirmDialog } from "#src/components/ConfirmDialog.tsx";

/** What a confirmation says before an action runs (FR-1031, FR-1032), and the action. */
export type Confirmation = Readonly<{
  title: string;
  body: string;
  confirmLabel: string;
  run: () => Promise<unknown> | void;
}>;

/**
 * Asks before a consequential action (ADR-063): `ask` opens the dialog with the action's own words, nothing runs until
 * its action button is pressed, and Cancel or Escape leaves everything as it was. Render `dialog` once in the page.
 */
export function useConfirmation(language: Language): {
  ask: (confirmation: Confirmation) => void;
  dialog: ReactNode;
} {
  const [asked, setAsked] = useState<Confirmation | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async (confirmation: Confirmation) => {
    setBusy(true);
    try {
      await confirmation.run();
    } finally {
      setBusy(false);
      setAsked(null);
    }
  };
  const dialog =
    asked === null ? null : (
      <ConfirmDialog
        language={language}
        title={asked.title}
        body={asked.body}
        confirmLabel={asked.confirmLabel}
        noteLabel={null}
        busy={busy}
        cancel={() => setAsked(null)}
        confirm={() => void go(asked)}
      />
    );
  return { ask: setAsked, dialog };
}
