"use client";

import { checkAnnouncement, type Language } from "@questify/shared";
import { useState } from "react";
import { AnnouncementFields } from "#src/components/AnnouncementParts.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { blankAnnouncement } from "#src/lib/announcements.ts";
import { Button } from "#src/ui/Button.tsx";
import { Dialog } from "#src/ui/Dialog.tsx";

export type MessageText = Readonly<{
  titleAr: string;
  titleEn: string;
  bodyAr: string;
  bodyEn: string;
}>;

/** A message to everyone registered for one session: the announcement's four fields, checked as an announcement. */
export function SessionMessageDialog({
  language,
  busy,
  cancel,
  send,
}: Readonly<{
  language: Language;
  busy: boolean;
  cancel: () => void;
  send: (text: MessageText) => void;
}>) {
  const t = useTranslator(language);
  const [draft, setDraft] = useState(blankAnnouncement);
  const checked = checkAnnouncement(draft);
  return (
    <Dialog
      role="dialog"
      title={t("sessions.page.messageTitle")}
      busy={busy}
      cancel={cancel}
      actions={
        <>
          <Button variant="secondary" disabled={busy} onClick={cancel}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={busy || !checked.ok}
            onClick={() => {
              if (!checked.ok) return;
              const { titleAr, titleEn, bodyAr, bodyEn } = checked.draft;
              send({ titleAr, titleEn, bodyAr, bodyEn });
            }}
          >
            {t("sessions.page.messageSend")}
          </Button>
        </>
      }
    >
      <AnnouncementFields language={language} draft={draft} disabled={busy} change={setDraft} />
    </Dialog>
  );
}
