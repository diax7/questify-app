"use client";

import { formatNumber, type Language, type PlayerRecord } from "@questify/shared";
import { useState, type ReactNode } from "react";
import {
  BanPanel,
  RenamePanel,
  ResetPanel,
  RevealPanel,
} from "#src/components/ConsolePlayerActions.tsx";
import { PlayerConsent, PlayerLedger } from "#src/components/ConsolePlayerLedger.tsx";
import { MaskedContacts } from "#src/components/ConsolePlayers.tsx";
import { nameIn } from "#src/lib/console.ts";
import { clockOf } from "#src/lib/console-organizers.ts";
import { codeLabel, playerPath, readRecord } from "#src/lib/console-players.ts";
import { translatorFor, type Translate } from "#src/lib/language.ts";
import { useConsoleRead } from "#src/lib/use-console-read.ts";
import { Button } from "#src/ui/Button.tsx";
import { Badge, Muted, Notice } from "#src/ui/Feedback.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Row, Rows, Section, Stack } from "#src/ui/Section.tsx";

type Props = Readonly<{ language: Language; record: PlayerRecord }>;

function changedLine(t: Translate, record: PlayerRecord, language: Language): string {
  const changed = record.contactsChanged;
  if (changed === null) {
    return t("console.player.neverChanged");
  }
  const key = `console.player.changed.${changed.channel === "phone" ? "phone" : "email"}.${
    changed.kind === "added" ? "added" : "replaced"
  }` as const;
  return t(key, { date: clockOf(changed.at, language) });
}

function ProfileSection({ language, record }: Props) {
  const t = translatorFor(language);
  return (
    <Section title={t("console.player.profile")}>
      <Stack>
        <span>
          {t("console.player.level", {
            level: formatNumber(record.player.level, language),
            xp: formatNumber(record.player.xp, language),
          })}
        </span>
        <Muted as="span">
          {t("console.players.joined", { date: clockOf(record.player.createdAt, language) })}
          {" · "}
          {t("console.player.signedIn", { count: formatNumber(record.sessions, language) })}
        </Muted>
        <SubList title={t("console.player.usernames")} empty="">
          {record.usernames.map((entry) => (
            <Row
              key={`${entry.changedAt}-${entry.username}`}
              main={
                <span>
                  <bdi dir="auto">@{entry.username}</bdi>
                  {" · "}
                  {t(`console.player.username.${entry.reason}`)}
                  {" · "}
                  {clockOf(entry.changedAt, language)}
                </span>
              }
            />
          ))}
        </SubList>
      </Stack>
    </Section>
  );
}

/** A titled list, or a line that says there is nothing. */
function SubList({
  title,
  empty,
  level = 3,
  children,
}: Readonly<{ title: string; empty: string; level?: 2 | 3; children: ReactNode[] }>) {
  return (
    <Section title={title} level={level}>
      {children.length === 0 ? <Muted>{empty}</Muted> : <Rows>{children}</Rows>}
    </Section>
  );
}

function EventsSection({ language, record }: Props) {
  const t = translatorFor(language);
  const eventName = (id: string): string =>
    nameIn(
      record.events.find((one) => one.eventId === id)?.event ?? { ar: null, en: null },
      language,
    );
  return (
    <>
      <SubList title={t("console.player.events")} empty={t("console.player.noEvents")} level={2}>
        {record.events.map((one) => (
          <Row
            key={one.eventId}
            main={
              <Stack>
                <bdi>{nameIn(one.event, language)}</bdi>
                <Muted as="span">
                  {t("console.player.eventLine", {
                    organizer: one.organizer,
                    status: codeLabel(t, "console.player.enrollment", one.status),
                    score: formatNumber(one.score, language),
                    date: clockOf(one.joinedAt, language),
                  })}
                  {one.excluded ? (
                    <>
                      {" "}
                      <Badge tone="danger">{t("console.player.excluded")}</Badge>
                    </>
                  ) : null}
                </Muted>
              </Stack>
            }
          />
        ))}
      </SubList>
      <SubList title={t("console.player.flags")} empty={t("console.player.noFlags")} level={2}>
        {record.flags.map((flag) => (
          <Row
            key={flag.id}
            main={
              <span>
                {codeLabel(t, "console.player.flag", flag.kind)}
                {" · "}
                {codeLabel(t, "console.player.flag", flag.status)}
                {" · "}
                <bdi>{eventName(flag.eventId)}</bdi>
                {" · "}
                {clockOf(flag.raisedAt, language)}
              </span>
            }
          />
        ))}
      </SubList>
      <SubList title={t("console.player.reports")} empty={t("console.player.noReports")} level={2}>
        {record.reports.map((report) => (
          <Row
            key={report.eventId}
            main={t("console.player.reportLine", {
              event: eventName(report.eventId),
              total: formatNumber(report.total, language),
              open: formatNumber(report.open, language),
            })}
          />
        ))}
      </SubList>
    </>
  );
}

