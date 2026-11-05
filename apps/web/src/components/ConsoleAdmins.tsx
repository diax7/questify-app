"use client";

import type { AdminAccount, AdminSession, Language } from "@questify/shared";
import { formatNumber } from "@questify/shared";
import { useState } from "react";
import {
  ConfirmedButton,
  Problem,
  ReasonField,
  keyed,
  reasonReady,
  useWrite,
} from "#src/components/ConsoleOversight.tsx";
import { EndAllSessions } from "#src/components/ConsoleEndSessions.tsx";
import styles from "#src/components/health.module.css";
import { clockOf } from "#src/lib/console-organizers.ts";
import {
  ADMINS_API,
  adminSessionsPath,
  endSessionPath,
  readAdminAccounts,
  readAdminSessions,
} from "#src/lib/console-platform.ts";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { useConsoleRead } from "#src/lib/use-console-read.ts";
import { Button } from "#src/ui/Button.tsx";
import { Badge, Muted, Notice } from "#src/ui/Feedback.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Card, CardList, Row, Rows, Stack, SubHeading, Toolbar } from "#src/ui/Section.tsx";
import { infoTip } from "#src/ui/info.tsx";

/** Ends one session after a reason and one confirmation (ADR-063). The API refuses the session that asks. */
function EndSession({
  language,
  email,
  session,
  onEnded,
}: Readonly<{
  language: Language;
  email: string;
  session: AdminSession;
  onEnded: (done: string) => void;
}>) {
  const t = translatorFor(language);
  const [reason, setReason] = useState("");
  const { busy, problem, run } = useWrite(language, onEnded);
  return (
    <Stack>
      <Problem problem={problem} />
      <ReasonField
        language={language}
        label="console.admins.reason"
        reason={reason}
        change={setReason}
      />
      <ConfirmedButton
        language={language}
        label={t("console.admins.end")}
        question={t("console.admins.endConfirm", { email })}
        variant="danger"
        disabled={busy || !reasonReady(reason)}
        act={() =>
          void run(
            () =>
              requestJson("POST", endSessionPath(session.id), { reason: reason.trim() }, keyed()),
            t("console.admins.ended"),
          )
        }
      />
    </Stack>
  );
}

function SessionLine({
  language,
  email,
  session,
  onEnded,
}: Readonly<{
  language: Language;
  email: string;
  session: AdminSession;
  onEnded: (done: string) => void;
}>) {
  const t = translatorFor(language);
  return (
    <Row
      main={
        <Stack>
          <div className={styles.line} data-testid="admin-session">
            <span className={styles.agent} dir="ltr">
              {session.userAgent ?? "-"}
            </span>
            <Muted as="span">
              {session.ip === null ? null : (
                <>
                  <bdi dir="ltr">{session.ip}</bdi>
                  {" · "}
                </>
              )}
              {t("console.admins.started", { time: clockOf(session.createdAt, language) })}
              {" · "}
              {t("console.admins.lastSeen", { time: clockOf(session.lastSeenAt, language) })}
            </Muted>
            {session.current ? <Badge tone="info">{t("console.admins.current")}</Badge> : null}
          </div>
          {session.current ? null : (
            <EndSession language={language} email={email} session={session} onEnded={onEnded} />
          )}
        </Stack>
      }
    />
  );
}

/** One admin's open sessions, read when the card opens. */
function Sessions({
  language,
  account,
  onEnded,
}: Readonly<{ language: Language; account: AdminAccount; onEnded: (done: string) => void }>) {
  const t = translatorFor(language);
  const { state, reload } = useConsoleRead(adminSessionsPath(account.id), readAdminSessions);
  return (
    <div id={`sessions-${account.id}`} data-testid="admin-sessions">
      {state.kind === "loading" ? <Muted role="status">{t("common.loading")}</Muted> : null}
      {state.kind === "failed" ? (
        <Notice tone="danger" role="alert">
          {t("console.admins.loadFailed")}
        </Notice>
      ) : null}
      {state.kind === "ready" && state.value.length === 0 ? (
        <Muted>{t("console.admins.noSessions")}</Muted>
      ) : null}
      {state.kind === "ready" && state.value.length > 0 ? (
        <Rows>
          {state.value.map((session) => (
            <SessionLine
              key={session.id}
              language={language}
              email={account.email}
              session={session}
              onEnded={(done) => {
                void reload().then(() => onEnded(done));
              }}
            />
          ))}
        </Rows>
      ) : null}
    </div>
  );
}

function AdminCard({
  language,
  account,
  onEnded,
}: Readonly<{ language: Language; account: AdminAccount; onEnded: (done: string) => void }>) {
  const t = translatorFor(language);
  const [open, setOpen] = useState(false);
  return (
    <Card as="li" data-testid="admin-account">
      <Stack>
        <SubHeading as="h2">
          <bdi dir="ltr">{account.email}</bdi>{" "}
          <Badge tone={account.status === "active" ? "success" : "danger"}>
            {t(`console.admins.status.${account.status}`)}
          </Badge>
        </SubHeading>
        <Muted>
          {t("console.admins.sessions", { count: formatNumber(account.sessions, language) })}
          {account.lastSeenAt === null
            ? ""
            : ` · ${t("console.admins.lastSeen", { time: clockOf(account.lastSeenAt, language) })}`}
        </Muted>
        <Toolbar>
          <Button
            aria-expanded={open}
            aria-controls={`sessions-${account.id}`}
            onClick={() => setOpen(!open)}
          >
            {open ? t("console.admins.hide") : t("console.admins.show")}
          </Button>
        </Toolbar>
        <EndAllSessions
          language={language}
          staffUserId={account.id}
          email={account.email}
          onEnded={onEnded}
        />
        {open ? <Sessions language={language} account={account} onEnded={onEnded} /> : null}
      </Stack>
    </Card>
  );
}

/**
 * The console's admin accounts (T-709, FR-1785): every Questify platform admin with the sessions they have open, and a
 * forced sign-out for any session but the one asking, with a reason that goes in the audit log. Admin rights themselves
 * are granted and removed only from the command line (ADR-405). Platform admins only.
 */
export function ConsoleAdmins({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const { state, reload } = useConsoleRead(ADMINS_API, readAdminAccounts);
  const [done, setDone] = useState<string | null>(null);
  return (
    <Stack as="section" aria-labelledby="console-admins-title">
      <PageHeader
        titleId="console-admins-title"
        title={t("console.admins.title")}
        info={infoTip(t, "console.admins.intro")}
      />
      {done === null ? null : (
        <Notice tone="success" role="status">
          {done}
        </Notice>
      )}
      {state.kind === "loading" ? <Muted role="status">{t("common.loading")}</Muted> : null}
      {state.kind === "failed" ? (
        <Notice tone="danger" role="alert">
          {t("console.admins.loadFailed")}{" "}
          <Button size="sm" onClick={() => void reload()}>
            {t("common.retry")}
          </Button>
        </Notice>
      ) : null}
      {state.kind === "ready" && state.value.length === 0 ? (
        <Muted>{t("console.admins.empty")}</Muted>
      ) : null}
      {state.kind === "ready" && state.value.length > 0 ? (
        <CardList>
          {state.value.map((account) => (
            <AdminCard
              key={account.id}
              language={language}
              account={account}
              onEnded={(message) => {
                setDone(message);
                void reload();
              }}
            />
          ))}
        </CardList>
      ) : null}
    </Stack>
  );
}
