"use client";

import { formatEventTime, formatNumber, type Language, type TeamSession } from "@questify/shared";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { Button } from "#src/ui/Button.tsx";
import { Badge, EmptyState, Muted } from "#src/ui/Feedback.tsx";
import { Row, Rows } from "#src/ui/Section.tsx";

export type SessionActions = Readonly<{
  edit: (session: TeamSession) => void;
  remove: (session: TeamSession) => void;
  message: (session: TeamSession) => void;
  toggle: (session: TeamSession) => void;
}>;

export function sessionTitle(session: TeamSession, language: Language): string {
  const [first, second] =
    language === "ar" ? [session.titleAr, session.titleEn] : [session.titleEn, session.titleAr];
  return first ?? second ?? "";
}

function sessionPlace(session: TeamSession, language: Language): string | null {
  return language === "ar"
    ? (session.placeAr ?? session.placeEn)
    : (session.placeEn ?? session.placeAr);
}

function SessionFacts({
  session,
  zone,
  language,
}: Readonly<{ session: TeamSession; zone: string; language: Language }>) {
  const t = useTranslator(language);
  const count = (value: number) => formatNumber(value, language);
  const place = sessionPlace(session, language);
  const starts = formatEventTime(new Date(session.startsAt), zone, language);
  const ends = formatEventTime(new Date(session.endsAt), zone, language);
  const registered =
    session.seats === null
      ? count(session.registered)
      : t("sessions.page.seatsOf", {
          registered: count(session.registered),
          seats: count(session.seats),
        });
  const numbers =
    session.access === "registration"
      ? [
          `${t("sessions.page.registered")}: ${registered}`,
          `${t("sessions.page.attended")}: ${count(session.attended)}`,
          `${t("sessions.page.walkInCount")}: ${count(session.walkInCount)}`,
          `${t("sessions.page.noShows")}: ${count(session.noShows)}`,
        ]
      : [`${t("sessions.page.attended")}: ${count(session.attended)}`];
  return (
    <>
      <Muted>{[`${starts} - ${ends}`, place].filter((part) => part !== null).join(" | ")}</Muted>
      <Muted>{numbers.join(" | ")}</Muted>
    </>
  );
}

function SessionRowActions({
  session,
  language,
  busy,
  actions,
}: Readonly<{ session: TeamSession; language: Language; busy: boolean; actions: SessionActions }>) {
  const t = useTranslator(language);
  return (
    <>
      <Button variant="quiet" disabled={busy} onClick={() => actions.edit(session)}>
        {t("sessions.page.edit")}
      </Button>
      {session.access === "registration" ? (
        <Button variant="quiet" disabled={busy} onClick={() => actions.toggle(session)}>
          {t(
            session.registrationOpen
              ? "sessions.page.closeRegistration"
              : "sessions.page.reopenRegistration",
          )}
        </Button>
      ) : null}
      {session.registered > 0 ? (
        <Button variant="quiet" disabled={busy} onClick={() => actions.message(session)}>
          {t("sessions.page.message")}
        </Button>
      ) : null}
      <Button variant="danger" disabled={busy} onClick={() => actions.remove(session)}>
        {t("sessions.page.delete")}
      </Button>
    </>
  );
}

export function SessionList({
  language,
  sessions,
  zone,
  busy,
  actions,
}: Readonly<{
  language: Language;
  sessions: readonly TeamSession[];
  zone: string;
  busy: boolean;
  actions: SessionActions;
}>) {
  const t = useTranslator(language);
  if (sessions.length === 0) return <EmptyState>{t("sessions.page.empty")}</EmptyState>;
  return (
    <Rows>
      {sessions.map((session) => (
        <Row
          key={session.id}
          main={
            <>
              <strong>{sessionTitle(session, language)}</strong>
              <span>
                <Badge>{t(`sessions.page.kind.${session.kind}`)}</Badge>{" "}
                {session.access === "registration" && !session.registrationOpen ? (
                  <Badge tone="warning">{t("sessions.page.registrationClosed")}</Badge>
                ) : null}
              </span>
              <SessionFacts session={session} zone={zone} language={language} />
            </>
          }
        >
          <SessionRowActions session={session} language={language} busy={busy} actions={actions} />
        </Row>
      ))}
    </Rows>
  );
}
