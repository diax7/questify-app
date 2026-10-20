"use client";

import type { Language } from "@questify/shared";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  EventAccessFields,
  EventIdentityFields,
  EventTimeFields,
} from "#src/components/EventFields.tsx";
import {
  BLANK_DRAFT,
  createBodyOf,
  draftOf,
  editBodyOf,
  nameFor,
  type EventDraft,
  type EventView,
} from "#src/lib/events.ts";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson, type PostResult } from "#src/lib/post-json.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import styles from "#src/components/layout.module.css";

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);
const FIELDS = new Set(["name", "timezone", "startsAt", "endsAt", "joinMethods"]);

type Props = Readonly<{
  language: Language;
  organizerId: string;
  /** Absent for a new event. */
  eventId?: string;
  myRole: "owner" | "editor";
}>;

/** The words for a refusal: the field to fix for `invalid_event`, the API's own message otherwise. */
function problemText(body: unknown, language: Language): string {
  const t = translatorFor(language);
  const details = (body as { details?: { field?: unknown } } | undefined)?.details;
  const field = details?.field;
  if (errorCodeOf(body) === "invalid_event" && typeof field === "string" && FIELDS.has(field)) {
    return t(`events.invalid.${field}` as "events.invalid.name");
  }
  return describeProblem(body, language, t).text;
}

/**
 * One Idempotency-Key per distinct body: a retry of the same request replays the first answer, and a corrected body
 * after a refusal goes as a new request.
 */
function useIdempotencyKey(): (body: unknown) => string {
  const last = useRef<{ body: string; key: string } | null>(null);
  return (body) => {
    const text = JSON.stringify(body);
    if (last.current?.body !== text) {
      last.current = { body: text, key: crypto.randomUUID() };
    }
    return last.current.key;
  };
}

/**
 * Creates or edits an event (FR-1001–1003, FR-1608, FR-1728). Times are typed as the wall clock in the event's own
 * zone. A draft can be deleted and a live event ended by the owner, each after a confirmation naming the event.
 */
