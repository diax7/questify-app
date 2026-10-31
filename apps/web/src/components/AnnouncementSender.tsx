"use client";

import type { Language } from "@questify/shared";
import { useCallback, useEffect, useState } from "react";
import { AnnouncementComposer } from "#src/components/AnnouncementComposer.tsx";
import { ConfirmDialog } from "#src/components/ConfirmDialog.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import {
  useAnnouncementPress,
  type AnnouncementConfirmation,
  type Audience,
} from "#src/components/useAnnouncementPress.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { Button } from "#src/ui/Button.tsx";
import { Notice } from "#src/ui/Feedback.tsx";
import { Stack } from "#src/ui/Section.tsx";

/**
 * Sends an announcement from the control room (T-603, FR-1025): the Announcements page's composer and confirmation
 * without its lists. Asks who would be told, confirms with that number, and sends with an Idempotency-Key kept until
 * the answer is final, so a dropped connection resends the same announcement once.
 */
export function AnnouncementSender({
  language,
  path,
  zone,
  disabled,
}: Readonly<{
  language: Language;
  /** The event's announcements path, `/v1/organizers/{o}/events/{e}/announcements`. */
  path: string;
  zone: string;
  disabled: boolean;
}>) {
  const t = useTranslator(language);
  const [audience, setAudience] = useState<Audience>();
  const [problem, setProblem] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [confirm, setConfirm] = useState<AnnouncementConfirmation>();
  const [version, setVersion] = useState(0);

  const loadAudience = useCallback(async () => {
    const answer = await requestJson("GET", `${path}/preview`);
    const read = answer.ok ? (answer.body as Partial<Audience>) : undefined;
    if (typeof read?.members === "number" && typeof read.phase === "string") {
      setAudience({ members: read.members, phase: read.phase });
      setProblem(undefined);
    } else {
      setProblem(t("announcements.page.loadFailed"));
    }
  }, [path, t]);
  useEffect(() => {
    void loadAudience();
  }, [loadAudience]);

  const press = useAnnouncementPress(language, loadAudience, setProblem);
  const apply = async () => {
    if (confirm !== undefined && (await press.send(confirm))) {
      setNotice(confirm.success);
      setConfirm(undefined);
      setVersion((value) => value + 1);
    }
  };
  return (
    <Stack>
      {problem === undefined ? null : (
        <Notice tone="danger" role="alert">
          {problem}
        </Notice>
      )}
      {notice === undefined ? null : (
        <Notice tone="success" role="status">
          {notice}
        </Notice>
      )}
      {audience === undefined ? (
        <Button variant="secondary" onClick={() => void loadAudience()}>
          {t("common.retry")}
        </Button>
      ) : (
        <AnnouncementComposer
          key={version}
          language={language}
          path={path}
          audience={audience}
          zone={zone}
          disabled={disabled || press.busy || confirm !== undefined}
          confirm={setConfirm}
        />
      )}
      {confirm === undefined ? null : (
        <ConfirmDialog
          language={language}
          title={confirm.title}
          body={confirm.text}
          confirmLabel={confirm.label}
          noteLabel={null}
          busy={press.busy}
          cancel={() => {
            if (!press.uncertain) setConfirm(undefined);
          }}
          confirm={() => void apply()}
        />
      )}
    </Stack>
  );
}
