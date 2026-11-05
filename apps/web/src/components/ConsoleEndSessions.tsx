"use client";

import type { Language } from "@questify/shared";
import { useState } from "react";
import {
  ConfirmedButton,
  Problem,
  ReasonField,
  keyed,
  reasonReady,
  useWrite,
} from "#src/components/ConsoleOversight.tsx";
import { endStaffSessionsPath } from "#src/lib/console-platform.ts";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { Button } from "#src/ui/Button.tsx";
import { Muted } from "#src/ui/Feedback.tsx";
import { Stack } from "#src/ui/Section.tsx";

/**
 * Ends every session of one staff account at once (T-810c, FR-141, ADR-713): an organizer member or another admin,
 * after a reason and one confirmation. The API refuses the caller's own account. Ending sessions does not stop someone
 * who knows the password, so the note says to send a password reset as well (RUNBOOK).
 */
export function EndAllSessions({
  language,
  staffUserId,
  email,
  onEnded,
}: Readonly<{
  language: Language;
  staffUserId: string;
  email: string;
  onEnded: (done: string) => void;
}>) {
  const t = translatorFor(language);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const { busy, problem, run } = useWrite(language, (done) => {
    setOpen(false);
    setReason("");
    onEnded(done);
  });
  if (!open) {
    return (
      <Button size="sm" variant="quiet" onClick={() => setOpen(true)}>
        {t("console.staffSessions.open")}
      </Button>
    );
  }
  return (
    <Stack>
      <Problem problem={problem} />
      <ReasonField
        language={language}
        label="console.staffSessions.reason"
        reason={reason}
        change={setReason}
      />
      <Muted>{t("console.staffSessions.passwordNote")}</Muted>
      <ConfirmedButton
        language={language}
        label={t("console.staffSessions.end")}
        question={t("console.staffSessions.confirm", { email })}
        variant="danger"
        disabled={busy || !reasonReady(reason)}
        act={() =>
          void run(
            () =>
              requestJson(
                "POST",
                endStaffSessionsPath(staffUserId),
                { reason: reason.trim() },
                keyed(),
              ),
            t("console.staffSessions.ended", { email }),
          )
        }
      />
      <Button size="sm" variant="quiet" onClick={() => setOpen(false)}>
        {t("common.cancel")}
      </Button>
    </Stack>
  );
}
