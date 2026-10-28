"use client";

import { formatNumber, type Language } from "@questify/shared";
import { useState, type ReactNode } from "react";
import { ConfirmDialog } from "#src/components/ConfirmDialog.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import type { useQuestBuilder } from "#src/components/useQuestBuilder.ts";
import { hintPreviewOf } from "#src/lib/hint.ts";
import type { CategoryView } from "#src/lib/quests.ts";
import styles from "#src/components/layout.module.css";

type Builder = Pick<ReturnType<typeof useQuestBuilder>, "busy" | "read" | "send">;

/** A hidden category's hint while the page asks for it: who would be told, and the Idempotency-Key it goes with. */
type Asking = Readonly<{ category: CategoryView; members: number; key: string }>;

/**
 * The hint on a hidden category (T-501g, FR-238): Send a hint counts the members who would be told, asks for a
 * confirmation that says how many, and sends with an Idempotency-Key made when the dialog opens, so a double click or a
 * resend sends nothing twice. Nothing to confirm when no one is left to tell or the last hint is still on its way; a note
 * says so. The dialog is the page's own child (the page's other content turns inert behind it), so the page renders
 * `dialog` and `note` itself.
 */
export function useCategoryHint({
  language,
  builder,
  live,
  focus,
}: Readonly<{
  language: Language;
  builder: Builder;
  /** False before go-live: the hint then reaches the rehearsal accounts only, and the dialog says so. */
  live: boolean;
  focus: Readonly<{ remember: () => void; restore: () => void }>;
}>): Readonly<{ ask: (category: CategoryView) => void; note: ReactNode; dialog: ReactNode }> {
  const t = useTranslator(language);
  const [asking, setAsking] = useState<Asking | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const ask = async (category: CategoryView) => {
    focus.remember();
    setNote(null);
    const preview = hintPreviewOf(await builder.read(`/categories/${category.id}/hint`));
    if (preview === undefined || preview.pending || preview.members === 0) {
      if (preview !== undefined) {
        setNote(t(preview.pending ? "quests.hint.pending" : "quests.hint.nobody"));
      }
      focus.restore();
      return;
    }
    setAsking({ category, members: preview.members, key: crypto.randomUUID() });
  };
  const close = () => {
    setAsking(null);
    focus.restore();
  };
  const confirm = () => {
    if (asking === null) {
      return;
    }
    const { category, key } = asking;
    setAsking(null);
    void builder.send("POST", `/categories/${category.id}/hint`, {}, { key }).then((sent) => {
      setNote(sent ? t("quests.hint.sent") : null);
      focus.restore();
    });
  };

  const body =
    asking === null
      ? ""
      : `${t("quests.hint.body", { count: formatNumber(asking.members, language) })}${
          live ? "" : ` ${t("quests.hint.rehearsal")}`
        }`;
  return {
    ask: (category) => void ask(category),
    note:
      note === null ? null : (
        <p role="status" className={styles.notice}>
          {note}
        </p>
      ),
    dialog:
      asking === null ? null : (
        <ConfirmDialog
          language={language}
          title={t("quests.hint.title")}
          body={body}
          confirmLabel={t("quests.hint.confirm")}
          noteLabel={null}
          busy={builder.busy}
          cancel={close}
          confirm={confirm}
        />
      ),
  };
}
