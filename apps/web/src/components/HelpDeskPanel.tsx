"use client";

import {
  EVENT_TICKET_KINDS,
  TICKET_TEXT_MAX,
  type Language,
  type TicketKind,
} from "@questify/shared";
import { useEffect, useRef, useState } from "react";
import { problemOf } from "#src/components/PlayerAwards.tsx";
import { translatorFor } from "#src/lib/language.ts";
import { handleOf } from "#src/lib/players.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { textFor } from "#src/lib/quests.ts";
import {
  TABS,
  TAB_KEYS,
  answeredByLine,
  canReply,
  kindKey,
  outcomeKey,
  reportedLine,
  tabCount,
  ticketQuery,
  type TeamTicket,
  type TicketPage,
  type TicketTab,
} from "#src/lib/tickets.ts";
import { Button } from "#src/ui/Button.tsx";
import { Badge, EmptyState, Muted, Notice } from "#src/ui/Feedback.tsx";
import { Field, Select, Textarea } from "#src/ui/Field.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Card, CardList, Stack, Toolbar } from "#src/ui/Section.tsx";
import { Tabs } from "#src/ui/Tabs.tsx";
import { TextLink } from "#src/ui/Text.tsx";

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);

/** One tab's requests, page by page, with both tabs' counts. */
function useTickets(
  eventApi: string,
  tab: TicketTab,
  kind: TicketKind | null,
  onFailure: (body: unknown) => void,
) {
  const [tickets, setTickets] = useState<TeamTicket[] | null>(null);
  const [counts, setCounts] = useState<TicketPage["counts"] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const loadedFor = useRef<string | null>(null);
  const load = async (cursor: string | null) => {
    const result = await requestJson("GET", `${eventApi}/tickets${ticketQuery(tab, kind, cursor)}`);
    if (!result.ok) {
      onFailure(result.body);
      return;
    }
    const page = result.body as TicketPage;
    setTickets((current) =>
      cursor === null ? page.tickets : [...(current ?? []), ...page.tickets],
    );
    setCounts(page.counts);
    setNext(page.nextCursor);
  };
  useEffect(() => {
    const wanted = `${tab}:${kind ?? ""}`;
    // Stryker disable next-line ConditionalExpression,BlockStatement: React runs effects twice in development only
    if (loadedFor.current === wanted) {
      return;
    }
    loadedFor.current = wanted;
    setTickets(null);
    void load(null);
  });
  return {
    tickets,
    counts,
    reload: () => void load(null),
    more: next === null ? null : () => void load(next),
  };
}

