"use client";

import { formatNumber, type Language } from "@questify/shared";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { GUESTS_PER_UPLOAD, guestLines } from "#src/lib/joining.ts";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import { Button } from "#src/ui/Button.tsx";
import { Badge, Muted, Notice } from "#src/ui/Feedback.tsx";
import { Field, Form, Input, Textarea } from "#src/ui/Field.tsx";
import { Card, CardList, Section, Toolbar } from "#src/ui/Section.tsx";
import { infoTip } from "#src/ui/info.tsx";

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
  const t = useTranslator(language);
  return (
    <Notice tone="info" as="div" role="status">
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
    </Notice>
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
  const t = useTranslator(language);
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
      <Form onSubmit={(event) => void add(event)}>
        <Field label={t("guests.paste")}>
          <Textarea
            dir="ltr"
            rows={6}
            value={text}
            disabled={busy}
            aria-invalid={tooMany}
            onChange={(typed) => setText(typed.target.value)}
          />
        </Field>
        <Field label={t("guests.tag")} info={infoTip(t, "guests.tagHint")}>
          <Input
            dir="auto"
            maxLength={30}
            value={tag}
            disabled={busy}
            onChange={(typed) => setTag(typed.target.value)}
          />
        </Field>
        {tooMany ? (
          <Notice tone="danger" role="alert">
            {t("guests.tooMany", { max: formatNumber(GUESTS_PER_UPLOAD, language) })}
          </Notice>
        ) : null}
        <Button
          variant="primary"
          type="submit"
          disabled={busy || lines.length === 0 || tooMany}
          aria-busy={busy}
        >
          {t("guests.add")}
        </Button>
      </Form>
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
  const t = useTranslator(language);
  return (
    <CardList>
      {guests.map((guest) => (
        <Card as="li" key={guest.id}>
          <Toolbar>
            {/* A masked phone or email reads left to right inside Arabic text. */}
            <bdi dir="ltr">{guest.value}</bdi>
            {guest.tag === null ? null : (
              <Badge>
                <bdi>{guest.tag}</bdi>
              </Badge>
            )}
            <Button
              variant="quiet"
              disabled={busy}
              aria-label={`${t("guests.remove")} ${guest.value}`}
              onClick={() => remove(guest)}
            >
              {t("guests.remove")}
            </Button>
          </Toolbar>
        </Card>
      ))}
    </CardList>
  );
}

/** The listed guests (or the one found) and the total, read once and after each change; a lost session signs out. */
function useGuestList(base: string, language: Language) {
  const t = useTranslator(language);
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
  const t = useTranslator(language);
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
    <Section title={t("guests.title")} titleId="guests-title" info={infoTip(t, "guests.intro")}>
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
        <Notice tone="danger" role="alert">
          {list.problem}
        </Notice>
      )}
      {guests === null ? (
        <Muted>{t("common.loading")}</Muted>
      ) : (
        <Muted>
          {total === 0
            ? t("guests.empty")
            : t("guests.count", { count: formatNumber(total, language) })}
        </Muted>
      )}
      <Form role="search" onSubmit={(event) => void find(event)}>
        <Field label={t("guests.find")}>
          <Input
            dir="ltr"
            maxLength={320}
            value={search}
            onChange={(typed) => setSearch(typed.target.value)}
          />
        </Field>
        <Button variant="quiet" type="submit">
          {t("guests.findButton")}
        </Button>
      </Form>
      {searched !== null && guests !== null && guests.length === 0 ? (
        <Muted role="status">{t("guests.notFound")}</Muted>
      ) : null}
      <GuestRows
        language={language}
        guests={guests ?? []}
        busy={busy}
        remove={(guest) => void remove(guest)}
      />
    </Section>
  );
}
