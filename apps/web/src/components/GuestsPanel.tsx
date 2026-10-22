"use client";

import { formatNumber, type Language } from "@questify/shared";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { GUESTS_PER_UPLOAD, guestLines } from "#src/lib/joining.ts";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import styles from "#src/components/layout.module.css";

type Guest = Readonly<{ id: string; kind: "phone" | "email"; value: string }>;

type Added = Readonly<{
  added: number;
  existing: number;
  invalid: readonly Readonly<{ line: number; text: string }>[];
  total: number;
}>;

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);

type Props = Readonly<{ language: Language; organizerId: string; eventId: string }>;

/**
 * The event's guest list (FR-132): paste phones and emails, see which lines were not added, see the newest entries
 * masked and remove one. Owners and editors.
 */
export function GuestsPanel({ language, organizerId, eventId }: Props) {
  const t = translatorFor(language);
  const base = `/v1/organizers/${organizerId}/events/${eventId}/join/guests`;
  const loaded = useRef(false);
  const [guests, setGuests] = useState<Guest[] | null>(null);
  const [total, setTotal] = useState(0);
  const [text, setText] = useState("");
  const [result, setResult] = useState<Added | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const lines = guestLines(text);

  const fail = (body: unknown) => {
    const code = errorCodeOf(body);
    if (code !== undefined && SESSION_LOST.has(code)) {
      window.location.assign(`/${language}/sign-in?ended=1`);
      return;
    }
    setProblem(
      code === undefined ? t("players.saveFailed") : describeProblem(body, language, t).text,
    );
  };

  const load = async () => {
    const answer = await requestJson("GET", base);
    if (!answer.ok) {
      fail(answer.body);
      return;
    }
    const body = answer.body as { total: number; guests: Guest[] };
    setGuests(body.guests);
    setTotal(body.total);
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
    setResult(null);
    const answer = await requestJson("POST", base, { lines });
    setBusy(false);
    if (!answer.ok) {
      fail(answer.body);
      return;
    }
    setResult(answer.body as Added);
    setText("");
    await load();
  };

  const remove = async (guest: Guest) => {
    setBusy(true);
    setProblem(null);
    const answer = await requestJson("DELETE", `${base}/${guest.id}`);
    setBusy(false);
    if (!answer.ok) {
      fail(answer.body);
      return;
    }
    setGuests((current) => (current ?? []).filter((row) => row.id !== guest.id));
    setTotal((count) => count - 1);
  };

  const tooMany = lines.length > GUESTS_PER_UPLOAD;
  return (
    <section className={styles.panel} aria-labelledby="guests-title">
      <h2 id="guests-title" className={styles.title}>
        {t("guests.title")}
      </h2>
      <p className={styles.muted}>{t("guests.intro")}</p>
      <form className={styles.form} onSubmit={(event) => void add(event)}>
        <label className={styles.field}>
          <span>{t("guests.paste")}</span>
          <textarea
            className={styles.input}
            dir="ltr"
            rows={6}
            value={text}
            disabled={busy}
            aria-invalid={tooMany}
            onChange={(typed) => setText(typed.target.value)}
          />
        </label>
        {tooMany ? (
          <p role="alert" className={styles.alert}>
            {t("guests.tooMany", { max: formatNumber(GUESTS_PER_UPLOAD, language) })}
          </p>
        ) : null}
        <button
          type="submit"
          className={styles.button}
          disabled={busy || lines.length === 0 || tooMany}
          aria-busy={busy}
        >
          {t("guests.add")}
        </button>
      </form>
      {problem === null ? null : (
        <p role="alert" className={styles.alert}>
          {problem}
        </p>
      )}
      {result === null ? null : (
        <div role="status" className={styles.notice}>
          <p>
            {t("guests.result", {
              added: formatNumber(result.added, language),
              existing: formatNumber(result.existing, language),
            })}
          </p>
          {result.invalid.length === 0 ? null : (
            <>
              <p>{t("guests.invalid")}</p>
              <ul>
                {result.invalid.map((bad) => (
                  <li key={bad.line}>
                    <bdi dir="ltr">
                      {t("guests.line", { line: formatNumber(bad.line, language), text: bad.text })}
                    </bdi>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
      {guests === null ? (
        <p className={styles.muted}>{t("common.loading")}</p>
      ) : (
        <p className={styles.muted}>
          {total === 0
            ? t("guests.empty")
            : t("guests.count", { count: formatNumber(total, language) })}
        </p>
      )}
      <ul className={styles.list}>
        {(guests ?? []).map((guest) => (
          <li key={guest.id} className={styles.row}>
            {/* A masked phone or email reads left to right inside Arabic text. */}
            <bdi dir="ltr">{guest.value}</bdi>
            <button
              type="button"
              className={styles.quiet}
              disabled={busy}
              aria-label={`${t("guests.remove")} ${guest.value}`}
              onClick={() => void remove(guest)}
            >
              {t("guests.remove")}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
