"use client";

import { formatNumber, type Language, type SessionBody, type TeamSession } from "@questify/shared";
import { useState } from "react";
import { ConfirmDialog } from "#src/components/ConfirmDialog.tsx";
import { SessionForm } from "#src/components/SessionForm.tsx";
import { SessionImportSection } from "#src/components/SessionImport.tsx";
import { SessionList } from "#src/components/SessionList.tsx";
import { SessionMessageDialog, type MessageText } from "#src/components/SessionMessage.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { downloadText } from "#src/lib/download-text.ts";
import type { Translate } from "#src/lib/language.ts";
import {
  blankSession,
  draftOf,
  sessionReport,
  sessionTemplateCsv,
  type SessionDraft,
} from "#src/lib/sessions.ts";
import {
  sessionFailure,
  useSessions,
  type EventFrame,
  type QuestChoice,
  type SessionsProps,
} from "#src/lib/use-sessions.ts";
import { Button } from "#src/ui/Button.tsx";
import { Muted, Notice } from "#src/ui/Feedback.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Stack } from "#src/ui/Section.tsx";
import { infoTip } from "#src/ui/info.tsx";

type Edit = Readonly<{ id: string | null; draft: SessionDraft }>;
type Writes = ReturnType<typeof useSessionWrites>;
type Ready = Readonly<{ sessions: TeamSession[]; event: EventFrame; quests: QuestChoice[] }>;

/** The panel's writes: each runs one request and says what happened, or why not. */
function useSessionWrites(props: SessionsProps) {
  const { language } = props;
  const t = useTranslator(language);
  const model = useSessions(props);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const run = async (
    method: "POST" | "PUT" | "DELETE",
    suffix: string,
    body: unknown,
    done: (answer: unknown) => string,
  ): Promise<boolean> => {
    setNotice(null);
    setFailure(null);
    const result = await model.write(method, suffix, body);
    if (result.ok) setNotice(done(result.body));
    else setFailure(sessionFailure(result.body, language, t));
    return result.ok;
  };
  const { sessions, frame } = model;
  const ready: Ready | null =
    sessions !== null && frame !== null
      ? { sessions, event: frame.event, quests: frame.quests }
      : null;
  return { model, notice, failure, setFailure, run, t, ready };
}

function exportReport(ready: Ready, t: Translate): void {
  const names = {
    title: t("sessions.page.reportTitle"),
    type: t("sessions.page.kind"),
    start: t("sessions.page.reportStart"),
    place: t("sessions.page.reportPlace"),
    seats: t("sessions.page.reportSeats"),
    registered: t("sessions.page.registered"),
    attended: t("sessions.page.attended"),
    walkIns: t("sessions.page.walkInCount"),
    noShows: t("sessions.page.noShows"),
  };
  downloadText("sessions.csv", sessionReport(ready.sessions, ready.event.zone, names));
}

function SessionsNotices({ writes, editing }: Readonly<{ writes: Writes; editing: boolean }>) {
  const { model, notice, failure, ready, t } = writes;
  return (
    <>
      {model.problem === null ? null : (
        <Notice tone="danger" role="alert">
          {model.problem}
        </Notice>
      )}
      {notice === null ? null : (
        <Notice tone="success" role="status">
          {notice}
        </Notice>
      )}
      {failure === null || editing ? null : (
        <Notice tone="danger" role="alert">
          {failure}
        </Notice>
      )}
      {ready === null ? <Muted role="status">{t("common.loading")}</Muted> : null}
    </>
  );
}

type Opened = Readonly<{
  setEdit: (edit: Edit | null) => void;
  setMessaging: (session: TeamSession | null) => void;
  setRemoving: (session: TeamSession | null) => void;
}>;

