"use client";

import { formatNumber, type Language } from "@questify/shared";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import styles from "#src/components/layout.module.css";

type Kind = "phone" | "email_domain";

type Exclusion = Readonly<{ id: string; kind: Kind; value: string }>;

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);

type Props = Readonly<{
  language: Language;
  organizerId: string;
  eventId: string;
  myRole: "owner" | "editor";
}>;

/**
 * The event's exclusion list (FR-319): phones and email domains that never appear on the boards. The owner adds and
 * removes entries; the team sees them, phones as their last four digits (the API masks them for everyone).
 */
export function ExclusionsPanel({ language, organizerId, eventId, myRole }: Props) {
  const t = translatorFor(language);
  const base = `/v1/organizers/${organizerId}/events/${eventId}/exclusions`;
  const loaded = useRef(false);
  const [entries, setEntries] = useState<Exclusion[] | null>(null);
  const [kind, setKind] = useState<Kind>("phone");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const failed = (body: unknown, fallback: "exclusions.loadFailed" | "players.saveFailed") => {
    const code = errorCodeOf(body);
    if (code !== undefined && SESSION_LOST.has(code)) {
      window.location.assign(`/${language}/sign-in?ended=1`);
      return;
    }
    setProblem(code === undefined ? t(fallback) : describeProblem(body, language, t).text);
  };

  const load = async () => {
    const result = await requestJson("GET", base);
    if (!result.ok) {
      failed(result.body, "exclusions.loadFailed");
      return;
    }
    setEntries((result.body as { exclusions: Exclusion[] }).exclusions);
  };

  useEffect(() => {
    // Stryker disable next-line ConditionalExpression,BlockStatement: React runs effects twice in development only
    if (loaded.current) {
      return;
    }
    loaded.current = true;
    void load();
  });

  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    const result = await requestJson("POST", base, { kind, value });
    setBusy(false);
    if (!result.ok) {
      failed(result.body, "players.saveFailed");
      return;
    }
    const added = (result.body as { exclusion: Exclusion }).exclusion;
    setEntries((current) => [added, ...(current ?? []).filter((entry) => entry.id !== added.id)]);
    setValue("");
  };

  const remove = async (entry: Exclusion) => {
    setBusy(true);
    setProblem(null);
    const result = await requestJson("DELETE", `${base}/${entry.id}`);
    setBusy(false);
    if (!result.ok) {
      failed(result.body, "players.saveFailed");
      return;
    }
    setEntries((current) => (current ?? []).filter((row) => row.id !== entry.id));
  };

  return (
    <section className={styles.panel} aria-labelledby="exclusions-title">
      <h2 id="exclusions-title" className={styles.title}>
        {t("exclusions.title")}
      </h2>
      <p className={styles.muted}>{t("exclusions.intro")}</p>
      {myRole === "owner" ? (
        <form className={styles.form} onSubmit={(event) => void add(event)}>
          <label className={styles.field}>
            <span>{t("exclusions.kind")}</span>
            <select
              className={styles.input}
              value={kind}
              disabled={busy}
              onChange={(changed) => setKind(changed.target.value as Kind)}
            >
              <option value="phone">{t("exclusions.phone")}</option>
              <option value="email_domain">{t("exclusions.domain")}</option>
            </select>
          </label>
          <label className={styles.field}>
            <span>{t("exclusions.value")}</span>
            <input
              className={styles.input}
              dir="ltr"
              required
              maxLength={260}
              autoComplete="off"
              value={value}
              disabled={busy}
              onChange={(changed) => setValue(changed.target.value)}
            />
          </label>
          <button type="submit" className={styles.button} disabled={busy} aria-busy={busy}>
            {t("exclusions.add")}
          </button>
        </form>
      ) : (
        <p className={styles.muted}>{t("exclusions.ownerOnly")}</p>
      )}
      {problem === null ? null : (
        <p role="alert" className={styles.alert}>
          {problem}
        </p>
      )}
      {entries === null ? (
        <p className={styles.muted}>{t("common.loading")}</p>
      ) : (
        <p className={styles.muted}>
          {entries.length === 0
            ? t("exclusions.empty")
            : t("exclusions.count", { count: formatNumber(entries.length, language) })}
        </p>
      )}
      <ul className={styles.list}>
        {(entries ?? []).map((entry) => (
          <li key={entry.id} className={styles.row}>
            <span className={styles.badge}>
              {t(entry.kind === "phone" ? "exclusions.phone" : "exclusions.domain")}
            </span>
            {/* A masked phone and a domain read left to right inside Arabic text. */}
            <bdi dir="ltr">{entry.value}</bdi>
            {myRole === "owner" ? (
              <button
                type="button"
                className={styles.quiet}
                disabled={busy}
                aria-label={`${t("exclusions.remove")} ${entry.value}`}
                onClick={() => void remove(entry)}
              >
                {t("exclusions.remove")}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