/** Reply (one reply closes it) or Solved with a confirm; one key per answer, kept on a failure. */
function AnswerActions({
  language,
  eventApi,
  ticket,
  done,
}: Readonly<{ language: Language; eventApi: string; ticket: TeamTicket; done: () => void }>) {
  const t = translatorFor(language);
  const [reply, setReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const key = useRef(crypto.randomUUID());
  const send = async (payload: object) => {
    setBusy(true);
    setProblem(null);
    const result = await requestJson("POST", `${eventApi}/tickets/${ticket.id}/answer`, payload, {
      "idempotency-key": key.current,
    });
    setBusy(false);
    if (result.ok) {
      key.current = crypto.randomUUID();
      done();
      return;
    }
    // Kept on a failure: trying again cannot answer twice.
    setProblem(result.body === undefined ? t("join.network") : problemOf(result.body, language, t));
  };
  const solve = () => {
    if (window.confirm(t("tickets.solveConfirm"))) {
      void send({});
    }
  };
  return (
    <Card>
      <Field label={t("tickets.reply")}>
        <Textarea
          dir="auto"
          rows={3}
          maxLength={TICKET_TEXT_MAX}
          value={reply}
          onChange={(event) => setReply(event.target.value)}
        />
      </Field>
      <Toolbar>
        <Button
          variant="primary"
          disabled={busy || !canReply(reply)}
          onClick={() => void send({ reply: reply.trim() })}
        >
          {t("tickets.send")}
        </Button>
        <Button variant="quiet" disabled={busy} onClick={solve}>
          {t("tickets.solve")}
        </Button>
      </Toolbar>
      {problem === null ? null : (
        <Notice tone="danger" role="alert">
          {problem}
        </Notice>
      )}
    </Card>
  );
}

/** Escalate to Questify (owners and editors, T-312): a note of what the team tried is required, then a confirm. */
function EscalateAction({
  language,
  eventApi,
  ticket,
  done,
}: Readonly<{ language: Language; eventApi: string; ticket: TeamTicket; done: () => void }>) {
  const t = translatorFor(language);
  const [opened, setOpened] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const key = useRef(crypto.randomUUID());
  const send = async () => {
    if (!window.confirm(t("tickets.escalate.confirm"))) {
      return;
    }
    setBusy(true);
    setProblem(null);
    const result = await requestJson(
      "POST",
      `${eventApi}/tickets/${ticket.id}/escalate`,
      { note: note.trim() },
      { "idempotency-key": key.current },
    );
    setBusy(false);
    if (result.ok) {
      key.current = crypto.randomUUID();
      done();
      return;
    }
    setProblem(result.body === undefined ? t("join.network") : problemOf(result.body, language, t));
  };
  if (!opened) {
    return (
      <Button variant="quiet" onClick={() => setOpened(true)}>
        {t("tickets.escalate")}
      </Button>
    );
  }
  return (
    <Card>
      <Field label={t("tickets.escalate.note")}>
        <Textarea
          dir="auto"
          rows={3}
          maxLength={TICKET_TEXT_MAX}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </Field>
      <Button variant="primary" disabled={busy || !canReply(note)} onClick={() => void send()}>
        {t("tickets.escalate.send")}
      </Button>
      {problem === null ? null : (
        <Notice tone="danger" role="alert">
          {problem}
        </Notice>
      )}
    </Card>
  );
}

/** What Questify has to do with a ticket: the team's note while it waits there, and the note it sent back. */
function QuestifyLines({ language, ticket }: Readonly<{ language: Language; ticket: TeamTicket }>) {
  const t = translatorFor(language);
  const escalated = ticket.queue === "questify" && ticket.escalation !== null;
  return (
    <>
      {escalated && ticket.escalation !== null ? (
        <Muted dir="auto">
          {t("tickets.escalatedNote", { note: ticket.escalation.note })}
          {ticket.escalation.by === null
            ? null
            : ` · ${t("tickets.escalatedBy", { name: ticket.escalation.by })}`}
        </Muted>
      ) : null}
      {ticket.queue === "event" && ticket.status === "open" && ticket.returned !== null ? (
        <Muted dir="auto" data-testid="returned">
          {t("tickets.returned", { note: ticket.returned.note })}
        </Muted>
      ) : null}
    </>
  );
}

function TicketRow({
  language,
  eventApi,
  playersPage,
  ticket,
  done,
}: Readonly<{
  language: Language;
  eventApi: string;
  playersPage: string;
  ticket: TeamTicket;
  done: () => void;
}>) {
  const t = translatorFor(language);
  const by = answeredByLine(ticket, language);
  const reported = reportedLine(ticket, language);
  const answerable = ticket.status === "open" && ticket.queue === "event";
  return (
    <Card as="li" data-testid="ticket">
      <Toolbar>
        <Badge>{t(kindKey(ticket.kind))}</Badge>
        {ticket.username === null ? (
          <strong>{t("tickets.deletedAccount")}</strong>
        ) : (
          <TextLink href={playersPage} dir="auto">
            {handleOf(ticket.username, language)}
          </TextLink>
        )}
        <span dir="auto">
          {ticket.quest === null ? t("tickets.eventWide") : textFor(ticket.quest.title, language)}
        </span>
        <time dateTime={ticket.createdAt} dir="ltr">
          {new Date(ticket.createdAt).toLocaleString(
            language === "ar" ? "ar-SA-u-nu-latn" : "en-GB",
          )}
        </time>
        {ticket.marked ? <Badge>{t("tickets.marked")}</Badge> : null}
        <Badge>
          {ticket.status === "open" && ticket.queue === "questify"
            ? t("help.status.withQuestify")
            : t(outcomeKey(ticket))}
        </Badge>
      </Toolbar>
      {reported === null ? null : (
        <p dir="auto">
          <TextLink href={playersPage}>{reported}</TextLink>
        </p>
      )}
      <p dir="auto">{ticket.text}</p>
      <QuestifyLines language={language} ticket={ticket} />
      {ticket.reply === null ? null : <Muted dir="auto">{ticket.reply}</Muted>}
      {by === null ? null : <Muted>{by}</Muted>}
      {answerable ? (
        <>
          <AnswerActions language={language} eventApi={eventApi} ticket={ticket} done={done} />
          <EscalateAction language={language} eventApi={eventApi} ticket={ticket} done={done} />
        </>
      ) : null}
    </Card>
  );
}

type Props = Readonly<{ language: Language; organizerId: string; eventId: string }>;

/**
 * The event's Help desk (T-310, T-312, FR-337 to FR-339, FR-1823): Open (oldest first), With Questify (escalated,
 * read-only, with the team's note) and Closed (newest first, Questify's answers signed "the Questify team"), a kind
 * filter, each with the player's @username, the quest, the time and the text; Reply, Solved, or Escalate to Questify
 * with a note. A ticket Questify sent back shows its note. A report names the reported member.
 */
export function HelpDeskPanel({ language, organizerId, eventId }: Props) {
  const t = translatorFor(language);
  const eventApi = `/v1/organizers/${organizerId}/events/${eventId}`;
  const playersPage = `/${language}/organizers/${organizerId}/events/${eventId}/players`;
  const [tab, setTab] = useState<TicketTab>("open");
  const [kind, setKind] = useState<TicketKind | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const list = useTickets(eventApi, tab, kind, (body) => {
    const code = (body as { code?: unknown } | undefined)?.code;
    if (typeof code === "string" && SESSION_LOST.has(code)) {
      window.location.assign(`/${language}/sign-in?ended=1`);
      return;
    }
    setProblem(body === undefined ? t("join.network") : problemOf(body, language, t));
  });
  return (
    <Stack as="section" aria-labelledby="tickets-title">
      <PageHeader titleId="tickets-title" title={t("tickets.page")} />
      <Tabs
        label={t("tickets.page")}
        items={TABS.map((name) => ({
          key: name,
          label: t(TAB_KEYS[name], { count: tabCount(list.counts, name) }),
          current: tab === name,
          select: () => setTab(name),
        }))}
      />
      <Field label={t("tickets.kindFilter")}>
        <Select
          value={kind ?? ""}
          onChange={(event) =>
            setKind(event.target.value === "" ? null : (event.target.value as TicketKind))
          }
        >
          <option value="">{t("tickets.allKinds")}</option>
          {EVENT_TICKET_KINDS.map((name) => (
            <option key={name} value={name}>
              {t(kindKey(name))}
            </option>
          ))}
        </Select>
      </Field>
      {problem === null ? null : (
        <Notice tone="danger" role="alert">
          {problem}
        </Notice>
      )}
      {list.tickets === null && problem === null ? <Muted>{t("common.loading")}</Muted> : null}
      {list.tickets?.length === 0 ? <EmptyState>{t("tickets.empty")}</EmptyState> : null}
      <CardList>
        {(list.tickets ?? []).map((ticket) => (
          <TicketRow
            key={ticket.id}
            language={language}
            eventApi={eventApi}
            playersPage={playersPage}
            ticket={ticket}
            done={list.reload}
          />
        ))}
      </CardList>
      {list.more === null ? null : (
        <Button variant="quiet" onClick={list.more}>
          {t("tickets.more")}
        </Button>
      )}
    </Stack>
  );
}
