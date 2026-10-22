"use client";

import { formatEventTime, type Language } from "@questify/shared";
import { useCallback, useEffect, useState } from "react";
import { addonName, limitLine } from "#src/lib/activation.ts";
import {
  limitBodyOf,
  missingField,
  nameIn,
  readConsoleEvent,
  type ConsoleEvent as ConsoleEventView,
  type LimitDraft,
} from "#src/lib/console.ts";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson, type PostResult } from "#src/lib/post-json.ts";
import { describeProblem } from "#src/lib/sign-in-errors.ts";
import styles from "#src/components/layout.module.css";

type Props = Readonly<{ language: Language; eventId: string }>;
type Loaded = Readonly<{ view: ConsoleEventView; available: readonly string[] }>;

/**
 * One event in the console (FR-1021, FR-1402, FR-1729): activate a draft with a limit and add-ons, reject a request
 * with a note, or change the limit and add-ons of an activated event. Nothing is charged here (FR-1020).
 */
export function ConsoleEvent({ language, eventId }: Props) {
  const t = translatorFor(language);
  const path = `/v1/admin/events/${eventId}`;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const result = await requestJson("GET", path);
    const body = result.body as { event?: unknown; availableAddons?: unknown } | undefined;
    const view = result.ok ? readConsoleEvent(body?.event) : undefined;
    const available = body?.availableAddons;
    if (view === undefined || !Array.isArray(available)) {
      setProblem(describeProblem(result.body, language, translatorFor(language)).text);
      return;
    }
    setLoaded({ view, available: available.filter((item) => typeof item === "string") });
  }, [path, language]);

  useEffect(() => {
    void load();
  }, [load]);

  const send = async (work: () => Promise<PostResult>, done: string) => {
    setBusy(true);
    setNotice(null);
    const result = await work();
    setBusy(false);
    if (!result.ok) {
      const missing = missingField(result.body);
      setProblem(
        missing === undefined
          ? describeProblem(result.body, language, t).text
          : t(`console.missing.${missing}`),
      );
      return;
    }
    setProblem(null);
    setNotice(done);
    await load();
  };

  if (loaded === null) {
    return problem === null ? (
      <p className={styles.muted}>{t("common.loading")}</p>
    ) : (
      <p role="alert" className={styles.alert}>
        {problem}
      </p>
    );
  }
  const { view, available } = loaded;
  return (
    <section className={styles.panel} aria-labelledby="console-event-title">
      <EventFacts language={language} view={view} />
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
      {view.state === "activated" ? (
        <ActivatedPanel
          language={language}
          view={view}
          available={available}
          busy={busy}
          saveLimit={(draft) =>
            void send(
              () => requestJson("PUT", `${path}/limit`, limitBodyOf(draft)),
              t("console.limitSaved"),
            )
          }
          toggle={(feature, on) =>
            void send(
              () => requestJson(on ? "PUT" : "DELETE", `${path}/addons/${feature}`),
              t("console.addonsSaved"),
            )
          }
        />
      ) : (
        <ActivateForm
          language={language}
          name={nameIn(view.event.name, language)}
          available={available}
          granted={view.addons}
          busy={busy}
          canReject={view.state === "requested"}
          activate={(draft, addons) =>
            void send(
              () =>
                requestJson(
                  "POST",
                  `${path}/activate`,
                  { limit: limitBodyOf(draft), addons },
                  { "idempotency-key": crypto.randomUUID() },
                ),
              t("console.activated"),
            )
          }
          reject={(note) =>
            void send(() => requestJson("POST", `${path}/reject`, { note }), t("console.rejected"))
          }
        />
      )}
    </section>
  );
}

/** Who and when: the event's name, state, join code, organizer, owner, start, and the request's time. */
function EventFacts({ language, view }: Readonly<{ language: Language; view: ConsoleEventView }>) {
  const t = translatorFor(language);
  const { event } = view;
  return (
    <>
      <a className={styles.textLink} href={`/${language}/console`}>
        {t("console.back")}
      </a>
      <h1 id="console-event-title" className={styles.title}>
        {nameIn(event.name, language)}
      </h1>
      <p className={styles.row}>
        <span className={styles.badge}>
          {t(`events.status.${event.statusNow}` as "events.status.draft")}
        </span>
        <span dir="ltr">{t("events.joinCode", { code: event.joinCode })}</span>
      </p>
      <p className={styles.muted}>{t("console.organizer", { name: event.organizer.name })}</p>
      {event.ownerEmail === null ? null : (
        <p className={styles.muted}>{t("console.owner", { email: event.ownerEmail })}</p>
      )}
      {event.startsAt === null ? null : (
        <p className={styles.muted}>
          {formatEventTime(new Date(event.startsAt), event.timezone, language)}
        </p>
      )}
      {view.state === "requested" && view.requestedAt !== null ? (
        <p className={styles.notice}>
          {t("console.requestedAt", {
            date: formatEventTime(new Date(view.requestedAt), event.timezone, language),
          })}
        </p>
      ) : null}
    </>
  );
}