export function EventForm({ language, organizerId, eventId, myRole }: Props) {
  const t = translatorFor(language);
  const api = `/v1/organizers/${organizerId}/events`;
  const pages = `/${language}/organizers/${organizerId}/events`;
  const [event, setEvent] = useState<EventView | null>(null);
  const [draft, setDraft] = useState<EventDraft | null>(eventId === undefined ? BLANK_DRAFT : null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<"delete" | "end" | null>(null);
  const keyFor = useIdempotencyKey();
  const loaded = useRef(false);

  const handle = (result: PostResult): boolean => {
    const code = errorCodeOf(result.body);
    if (code !== undefined && SESSION_LOST.has(code)) {
      window.location.assign(`/${language}/sign-in?ended=1`);
      return false;
    }
    if (!result.ok) {
      setProblem(problemText(result.body, language));
    }
    return result.ok;
  };

  const show = (view: EventView) => {
    setEvent(view);
    setDraft(draftOf(view));
  };

  useEffect(() => {
    if (eventId === undefined || loaded.current) {
      return;
    }
    loaded.current = true;
    void requestJson("GET", `${api}/${eventId}`).then((result) => {
      if (handle(result)) {
        show((result.body as { event: EventView }).event);
      }
    });
    // Once per page, also under Strict Mode's double effect.
  }, [api, eventId]);

  const run = async (work: () => Promise<PostResult>): Promise<PostResult> => {
    setBusy(true);
    setProblem(null);
    setNotice(null);
    const result = await work();
    setBusy(false);
    return result;
  };

  const submit = async (submitted: FormEvent<HTMLFormElement>) => {
    submitted.preventDefault();
    if (draft === null) {
      return;
    }
    if (event === null) {
      const body = createBodyOf(draft);
      const result = await run(() =>
        requestJson("POST", api, body, { "idempotency-key": keyFor(body) }),
      );
      if (handle(result)) {
        window.location.assign(`${pages}/${(result.body as { event: EventView }).event.id}`);
      }
      return;
    }
    const result = await run(() =>
      requestJson("PATCH", `${api}/${event.id}`, editBodyOf(draft, draftOf(event))),
    );
    if (handle(result)) {
      show((result.body as { event: EventView }).event);
      setNotice(t("events.saved"));
    }
  };

  const confirm = async () => {
    if (event === null || confirming === null) {
      return;
    }
    const result = await run(() =>
      confirming === "delete"
        ? requestJson("DELETE", `${api}/${event.id}`)
        : requestJson("POST", `${api}/${event.id}/end`, { confirm: true }),
    );
    setConfirming(null);
    if (!handle(result)) {
      return;
    }
    if (confirming === "delete") {
      window.location.assign(pages);
      return;
    }
    setNotice(t("events.ended"));
    const fresh = await requestJson("GET", `${api}/${event.id}`);
    if (handle(fresh)) {
      show((fresh.body as { event: EventView }).event);
    }
  };

  const change = (patch: Partial<EventDraft>) =>
    setDraft((current) => (current === null ? current : { ...current, ...patch }));
  const status = event?.statusNow ?? "draft";
  const name = event === null ? "" : nameFor(event, language);

  return (
    <section className={styles.panel} aria-labelledby="event-title">
      <a className={styles.textLink} href={pages}>
        {t("events.all")}
      </a>
      <h1 id="event-title" className={styles.title}>
        {event === null ? t("events.new") : name}
      </h1>
      {event === null ? null : (
        <p className={styles.row}>
          <span className={styles.badge}>{t(`events.status.${status}`)}</span>
          <span dir="ltr">{t("events.joinCode", { code: event.joinCode })}</span>
          {status === "draft" ? (
            <span className={styles.muted}>{t("events.draftNote")}</span>
          ) : null}
          <a className={styles.textLink} href={`${pages}/${event.id}/quests`}>
            {t("quests.title")}
          </a>
        </p>
      )}
      {problem === null ? null : (
        <p role="alert" className={styles.alert}>
          {problem}
        </p>
      )}
      {notice === null ? null : (
        <p role="status" className={styles.notice}>
          {notice}
        </p>
      )}
      {draft === null ? (
        problem === null ? (
          <p className={styles.muted}>{t("common.loading")}</p>
        ) : null
      ) : (
        <form className={styles.form} onSubmit={(submitted) => void submit(submitted)}>
          <EventIdentityFields language={language} draft={draft} disabled={busy} change={change} />
          <EventTimeFields
            language={language}
            draft={draft}
            disabled={busy}
            change={change}
            status={status}
          />
          <EventAccessFields language={language} draft={draft} disabled={busy} change={change} />
          <button type="submit" className={styles.button} disabled={busy}>
            {event === null ? t("events.create") : t("events.save")}
          </button>
        </form>
      )}
      {event === null ? null : (
        <EventDangerZone
          language={language}
          name={name}
          canDelete={status === "draft"}
          canEnd={myRole === "owner" && status === "live"}
          confirming={confirming}
          busy={busy}
          ask={setConfirming}
          confirm={() => void confirm()}
        />
      )}
    </section>
  );
}

/** Delete (a draft) and end now (the owner, a live event): each asks first and names what happens. */
function EventDangerZone({
  language,
  name,
  canDelete,
  canEnd,
  confirming,
  busy,
  ask,
  confirm,
}: Readonly<{
  language: Language;
  name: string;
  canDelete: boolean;
  canEnd: boolean;
  confirming: "delete" | "end" | null;
  busy: boolean;
  ask: (what: "delete" | "end" | null) => void;
  confirm: () => void;
}>) {
  const t = translatorFor(language);
  if (confirming !== null) {
    return (
      <div role="alertdialog" aria-labelledby="confirm-title" className={styles.card}>
        <h2 id="confirm-title" className={styles.subtitle}>
          {t(confirming === "delete" ? "events.deleteTitle" : "events.endTitle")}
        </h2>
        <p>{t(confirming === "delete" ? "events.deleteBody" : "events.endBody", { name })}</p>
        <div className={styles.actions}>
          <button type="button" className={styles.quiet} disabled={busy} onClick={() => ask(null)}>
            {t("common.cancel")}
          </button>
          <button type="button" className={styles.button} disabled={busy} onClick={confirm}>
            {t(confirming === "delete" ? "events.delete" : "events.end")}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className={styles.actions}>
      {canDelete ? (
        <button
          type="button"
          className={styles.quiet}
          disabled={busy}
          onClick={() => ask("delete")}
        >
          {t("events.delete")}
        </button>
      ) : null}
      {canEnd ? (
        <button type="button" className={styles.quiet} disabled={busy} onClick={() => ask("end")}>
          {t("events.end")}
        </button>
      ) : null}
    </div>
  );
}
