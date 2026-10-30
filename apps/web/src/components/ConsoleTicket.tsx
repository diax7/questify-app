"use client";

import { TICKET_TEXT_MAX, type Language } from "@questify/shared";
import { useEffect, useRef, useState } from "react";
import { problemOf } from "#src/components/PlayerAwards.tsx";
import { nameIn } from "#src/lib/console.ts";
import {
  deviceLine,
  readConsoleTicket,
  type ConsoleTicketDetail,
} from "#src/lib/console-tickets.ts";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { answeredByLine, canReply, kindKey, outcomeKey } from "#src/lib/tickets.ts";
import { Button } from "#src/ui/Button.tsx";
import { Badge, Muted, Notice } from "#src/ui/Feedback.tsx";
import { Field, Textarea } from "#src/ui/Field.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Card, Stack, Toolbar } from "#src/ui/Section.tsx";
import { TextLink } from "#src/ui/Text.tsx";

type Act = (path: "answer" | "return", payload: object) => Promise<void>;

/** Reply, Solve and (an escalated ticket only) Send back with a note; one key per action, kept on a failure. */
function Actions({
  language,
  ticket,
  act,
  busy,
}: Readonly<{ language: Language; ticket: ConsoleTicketDetail; act: Act; busy: boolean }>) {
  const t = translatorFor(language);
  const [reply, setReply] = useState("");
  const [note, setNote] = useState("");
  const solve = () => {
    if (window.confirm(t("tickets.solveConfirm"))) {
      void act("answer", {});
    }
  };
  return (
    <Card>
      <Field label={t("console.tickets.reply")}>
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
          onClick={() => void act("answer", { reply: reply.trim() })}
        >
          {t("tickets.send")}
        </Button>
        <Button variant="quiet" disabled={busy} onClick={solve}>
          {t("tickets.solve")}
        </Button>
      </Toolbar>
      {ticket.event === null ? null : (
        <>
          <Field label={t("console.tickets.returnNote")}>
            <Textarea
              dir="auto"
              rows={2}
              maxLength={TICKET_TEXT_MAX}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </Field>
          <Button
            variant="quiet"
            disabled={busy || !canReply(note)}
            onClick={() => void act("return", { note: note.trim() })}
          >
            {t("console.tickets.return")}
          </Button>
        </>
      )}
    </Card>
  );
}

function Facts({
  language,
  ticket,
}: Readonly<{ language: Language; ticket: ConsoleTicketDetail }>) {
  const t = translatorFor(language);
  return (
    <>
      <Toolbar>
        <Badge>{t(kindKey(ticket.kind))}</Badge>
        <Badge>{t(outcomeKey(ticket))}</Badge>
        {ticket.username === null ? null : (
          <span dir="auto">{t("console.tickets.from", { username: ticket.username })}</span>
        )}
      </Toolbar>
      {ticket.event === null ? null : (
        <Muted dir="auto">
          {ticket.event.organizerName ?? ""} · {nameIn(ticket.event.name, language)}
        </Muted>
      )}
      {ticket.reportedUsername === null ? null : (
        <p dir="auto">{t("tickets.reported", { username: ticket.reportedUsername })}</p>
      )}
      {ticket.device === null ? null : (
        <Muted dir="ltr">
          {t("console.tickets.device")}: {deviceLine(ticket.device)}
        </Muted>
      )}
      {ticket.escalation === null ? null : (
        <Muted dir="auto">
          {t("console.tickets.teamNote", { note: ticket.escalation.note })}
          {ticket.escalation.by === null
            ? null
            : ` · ${t("tickets.escalatedBy", { name: ticket.escalation.by })}`}
        </Muted>
      )}
    </>
  );
}

/**
 * One ticket of Questify's queue (T-312): the full text, the event team's note and who escalated, the device facts,
 * and Reply, Solve or Send back. Anything outside the queue is "not found", as the API answers.
 */
export function ConsoleTicket({
  language,
  ticketId,
}: Readonly<{ language: Language; ticketId: string }>) {
  const t = translatorFor(language);
  const [ticket, setTicket] = useState<ConsoleTicketDetail | null | "missing">(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const keys = useRef({ answer: crypto.randomUUID(), return: crypto.randomUUID() });
  const load = async () => {
    const result = await requestJson("GET", `/v1/admin/tickets/${ticketId}`);
    setTicket((result.ok ? readConsoleTicket(result.body) : undefined) ?? "missing");
  };
  useEffect(() => {
    void load();
  }, [ticketId]);
  const act: Act = async (path, payload) => {
    setBusy(true);
    setProblem(null);
    const result = await requestJson("POST", `/v1/admin/tickets/${ticketId}/${path}`, payload, {
      "idempotency-key": keys.current[path],
    });
    setBusy(false);
    if (!result.ok) {
      setProblem(
        result.body === undefined ? t("join.network") : problemOf(result.body, language, t),
      );
      return;
    }
    keys.current[path] = crypto.randomUUID();
    if (path === "return") {
      window.location.assign(`/${language}/console/tickets`);
      return;
    }
    await load();
  };
  return (
    <Stack as="section" aria-labelledby="console-ticket-title">
      <p>
        <TextLink href={`/${language}/console/tickets`}>{t("console.tickets.back")}</TextLink>
      </p>
      <PageHeader titleId="console-ticket-title" title={t("console.tickets.title")} />
      {ticket === null ? <Muted>{t("common.loading")}</Muted> : null}
      {ticket === "missing" ? (
        <Notice tone="danger" role="alert">
          {t("console.tickets.notFound")}
        </Notice>
      ) : null}
      {ticket === null || ticket === "missing" ? null : (
        <>
          <Facts language={language} ticket={ticket} />
          <p dir="auto">{ticket.text}</p>
          {ticket.reply === null ? null : <Muted dir="auto">{ticket.reply}</Muted>}
          {ticket.status === "closed" ? (
            <Muted>
              {answeredByLine(
                {
                  answeredBy: { kind: "admin", name: null, deleted: false },
                  outcome: ticket.outcome,
                },
                language,
              )}
            </Muted>
          ) : (
            <Actions language={language} ticket={ticket} act={act} busy={busy} />
          )}
        </>
      )}
      {problem === null ? null : (
        <Notice tone="danger" role="alert">
          {problem}
        </Notice>
      )}
    </Stack>
  );
}