/** An activated event: its limit and players, the limit form, and the add-on switches. */
function ActivatedPanel({
  language,
  view,
  available,
  busy,
  saveLimit,
  toggle,
}: Readonly<{
  language: Language;
  view: ConsoleEventView;
  available: readonly string[];
  busy: boolean;
  saveLimit: (draft: LimitDraft) => void;
  toggle: (feature: string, on: boolean) => void;
}>) {
  const t = translatorFor(language);
  const limit = limitLine(view);
  return (
    <>
      <p>{t(limit.key, limit.params)}</p>
      <p className={styles.muted}>{t("activation.players", { count: view.players })}</p>
      <LimitForm language={language} initial={view.limit} busy={busy} submit={saveLimit} />
      <AddonToggles
        language={language}
        available={available}
        chosen={view.addons}
        busy={busy}
        toggle={toggle}
      />
    </>
  );
}

function LimitFields({
  language,
  draft,
  change,
}: Readonly<{ language: Language; draft: LimitDraft; change: (draft: LimitDraft) => void }>) {
  const t = translatorFor(language);
  return (
    <fieldset className={styles.choices}>
      <legend>{t("console.limit")}</legend>
      {(["hard", "soft", "none"] as const).map((mode) => (
        <label key={mode} className={styles.check}>
          <input
            type="radio"
            name="limit-mode"
            checked={draft.mode === mode}
            onChange={() => change({ ...draft, mode })}
          />
          {t(`console.limit.${mode}`)}
        </label>
      ))}
      {draft.mode === "none" ? null : (
        <label className={styles.field}>
          {t("console.limitNumber")}
          <input
            className={styles.input}
            dir="ltr"
            inputMode="numeric"
            value={draft.value}
            onChange={(changed) => change({ ...draft, value: changed.target.value })}
          />
        </label>
      )}
    </fieldset>
  );
}

function LimitForm({
  language,
  initial,
  busy,
  submit,
}: Readonly<{
  language: Language;
  initial: ConsoleEventView["limit"];
  busy: boolean;
  submit: (draft: LimitDraft) => void;
}>) {
  const t = translatorFor(language);
  const [draft, setDraft] = useState<LimitDraft>({
    mode: initial.mode,
    value: initial.value === null ? "" : String(initial.value),
  });
  return (
    <div className={styles.form}>
      <LimitFields language={language} draft={draft} change={setDraft} />
      <button type="button" className={styles.button} disabled={busy} onClick={() => submit(draft)}>
        {t("console.saveLimit")}
      </button>
    </div>
  );
}

function AddonToggles({
  language,
  available,
  chosen,
  busy,
  toggle,
}: Readonly<{
  language: Language;
  available: readonly string[];
  chosen: readonly string[];
  busy: boolean;
  toggle: (feature: string, on: boolean) => void;
}>) {
  const t = translatorFor(language);
  return (
    <fieldset className={styles.choices}>
      <legend>{t("console.addons")}</legend>
      {available.map((feature) => (
        <label key={feature} className={styles.check}>
          <input
            type="checkbox"
            checked={chosen.includes(feature)}
            disabled={busy}
            onChange={(changed) => toggle(feature, changed.target.checked)}
          />
          {addonName(feature, t)}
        </label>
      ))}
    </fieldset>
  );
}

function ActivateForm({
  language,
  name,
  available,
  granted,
  busy,
  canReject,
  activate,
  reject,
}: Readonly<{
  language: Language;
  name: string;
  available: readonly string[];
  /** Add-ons the draft already has: activation keeps exactly the ticked ones, so they start ticked. */
  granted: readonly string[];
  busy: boolean;
  canReject: boolean;
  activate: (draft: LimitDraft, addons: string[]) => void;
  reject: (note: string) => void;
}>) {
  const t = translatorFor(language);
  const [draft, setDraft] = useState<LimitDraft>({ mode: "hard", value: "" });
  const [addons, setAddons] = useState<string[]>([...granted]);
  const [note, setNote] = useState("");
  const [confirming, setConfirming] = useState(false);
  return (
    <div className={styles.form}>
      <LimitFields language={language} draft={draft} change={setDraft} />
      <fieldset className={styles.choices}>
        <legend>{t("console.addons")}</legend>
        {available.map((feature) => (
          <label key={feature} className={styles.check}>
            <input
              type="checkbox"
              checked={addons.includes(feature)}
              onChange={(changed) =>
                setAddons((current) =>
                  changed.target.checked
                    ? [...current, feature]
                    : current.filter((item) => item !== feature),
                )
              }
            />
            {addonName(feature, t)}
          </label>
        ))}
      </fieldset>
      <p className={styles.muted}>{t("console.nothingCharged")}</p>
      {confirming ? (
        <div role="alertdialog" aria-labelledby="activate-confirm" className={styles.card}>
          <p id="activate-confirm">{t("console.confirmActivate", { name })}</p>
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.quiet}
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className={styles.button}
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                activate(draft, addons);
              }}
            >
              {t("console.activate")}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className={styles.button}
          disabled={busy}
          onClick={() => setConfirming(true)}
        >
          {t("console.activate")}
        </button>
      )}
      {canReject ? (
        <>
          <label className={styles.field}>
            {t("console.note")}
            <textarea
              className={styles.input}
              maxLength={500}
              value={note}
              onChange={(changed) => setNote(changed.target.value)}
            />
          </label>
          <button
            type="button"
            className={styles.quiet}
            disabled={busy || note.trim() === ""}
            onClick={() => reject(note.trim())}
          >
            {t("console.reject")}
          </button>
        </>
      ) : null}
    </div>
  );
}
