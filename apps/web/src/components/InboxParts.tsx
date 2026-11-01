"use client";

import {
  formatNumber,
  type EventTicketKind,
  type Inbox,
  type Language,
  type MessageKey,
} from "@questify/shared";
import { useEffect, useState } from "react";
import { useTranslator } from "#src/components/TermsScope.tsx";
import {
  INBOX_KINDS,
  INBOX_ROWS,
  helpDeskLink,
  kindTitleKey,
  previewOf,
  whenOf,
  withQuestifyLink,
} from "#src/lib/inbox.ts";
import { handleOf } from "#src/lib/players.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { reportedLine, type TeamTicket } from "#src/lib/tickets.ts";
import { ButtonLink } from "#src/ui/Button.tsx";
import { Figure, PanelGrid, Tile } from "#src/ui/Charts.tsx";
import { EmptyState, Muted, Notice } from "#src/ui/Feedback.tsx";
import { Row, Rows, Section } from "#src/ui/Section.tsx";
import { TextLink } from "#src/ui/Text.tsx";

type Counted = Readonly<{
  key: string;
  title: MessageKey;
  count: number;
  href: string;
}>;

/** The tiles in the order the page shows them; the join queue only for an event that takes requests or holds some. */
function tilesOf(inbox: Inbox, eventBase: string, withRequests: boolean): readonly Counted[] {
  const tiles: Counted[] = INBOX_KINDS.map((kind) => ({
    key: kind,
    title: kindTitleKey(kind),
    count: inbox.tickets[kind],
    href: helpDeskLink(eventBase, kind),
  }));
  tiles.push({
    key: "withQuestify",
    title: "inbox.withQuestify",
    count: inbox.withQuestify,
    href: withQuestifyLink(eventBase),
  });
  if (withRequests) {
    tiles.push({
      key: "requests",
      title: "requests.title",
      count: inbox.joinRequests.pending,
      href: "#requests-title",
    });
  }
  tiles.push(
    {
      key: "submissions",
      title: "submissions.title",
      count: inbox.submissions,
      href: `${eventBase}/submissions`,
    },
    { key: "flags", title: "flags.title", count: inbox.flags, href: `${eventBase}/flags` },
  );
  return tiles;
}

/** The counts as equal tiles, each number a link to the list it counts. */
export function InboxTiles({
  language,
  inbox,
  eventBase,
  withRequests,
}: Readonly<{ language: Language; inbox: Inbox; eventBase: string; withRequests: boolean }>) {
  const t = useTranslator(language);
  return (
    <PanelGrid kind="tiles">
      {tilesOf(inbox, eventBase, withRequests).map((tile) => (
        <Tile key={tile.key} title={t(tile.title)}>
          <Figure>
            <TextLink
              href={tile.href}
              aria-label={t("inbox.openList", {
                title: t(tile.title),
                count: formatNumber(tile.count, language),
              })}
            >
              {formatNumber(tile.count, language)}
            </TextLink>
          </Figure>
        </Tile>
      ))}
    </PanelGrid>
  );
}

type Waiting =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "failed" }>
  | Readonly<{ status: "ready"; tickets: readonly TeamTicket[] }>;

/**
 * The oldest open requests of one kind (the Help desk's own read, five of them), read when the page has counted some and
 * again when the count changes. Nothing is read for a kind nobody is waiting on.
 */
function useWaiting(eventApi: string, kind: EventTicketKind, count: number): Waiting {
  const [state, setState] = useState<Waiting>({ status: "loading" });
  useEffect(() => {
    if (count === 0) {
      return;
    }
    let current = true;
    void requestJson(
      "GET",
      `${eventApi}/tickets?status=open&kind=${kind}&limit=${INBOX_ROWS}`,
    ).then((result) => {
      if (!current) {
        return;
      }
      const tickets = result.ok ? (result.body as { tickets?: TeamTicket[] }).tickets : undefined;
      setState(tickets === undefined ? { status: "failed" } : { status: "ready", tickets });
    });
    return () => {
      current = false;
    };
  }, [eventApi, kind, count]);
  return count === 0 ? { status: "ready", tickets: [] } : state;
}

function WaitingRow({
  language,
  ticket,
  playersPage,
  helpPage,
}: Readonly<{ language: Language; ticket: TeamTicket; playersPage: string; helpPage: string }>) {
  const t = useTranslator(language);
  const reported = reportedLine(ticket, language);
  const sender =
    ticket.username === null ? t("tickets.deletedAccount") : handleOf(ticket.username, language);
  return (
    <Row
      main={
        <>
          {ticket.username === null ? (
            <strong>{sender}</strong>
          ) : (
            <TextLink href={playersPage} dir="auto">
              {sender}
            </TextLink>
          )}
          {reported === null ? null : <Muted dir="auto">{reported}</Muted>}
          <Muted dir="auto">{previewOf(ticket.text)}</Muted>
          <Muted>
            <time dateTime={ticket.createdAt} dir="ltr">
              {whenOf(ticket.createdAt)}
            </time>
          </Muted>
        </>
      }
    >
      <TextLink
        href={helpPage}
        {...(ticket.username === null
          ? {}
          : { "aria-label": t("inbox.openRequest", { username: ticket.username }) })}
      >
        {t("inbox.open")}
      </TextLink>
    </Row>
  );
}

/**
 * A card of the oldest requests of one kind: five rows, "View more" to the Help desk's list when there are more, and a
 * line that says nothing is waiting when there are none. Replying, solving and escalating are the Help desk's.
 */
export function WaitingCard({
  language,
  eventApi,
  eventBase,
  kind,
  count,
  title,
}: Readonly<{
  language: Language;
  eventApi: string;
  eventBase: string;
  kind: EventTicketKind;
  count: number;
  title: MessageKey;
}>) {
  const t = useTranslator(language);
  const waiting = useWaiting(eventApi, kind, count);
  const helpPage = helpDeskLink(eventBase, kind);
  return (
    <Section
      level={3}
      title={t(title)}
      actions={
        count > INBOX_ROWS ? (
          <ButtonLink
            variant="quiet"
            size="sm"
            href={helpPage}
            aria-label={t("inbox.viewMoreOf", { title: t(title) })}
          >
            {t("inbox.viewMore")}
          </ButtonLink>
        ) : undefined
      }
    >
      {count === 0 ? <EmptyState>{t("inbox.empty")}</EmptyState> : null}
      {count > 0 && waiting.status === "loading" ? <Muted>{t("common.loading")}</Muted> : null}
      {waiting.status === "failed" ? (
        <Notice tone="danger" role="alert">
          {t("inbox.listFailed")}
        </Notice>
      ) : null}
      {waiting.status === "ready" && waiting.tickets.length > 0 ? (
        <Rows>
          {waiting.tickets.map((ticket) => (
            <WaitingRow
              key={ticket.id}
              language={language}
              ticket={ticket}
              playersPage={`${eventBase}/players`}
              helpPage={helpPage}
            />
          ))}
        </Rows>
      ) : null}
    </Section>
  );
}