function ActionsSection({ language, record }: Props) {
  const t = translatorFor(language);
  return (
    <SubList title={t("console.player.actions")} empty={t("console.player.noActions")} level={2}>
      {record.actions.map((action) => (
        <Row
          key={action.id}
          main={
            <Stack>
              <span>
                {codeLabel(t, "console.player.action", action.kind)}
                {action.fromUsername === null || action.toUsername === null ? null : (
                  <>
                    {": "}
                    <bdi dir="auto">@{action.fromUsername}</bdi>
                    {language === "ar" ? " ← " : " → "}
                    <bdi dir="auto">@{action.toUsername}</bdi>
                  </>
                )}
                {" · "}
                {codeLabel(t, "console.player.reason", action.reasonCode)}
              </span>
              <span dir="auto">{action.note}</span>
              <Muted as="span">
                {t("console.player.actionBy", {
                  by: action.by,
                  date: clockOf(action.at, language),
                })}
              </Muted>
            </Stack>
          }
        />
      ))}
    </SubList>
  );
}

function PlayerView({
  language,
  record,
  reload,
}: Props & Readonly<{ reload: (done: string | null) => void }>) {
  const t = translatorFor(language);
  const id = record.player.id;
  return (
    <>
      <ProfileSection language={language} record={record} />
      <Section title={t("console.player.contacts")}>
        <Stack>
          <MaskedContacts phone={record.contacts.phone} email={record.contacts.email} />
          <Muted>{changedLine(t, record, language)}</Muted>
          <RevealPanel language={language} playerId={id} onChanged={() => reload(null)} />
        </Stack>
      </Section>
      <PlayerConsent language={language} playerId={id} />
      <EventsSection language={language} record={record} />
      <PlayerLedger language={language} playerId={id} events={record.events} />
      <ActionsSection language={language} record={record} />
      <RenamePanel
        language={language}
        playerId={id}
        username={record.player.username}
        onChanged={reload}
      />
      <ResetPanel
        language={language}
        playerId={id}
        username={record.player.username}
        onChanged={reload}
      />
      <BanPanel
        language={language}
        playerId={id}
        username={record.player.username}
        banned={record.player.status === "banned"}
        onChanged={reload}
      />
    </>
  );
}

/**
 * One player in the console (T-704, FR-1774, FR-1775, FR-1702): the read-only record (masked contacts, username
 * history, events, flags, reports, sign-ins, Questify's own actions, the points record) and three actions that each
 * need a reason: show the full contacts, change the username, reset the sign-in. Every look is audited by the API. An
 * erased account shows that it was deleted and nothing else.
 */
export function ConsolePlayer({
  language,
  playerId,
}: Readonly<{ language: Language; playerId: string }>) {
  const t = translatorFor(language);
  const { state, reload } = useConsoleRead(playerPath(playerId), readRecord);
  const [done, setDone] = useState<string | null>(null);
  const back = { href: `/${language}/console/players`, label: t("console.player.back") };
  if (state.kind !== "ready") {
    return (
      <Stack as="section" aria-labelledby="console-player-title">
        <PageHeader title={t("console.players.title")} titleId="console-player-title" back={back} />
        {state.kind === "loading" ? <Muted role="status">{t("common.loading")}</Muted> : null}
        {state.kind === "failed" ? (
          <Notice tone="danger" role="alert">
            {t("console.player.loadFailed")}{" "}
            <Button size="sm" onClick={() => void reload()}>
              {t("common.retry")}
            </Button>
          </Notice>
        ) : null}
      </Stack>
    );
  }
  const record = state.value;
  if (!("contacts" in record)) {
    return (
      <Stack as="section" aria-labelledby="console-player-title">
        <PageHeader
          title={t("console.player.erasedTitle")}
          titleId="console-player-title"
          back={back}
        />
        <Notice tone="info" role="status">
          {t("console.player.erased", {
            date: clockOf(record.player.deletedAt ?? record.player.createdAt, language),
          })}
        </Notice>
      </Stack>
    );
  }
  return (
    <Stack as="section" aria-labelledby="console-player-title">
      <PageHeader
        title={<bdi dir="auto">@{record.player.username}</bdi>}
        titleId="console-player-title"
        back={back}
        meta={
          <Badge tone={record.player.status === "banned" ? "danger" : "neutral"}>
            {t(`console.players.status.${record.player.status}`)}
          </Badge>
        }
      />
      {done === null ? null : (
        <Notice tone="success" role="status">
          {done}
        </Notice>
      )}
      <PlayerView
        language={language}
        record={record}
        reload={(message) => {
          setDone(message);
          void reload();
        }}
      />
    </Stack>
  );
}
