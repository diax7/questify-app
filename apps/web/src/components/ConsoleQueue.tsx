"use client";

import { formatEventTime, type Language } from "@questify/shared";
import { useEffect, useState, type FormEvent } from "react";
import { nameIn, readQueue, type QueueItem } from "#src/lib/console.ts";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem } from "#src/lib/sign-in-errors.ts";
import styles from "#src/components/layout.module.css";

/** The console's activation queue, oldest first, and a way to open any event by its join code (FR-1021). */
export function ConsoleQueue({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const [queue, setQueue] = useState<QueueItem[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [code, setCode] = useState("");

  useEffect(() => {
    void (async () => {
      const result = await requestJson("GET", "/v1/admin/activation-requests");
      const rows = result.ok ? readQueue(result.body) : undefined;
      if (rows === undefined) {
        setProblem(describeProblem(result.body, language, translatorFor(language)).text);
        return;
      }
      setQueue(rows);
    })();
  }, [language]);

  const lookup = async (submitted: FormEvent) => {
    submitted.preventDefault();
    const trimmed = code.trim();
    if (!/^[A-Za-z0-9]{4,12}$/.test(trimmed)) {
      setProblem(t("console.notFound"));
      return;
    }
    const result = await requestJson("GET", `/v1/admin/events?code=${trimmed}`);
    const eventId = (result.body as { eventId?: unknown } | undefined)?.eventId;
    if (!result.ok || typeof eventId !== "string") {
      setProblem(t("console.notFound"));
      return;
    }
    window.location.assign(`/${language}/console/events/${eventId}`);
  };

  return (
    <section className={styles.panel} aria-labelledby="queue-title">
      <h1 id="queue-title" className={styles.title}>
        {t("console.queue")}
      </h1>
      {problem === null ? null : (
        <p role="alert" className={styles.alert}>
          {problem}
        </p>
      )}
      <form className={styles.form} onSubmit={(submitted) => void lookup(submitted)}>
        <label className={styles.field}>
          {t("console.lookup")}
          <input
            className={styles.input}
            dir="ltr"
            value={code}
            maxLength={12}
            autoComplete="off"
            onChange={(changed) => setCode(changed.target.value)}
          />
        </label>
        <button type="submit" className={styles.button}>
          {t("console.open")}
        </button>
      </form>
      {queue === null ? (
        problem === null ? (
          <p className={styles.muted}>{t("common.loading")}</p>
        ) : null
      ) : queue.length === 0 ? (
        <p className={styles.muted}>{t("console.queueEmpty")}</p>
      ) : (
        <ul className={styles.list}>
          {queue.map((item) => (
            <li key={item.eventId}>
              <a className={styles.textLink} href={`/${language}/console/events/${item.eventId}`}>
                {nameIn(item.name, language)}
              </a>
              <span className={styles.muted}> · {item.organizer} · </span>
              <span className={styles.muted}>
                {t("console.requestedAt", {
                  date: formatEventTime(new Date(item.requestedAt), item.timezone, language),
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
