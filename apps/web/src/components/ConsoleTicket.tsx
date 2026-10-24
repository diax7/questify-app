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
import styles from "#src/components/layout.module.css";

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
    <div className={styles.formCard}>
      <label className={styles.field}>
        <span>{t("console.tickets.reply")}</span>
        <textarea
          className={styles.input}
          dir="auto"
          rows={3}
          maxLength={TICKET_TEXT_MAX}
          value={reply}
          onChange={(event) => setReply(event.target.value)}
        />
      </label>
      <button
        type="button"
        className={styles.button}
        disabled={busy || !canReply(reply)}
        onClick={() => void act("answer", { reply: reply.trim() })}
      >
        {t("tickets.send")}
      </button>
      <button type="button" className={styles.quiet} disabled={busy} onClick={solve}>
        {t("tickets.solve")}
      </button>
      {ticket.event === null ? null : (
        <>
          <label className={styles.field}>
            <span>{t("console.tickets.returnNote")}</span>
            <textarea
              className={styles.input}
              dir="auto"
              rows={2}
              maxLength={TICKET_TEXT_MAX}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <button
            type="button"
            className={styles.quiet}
            disabled={busy || !canReply(note)}
            onClick={() => void act("return", { note: note.trim() })}
          >
            {t("console.tickets.return")}
          </button>
        </>
      )}
    </div>
  );
}

function Facts({
  language,
  ticket,
}: Readonly<{ language: Language; ticket: ConsoleTicketDetail }>) {
  const t = translatorFor(language);
  return (
    <>
      <p className={styles.row}>
        <span className={styles.badge}>{t(kindKey(ticket.kind))}</span>
        <span className={styles.badge}>{t(outcomeKey(ticket))}</span>
        {ticket.username === null ? null : (
          <span dir="auto">{t("console.tickets.from", { username: ticket.username })}</span>
        )}
      </p>
      {ticket.event === null ? null : (
        <p className={styles.muted} dir="auto">
          {ticket.event.organizerName ?? ""} · {nameIn(ticket.event.name, language)}
        </p>
      )}
      {ticket.reportedUsername === null ? null : (
        <p dir="auto">{t("tickets.reported", { username: ticket.reportedUsername })}</p>
      )}
      {ticket.device === null ? null : (
        <p className={styles.muted} dir="ltr">
          {t("console.tickets.device")}: {deviceLine(ticket.device)}
        </p>
      )}
      {ticket.escalation === null ? null : (
        <p className={styles.muted} dir="auto">
          {t("console.tickets.teamNote", { note: ticket.escalation.note })}
          {ticket.escalation.by === null
            ? null
            : ` · ${t("tickets.escalatedBy", { name: ticket.escalation.by })}`}
        </p>
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
    <section className={styles.panel} aria-labelledby="console-ticket-title">
      <p>
        <a className={styles.textLink} href={`/${language}/console/tickets`}>
          {t("console.tickets.back")}
        </a>
      </p>
      <h1 id="console-ticket-title" className={styles.title}>
        {t("console.tickets.title")}
      </h1>
      {ticket === null ? <p className={styles.muted}>{t("common.loading")}</p> : null}
      {ticket === "missing" ? (
        <p role="alert" className={styles.alert}>
          {t("console.tickets.notFound")}
        </p>
      ) : null}
      {ticket === null || ticket === "missing" ? null : (
        <>
          <Facts language={language} ticket={ticket} />
          <p dir="auto">{ticket.text}</p>
          {ticket.reply === null ? null : (
            <p dir="auto" className={styles.muted}>
              {ticket.reply}
            </p>
          )}
          {ticket.status === "closed" ? (
            <p className={styles.muted}>
              {answeredByLine(
                {
                  answeredBy: { kind: "admin", name: null, deleted: false },
                  outcome: ticket.outcome,
                },
                language,
              )}
            </p>
          ) : (
            <Actions language={language} ticket={ticket} act={act} busy={busy} />
          )}
        </>
      )}
      {problem === null ? null : (
        <p role="alert" className={styles.alert}>
          {problem}
        </p>
      )}
    </section>
  );
}