function SessionsBody({
  language,
  writes,
  ready,
  edit,
  opened,
  surveyUrl,
}: Readonly<{
  language: Language;
  writes: Writes;
  ready: Ready;
  edit: Edit | null;
  opened: Opened;
  surveyUrl: (session: TeamSession) => string | null;
}>) {
  const { model, run, t, failure, setFailure } = writes;
  const close = () => {
    opened.setEdit(null);
    setFailure(null);
  };
  const save = (body: SessionBody) => {
    const path = edit?.id == null ? "" : `/${edit.id}`;
    void run(edit?.id == null ? "POST" : "PUT", path, body, () => t("sessions.page.saved")).then(
      (ok) => {
        if (ok) close();
      },
    );
  };
  return (
    <>
      {edit === null ? null : (
        <SessionForm
          key={edit.id ?? "new"}
          language={language}
          initial={edit.draft}
          editing={edit.id !== null}
          zone={ready.event.zone}
          window={ready.event.window}
          quests={ready.quests}
          busy={model.busy}
          problem={failure}
          cancel={close}
          save={save}
        />
      )}
      <SessionList
        language={language}
        sessions={ready.sessions}
        zone={ready.event.zone}
        busy={model.busy}
        surveyUrl={surveyUrl}
        actions={{
          edit: (session) =>
            opened.setEdit({ id: session.id, draft: draftOf(session, ready.event.zone) }),
          remove: opened.setRemoving,
          message: opened.setMessaging,
          toggle: (session) =>
            void run(
              "PUT",
              `/${session.id}/registration`,
              { open: !session.registrationOpen, seats: session.seats },
              () => t("sessions.page.updated"),
            ),
        }}
      />
      <SessionImportSection
        language={language}
        zone={ready.event.zone}
        window={ready.event.window}
        busy={model.busy}
        template={() => downloadText("sessions-template.csv", sessionTemplateCsv())}
        send={(parsed) =>
          run("POST", "/import", { rows: parsed.rows }, (answer) =>
            t("sessions.page.importDone", {
              count: formatNumber((answer as { created?: number }).created ?? 0, language),
            }),
          )
        }
      />
    </>
  );
}

function SessionDialogs({
  language,
  writes,
  removing,
  messaging,
  opened,
}: Readonly<{
  language: Language;
  writes: Writes;
  removing: TeamSession | null;
  messaging: TeamSession | null;
  opened: Opened;
}>) {
  const { model, run, t } = writes;
  return (
    <>
      {removing === null ? null : (
        <ConfirmDialog
          language={language}
          title={t("sessions.page.deleteTitle")}
          body={t("sessions.page.deleteBody")}
          confirmLabel={t("sessions.page.delete")}
          noteLabel={null}
          busy={model.busy}
          cancel={() => opened.setRemoving(null)}
          confirm={() => {
            void run("DELETE", `/${removing.id}`, undefined, () => t("sessions.page.deleted")).then(
              () => opened.setRemoving(null),
            );
          }}
        />
      )}
      {messaging === null ? null : (
        <SessionMessageDialog
          language={language}
          busy={model.busy}
          cancel={() => opened.setMessaging(null)}
          send={(text: MessageText) => {
            void run("POST", `/${messaging.id}/message`, text, (answer) =>
              t("sessions.page.messageSent", {
                count: formatNumber((answer as { recipients?: number }).recipients ?? 0, language),
              }),
            ).then((ok) => {
              if (ok) opened.setMessaging(null);
            });
          }}
        />
      )}
    </>
  );
}

/** The results route of the survey quest a session links to; null when it links none, or a quest of another kind. */
function surveyUrlOf(props: SessionsProps, ready: Ready, session: TeamSession): string | null {
  const linked = ready.quests.find((quest) => quest.id === session.questId);
  return linked?.type === "survey"
    ? `/v1/organizers/${props.organizerId}/events/${props.eventId}/quests/${linked.id}/survey`
    : null;
}

export function SessionsPanel(props: SessionsProps) {
  const { language } = props;
  const writes = useSessionWrites(props);
  const { model, ready, t } = writes;
  const [edit, setEdit] = useState<Edit | null>(null);
  const [messaging, setMessaging] = useState<TeamSession | null>(null);
  const [removing, setRemoving] = useState<TeamSession | null>(null);
  const opened: Opened = { setEdit, setMessaging, setRemoving };
  return (
    <>
      <Stack as="section" aria-labelledby="sessions-title">
        <PageHeader
          titleId="sessions-title"
          title={t("sessions.page.title")}
          info={infoTip(t, "sessions.page.intro")}
          actions={
            <>
              <Button
                variant="quiet"
                disabled={ready === null}
                onClick={() => ready !== null && exportReport(ready, t)}
              >
                {t("sessions.page.export")}
              </Button>
              <Button
                variant="primary"
                disabled={ready === null || model.busy}
                onClick={() => setEdit({ id: null, draft: blankSession() })}
              >
                {t("sessions.page.add")}
              </Button>
            </>
          }
        />
        <SessionsNotices writes={writes} editing={edit !== null} />
        {ready === null ? null : (
          <SessionsBody
            language={language}
            writes={writes}
            ready={ready}
            edit={edit}
            opened={opened}
            surveyUrl={(session) => surveyUrlOf(props, ready, session)}
          />
        )}
      </Stack>
      <SessionDialogs
        language={language}
        writes={writes}
        removing={removing}
        messaging={messaging}
        opened={opened}
      />
    </>
  );
}
