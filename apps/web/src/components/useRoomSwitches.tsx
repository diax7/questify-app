"use client";

import { formatNumber, type Language } from "@questify/shared";
import { useState, type ReactNode } from "react";
import { ConfirmDialog } from "#src/components/ConfirmDialog.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import type { useQuestBuilder } from "#src/components/useQuestBuilder.ts";
import { textFor, type QuestView } from "#src/lib/quests.ts";

type Builder = Pick<ReturnType<typeof useQuestBuilder>, "busy" | "send">;

/** The control room's four quest switches (T-603b, FR-1026). */
export type RoomSwitch = "pause" | "resume" | "skip" | "unskip";

type Asking = Readonly<{ kind: RoomSwitch; quest: QuestView; key: string }>;

const TEXT = {
  pause: {
    title: "control.pause.title",
    body: "control.pause.body",
    label: "control.pause.action",
  },
  resume: {
    title: "control.resume.title",
    body: "control.resume.body",
    label: "control.resume.action",
  },
  skip: { title: "control.skip.title", body: "control.skip.body", label: "control.skip.action" },
  unskip: {
    title: "control.unskip.title",
    body: "control.unskip.body",
    label: "control.unskip.action",
  },
} as const;

/**
 * Pause, Resume, Skip step and Restore step with their confirmations: each says what will happen and what will not
 * change (ADR-063), and Restore step says how many players will be held at the step again. The request goes with an
 * Idempotency-Key made when the dialog opens, so a double click sends nothing twice.
 */
export function useRoomSwitches({
  language,
  builder,
  focus,
  behind,
}: Readonly<{
  language: Language;
  builder: Builder;
  focus: Readonly<{ remember: () => void; restore: () => void }>;
  /** Players past each skipped step who have not done it, by quest id. */
  behind: Readonly<Record<string, number>>;
}>): Readonly<{ ask: (kind: RoomSwitch, quest: QuestView) => void; dialog: ReactNode }> {
  const t = useTranslator(language);
  const [asking, setAsking] = useState<Asking | null>(null);
  const ask = (kind: RoomSwitch, quest: QuestView) => {
    focus.remember();
    setAsking({ kind, quest, key: crypto.randomUUID() });
  };
  const close = () => {
    setAsking(null);
    focus.restore();
  };
  const confirm = () => {
    if (asking === null) {
      return;
    }
    const { kind, quest, key } = asking;
    setAsking(null);
    void builder
      .send("POST", `/quests/${quest.id}/${kind}`, {}, { key })
      .then(() => focus.restore());
  };
  const text = asking === null ? null : TEXT[asking.kind];
  const dialog =
    asking === null || text === null ? null : (
      <ConfirmDialog
        language={language}
        title={t(text.title, { title: textFor(asking.quest.title, language) })}
        body={t(text.body, { count: formatNumber(behind[asking.quest.id] ?? 0, language) })}
        confirmLabel={t(text.label)}
        noteLabel={null}
        busy={builder.busy}
        cancel={close}
        confirm={confirm}
      />
    );
  return { ask, dialog };
}
