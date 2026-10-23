"use client";

import { formatNumber, type Language } from "@questify/shared";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { GUESTS_PER_UPLOAD, guestLines } from "#src/lib/joining.ts";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import styles from "#src/components/layout.module.css";

type Guest = Readonly<{ id: string; kind: "phone" | "email"; value: string; tag: string | null }>;

type Added = Readonly<{
  added: number;
  existing: number;
  tagged: number;
  invalid: readonly Readonly<{ line: number; text: string }>[];
  total: number;
}>;

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);

type Props = Readonly<{ language: Language; organizerId: string; eventId: string }>;

/** What an upload did: added, already there, newly tagged, and the lines that are not a contact. */
function AddedResult({ language, result }: Readonly<{ language: Language; result: Added }>) {
  const t = translatorFor(language);
  return (
    <div role="status" className={styles.notice}>
      <p>
        {t("guests.result", {
          added: formatNumber(result.added, language),
          existing: formatNumber(result.existing, language),
        })}
      </p>
      {result.tagged === 0 ? null : (
        <p>{t("guests.tagged", { count: formatNumber(result.tagged, language) })}</p>
      )}
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
  );
}

/**
 * The paste box (FR-132): the lines and an optional tag for all of them (ADR-172), then what the upload did. Tagged
 * contacts are on the guest list, so they are invited (the hint says so).
 */
function GuestUpload({
  language,
  base,
  busy,
  setBusy,
  clear,
  fail,
  added,
}: Readonly<{
  language: Language;
  base: string;
  busy: boolean;
  setBusy: (busy: boolean) => void;
  clear: () => void;
  fail: (body: unknown) => void;
  added: () => Promise<void>;
}>) {
  const t = translatorFor(language);
  const [text, setText] = useState("");
  const [tag, setTag] = useState("");
  const [result, setResult] = useState<Added | null>(null);
  const lines = guestLines(text);
  const tooMany = lines.length > GUESTS_PER_UPLOAD;

  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    clear();
    setResult(null);
    const answer = await requestJson("POST", base, {
      lines,
      ...(tag.trim() === "" ? {} : { tag }),
    });
    setBusy(false);
    if (!answer.ok) {
      fail(answer.body);
      return;
    }
    setResult(answer.body as Added);
    setText("");
    await added();
  };

  return (
    <>
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
        <label className={styles.field}>
          <span>{t("guests.tag")}</span>
          <input
            className={styles.input}
            dir="auto"
            maxLength={30}
            value={tag}
            disabled={busy}
            aria-describedby="guests-tag-hint"
            onChange={(typed) => setTag(typed.target.value)}
          />
        </label>
        <p id="guests-tag-hint" className={styles.muted}>
          {t("guests.tagHint")}
        </p>
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
      {result === null ? null : <AddedResult language={language} result={result} />}
    </>
  );
}

/** The newest guests, masked, each with its tag and a Remove button. */
function GuestRows({
  language,
  guests,
  busy,
  remove,
}: Readonly<{
  language: Language;
  guests: readonly Guest[];
  busy: boolean;
  remove: (guest: Guest) => void;
}>) {
  const t = translatorFor(language);
  return (
    <ul className={styles.list}>
      {guests.map((guest) => (
        <li key={guest.id} className={styles.row}>
          {/* A masked phone or email reads left to right inside Arabic text. */}
          <bdi dir="ltr">{guest.value}</bdi>
          {guest.tag === null ? null : (
            <span className={styles.badge}>
              <bdi>{guest.tag}</bdi>
            </span>
          )}
          <button
            type="button"
            className={styles.quiet}
            disabled={busy}
            aria-label={`${t("guests.remove")} ${guest.value}`}
            onClick={() => remove(guest)}
          >
            {t("guests.remove")}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The listed guests (or the one found) and the total, read once and after each change; a lost session signs out. */
function useGuestList(base: string, language: Language) {
  const t = translatorFor(language);
  const loaded = useRef(false);
  const [guests, setGuests] = useState<Guest[] | null>(null);
  const [total, setTotal] = useState(0);
  const [problem, setProblem] = useState<string | null>(null);

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

  const load = async (contact = "") => {
    const answer = await requestJson(
      "GET",
      contact === "" ? base : `${base}?contact=${encodeURIComponent(contact)}`,
    );
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

  return { guests, total, problem, setGuests, setTotal, setProblem, fail, load };
}

/**
 * The event's guest list (FR-132): paste phones and emails, see which lines were not added, see the newest entries
 * masked and remove one. Owners and editors.
 */
export function GuestsPanel({ language, organizerId, eventId }: Props) {
  const t = translatorFor(language);
  const base = `/v1/organizers/${organizerId}/events/${eventId}/join/guests`;
  const list = useGuestList(base, language);
  const { guests, total, load, fail, setProblem, setGuests, setTotal } = list;
  const [search, setSearch] = useState("");
  const [searched, setSearched] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  const find = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setProblem(null);
    const contact = search.trim();
    setSearched(contact === "" ? null : contact);
    await load(contact);
  };

  return (
    <section className={styles.panel} aria-labelledby="guests-title">
      <h2 id="guests-title" className={styles.title}>
        {t("guests.title")}
      </h2>
      <p className={styles.muted}>{t("guests.intro")}</p>
      <GuestUpload
        language={language}
        base={base}
        busy={busy}
        setBusy={setBusy}
        clear={() => setProblem(null)}
        fail={fail}
        added={() => load()}
      />
      {list.problem === null ? null : (
        <p role="alert" className={styles.alert}>
          {list.problem}
        </p>
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
      <form className={styles.row} role="search" onSubmit={(event) => void find(event)}>
        <label className={styles.field}>
          <span>{t("guests.find")}</span>
          <input
            className={styles.input}
            dir="ltr"
            maxLength={320}
            value={search}
            onChange={(typed) => setSearch(typed.target.value)}
          />
        </label>
        <button type="submit" className={styles.quiet}>
          {t("guests.findButton")}
        </button>
      </form>
      {searched !== null && guests !== null && guests.length === 0 ? (
        <p role="status" className={styles.muted}>
          {t("guests.notFound")}
        </p>
      ) : null}
      <GuestRows
        language={language}
        guests={guests ?? []}
        busy={busy}
        remove={(guest) => void remove(guest)}
      />
    </section>
  );
}
