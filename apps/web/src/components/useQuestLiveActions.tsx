"use client";

import { formatNumber, type Language } from "@questify/shared";
import { useState, type ReactNode } from "react";
import { ConfirmDialog } from "#src/components/ConfirmDialog.tsx";
import { FlashLaunchDialog, type FlashActions } from "#src/components/FlashControls.tsx";
import type { PollActions } from "#src/components/PollControls.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import type { useQuestBuilder } from "#src/components/useQuestBuilder.ts";
import { pollMinutesOf } from "#src/lib/polls.ts";
import type { QuestView } from "#src/lib/quests.ts";

type Builder = Pick<ReturnType<typeof useQuestBuilder>, "busy" | "send">;

/** A live poll's Send or Close while the page asks for it, with the Idempotency-Key it goes with (T-306). */
type Polling = Readonly<{ kind: "send" | "close"; quest: QuestView; key: string }>;

/** A flash quest's Launch or End now while the page asks for it, with its Idempotency-Key (T-307). */
type Flashing = Readonly<{ kind: "launch" | "end"; quest: QuestView; key: string }>;

/** The confirmation of a live poll's Send or Close. */
function PollDialog({
  language,
  polling,
  busy,
  cancel,
  confirm,
}: Readonly<{
  language: Language;
  polling: Polling;
  busy: boolean;
  cancel: () => void;
  confirm: () => void;
}>) {
  const t = useTranslator(language);
  const sending = polling.kind === "send";
  return (
    <ConfirmDialog
      language={language}
      title={t(sending ? "quests.poll.sendTitle" : "quests.poll.closeTitle")}
      body={
        sending
          ? t("quests.poll.sendBody", {
              minutes: formatNumber(pollMinutesOf(polling.quest.config), language),
            })
          : t("quests.poll.closeBody")
      }
      confirmLabel={t(sending ? "quests.poll.send" : "quests.poll.close")}
      noteLabel={null}
      busy={busy}
      cancel={cancel}
      confirm={confirm}
    />
  );
}

/**
 * The live poll and flash quest buttons of a quest list with their confirmations (T-306, T-307): each button asks first,
 * and the request goes with an Idempotency-Key made when the dialog opens, so a double click or a retry sends nothing
 * twice. The dialogs are the page's own children (the rest of the page turns inert behind them), so the page renders
 * `dialogs` itself. Shared by the quest builder and the control room.
 */
export function useQuestLiveActions({
  language,
  builder,
  focus,
  votesUrl,
}: Readonly<{
  language: Language;
  builder: Builder;
  focus: Readonly<{ remember: () => void; restore: () => void }>;
  /** Where a quest's vote counts are read. */
  votesUrl: (quest: QuestView) => string;
}>): Readonly<{ actions: PollActions & FlashActions; dialogs: ReactNode }> {
  const t = useTranslator(language);
  const [polling, setPolling] = useState<Polling | null>(null);
  const [flashing, setFlashing] = useState<Flashing | null>(null);

  const askPoll = (kind: Polling["kind"], quest: QuestView) => {
    focus.remember();
    setPolling({ kind, quest, key: crypto.randomUUID() });
  };
  const confirmPoll = () => {
    if (polling === null) {
      return;
    }
    const { kind, quest, key } = polling;
    setPolling(null);
    void builder
      .send("POST", `/quests/${quest.id}/${kind}`, {}, { key })
      .then(() => focus.restore());
  };
  const askFlash = (kind: Flashing["kind"], quest: QuestView) => {
    focus.remember();
    setFlashing({ kind, quest, key: crypto.randomUUID() });
  };
  const confirmFlash = (body: Readonly<Record<string, unknown>>) => {
    if (flashing === null) {
      return;
    }
    const { kind, quest, key } = flashing;
    setFlashing(null);
    void builder
      .send("POST", `/quests/${quest.id}/${kind}`, body, { key })
      .then(() => focus.restore());
  };
  const cancelFlash = () => {
    setFlashing(null);
    focus.restore();
  };

  const dialogs = (
    <>
      {polling === null ? null : (
        <PollDialog
          language={language}
          polling={polling}
          busy={builder.busy}
          cancel={() => {
            setPolling(null);
            focus.restore();
          }}
          confirm={confirmPoll}
        />
      )}
      {flashing?.kind === "launch" ? (
        <FlashLaunchDialog
          language={language}
          busy={builder.busy}
          cancel={cancelFlash}
          confirm={(minutes) => confirmFlash({ minutes })}
        />
      ) : null}
      {flashing?.kind === "end" ? (
        <ConfirmDialog
          language={language}
          title={t("quests.flash.endTitle")}
          body={t("quests.flash.endBody")}
          confirmLabel={t("quests.flash.end")}
          noteLabel={null}
          busy={builder.busy}
          cancel={cancelFlash}
          confirm={() => confirmFlash({})}
        />
      ) : null}
    </>
  );
  return {
    actions: {
      launchFlash: (quest) => askFlash("launch", quest),
      endFlash: (quest) => askFlash("end", quest),
      sendPoll: (quest) => askPoll("send", quest),
      closePoll: (quest) => askPoll("close", quest),
      votesUrl,
    },
    dialogs,
  };
}
