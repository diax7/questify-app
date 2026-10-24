"use client";

import { formatEventTime, formatNumber, zoneLabel, type Language } from "@questify/shared";
import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "#src/components/ConfirmDialog.tsx";
import { Notes } from "#src/components/PrizesPanel.tsx";
import {
  blankBoost,
  boostBodyOf,
  boostDraftOf,
  boostProblem,
  boostStateOf,
  boostsOf,
  type Boost,
  type BoostDraft,
} from "#src/lib/boosts.ts";
import { issuesOf } from "#src/lib/community.ts";
import { FLASH_MAX_MINUTES } from "#src/lib/flash.ts";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { textFor, type CategoryView } from "#src/lib/quests.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import styles from "#src/components/layout.module.css";

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);
/** How often the list is read again while a boost is scheduled or running. */
const REFRESH_MS = 15_000;

type Props = Readonly<{ language: Language; organizerId: string; eventId: string }>;
type Category = Readonly<{ id: string; name: string }>;

const STATUS_KEYS = {
  scheduled: "boosts.page.status.scheduled",
  running: "boosts.page.status.running",
  ended: "boosts.page.status.ended",
} as const;

/** The event's zone and categories, for the form. */
function useEventChoices(eventApi: string, language: Language) {
  const [timeZone, setTimeZone] = useState("Asia/Riyadh");
  const [categories, setCategories] = useState<readonly Category[]>([]);
  useEffect(() => {
    void Promise.all([requestJson("GET", eventApi), requestJson("GET", `${eventApi}/quests`)]).then(
      ([event, found]) => {
        const zone = event.ok
          ? (event.body as { event?: { timezone?: string } }).event?.timezone
          : undefined;
        setTimeZone(zone ?? "Asia/Riyadh");
        const list = found.ok ? (found.body as { categories: CategoryView[] }).categories : [];
        setCategories(
          list.map((category) => ({ id: category.id, name: textFor(category.name, language) })),
        );
      },
    );
  }, [eventApi, language]);
  return { timeZone, categories };
}

/** The boosts, read again every 15 s while one is scheduled or running (its state and what it paid move). */
function useBoosts(eventApi: string, language: Language) {
  const t = translatorFor(language);
  const [boosts, setBoosts] = useState<readonly Boost[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const failed = useCallback(
    (body: unknown) => {
      const code = errorCodeOf(body);
      if (code !== undefined && SESSION_LOST.has(code)) {
        window.location.assign(`/${language}/sign-in?ended=1`);
        return;
      }
      if (code === "invalid_boost") {
        setProblem(t("boosts.page.invalid", { fields: issuesOf(body).join("، ") }));
        return;
      }
      setProblem(
        code === undefined ? t("boosts.page.loadFailed") : describeProblem(body, language, t).text,
      );
    },
    [language, t],
  );
  const load = useCallback(async () => {
    const result = await requestJson("GET", `${eventApi}/boosts`);
    const read = result.ok ? boostsOf(result.body) : undefined;
    if (read === undefined) {
      failed(result.body);
    } else {
      setBoosts(read);
    }
  }, [eventApi, failed]);
  useEffect(() => {
    void load();
  }, [load]);
  const active = boosts?.some((boost) => boostStateOf(boost, Date.now()) !== "ended") === true;
  useEffect(() => {
    if (!active) {
      return undefined;
    }
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [active, load]);
  return { boosts, problem, setProblem, failed, load };
}

/** One boost: its category, window, state and payments; Edit and Delete while editable, Stop while it runs. */
function BoostCard({
  boost,
  language,
  timeZone,
  busy,
  edit,
  remove,
  stop,
}: Readonly<{
  boost: Boost;
  language: Language;
  timeZone: string;
  busy: boolean;
  edit: () => void;
  remove: () => void;
  stop: () => void;
}>) {
  const t = translatorFor(language);
  const at = (iso: string) => formatEventTime(new Date(iso), timeZone, language);
  const state = boostStateOf(boost, Date.now());
  return (
    <li className={styles.formCard}>
      <p className={styles.row}>
        <strong dir="auto">{textFor(boost.category, language)}</strong>
        <span className={styles.badge}>{t("quests.boost.badge")}</span>
        <span className={styles.badge}>{t(STATUS_KEYS[state])}</span>
        {boost.rehearsal ? (
          <span className={styles.badge}>{t("boosts.page.rehearsal")}</span>
        ) : null}
      </p>
      <p className={styles.muted}>
        {t("boosts.page.window", { start: at(boost.startsAt), end: at(boost.endsAt) })}
      </p>
      <p>{t("boosts.page.paid", { count: formatNumber(boost.paid, language) })}</p>
      <div className={styles.actions}>
        {boost.editable ? (
          <>
            <button type="button" className={styles.quiet} disabled={busy} onClick={edit}>
              {t("boosts.page.edit")}
            </button>
            <button type="button" className={styles.quiet} disabled={busy} onClick={remove}>
              {t("boosts.page.delete")}
            </button>
          </>
        ) : null}
        {state === "running" ? (
          <button type="button" className={styles.button} disabled={busy} onClick={stop}>
            {t("boosts.page.stop")}
          </button>
        ) : null}
      </div>
    </li>
  );
}

/** The form: the category, Start now or a start in the event's zone, and minutes. */
function BoostForm({
  language,
  timeZone,
  categories,
  draft,
  change,
  busy,
  save,
  cancel,
}: Readonly<{
  language: Language;
  timeZone: string;
  categories: readonly Category[];
  draft: BoostDraft;
  change: (draft: BoostDraft) => void;
  busy: boolean;
  save: () => void;
  cancel: () => void;
}>) {
  const t = translatorFor(language);
  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      <label className={styles.field}>
        {t("boosts.page.category")}
        <select
          className={styles.input}
          value={draft.categoryId}
          disabled={busy}
          onChange={(event) => change({ ...draft, categoryId: event.target.value })}
        >
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
      </label>
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={draft.startNow}
          disabled={busy}
          onChange={(event) => change({ ...draft, startNow: event.target.checked })}
        />
        <span>{t("boosts.page.startNow")}</span>
      </label>
      {draft.startNow ? null : (
        <label className={styles.field}>
          {t("boosts.page.startsAt")}
          <input
            className={styles.input}
            type="datetime-local"
            dir="ltr"
            value={draft.startsAt}
            disabled={busy}
            onChange={(event) => change({ ...draft, startsAt: event.target.value })}
          />
        </label>
      )}
      {draft.startNow ? null : <p className={styles.muted}>{zoneLabel(timeZone, language)}</p>}
      <label className={styles.field}>
        {t("boosts.page.minutes")}
        <input
          className={styles.input}
          type="number"
          dir="ltr"
          min={1}
          max={FLASH_MAX_MINUTES}
          value={draft.minutes}
          disabled={busy}
          onChange={(event) => change({ ...draft, minutes: Number(event.target.value) })}
        />
      </label>
      <p className={styles.muted}>{t("boosts.page.rehearsalNote")}</p>
      <div className={styles.actions}>
        <button type="button" className={styles.quiet} disabled={busy} onClick={cancel}>
          {t("common.cancel")}
        </button>
        <button type="submit" className={styles.button} disabled={busy}>
          {t("boosts.page.save")}
        </button>
      </div>
    </form>
  );
}

type Asking = Readonly<{ kind: "delete" | "stop"; boost: Boost }>;

/**
 * The event's double-point boosts (T-307, FR-252): the list with each one's state and payments, a form to add one or
 * change a scheduled one, Delete until a minute before the start, and Stop while it runs. Owners and editors.
 */
export function BoostsPanel({ language, organizerId, eventId }: Props) {
  const t = translatorFor(language);
  const eventApi = `/v1/organizers/${organizerId}/events/${eventId}`;
  const { timeZone, categories } = useEventChoices(eventApi, language);
  const { boosts, problem, setProblem, failed, load } = useBoosts(eventApi, language);
  const [draft, setDraft] = useState<BoostDraft | null>(null);
  const [asking, setAsking] = useState<Asking | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  /** Sends one change; on success closes the form first, so a list already read again cannot be edited then shut. */
  const call = async (
    method: "POST" | "PATCH" | "DELETE",
    path: string,
    body: Record<string, unknown> | undefined,
    done: string,
  ) => {
    setBusy(true);
    const result = await requestJson(method, `${eventApi}/boosts${path}`, body, {
      "idempotency-key": crypto.randomUUID(),
    });
    setBusy(false);
    if (!result.ok) {
      failed(result.body);
      return;
    }
    setProblem(null);
    setNotice(done);
    setDraft(null);
    await load();
  };
  const save = async () => {
    if (draft === null) {
      return;
    }
    const field = boostProblem(draft);
    if (field !== undefined) {
      setProblem(t("boosts.page.invalid", { fields: field }));
      return;
    }
    await call(
      draft.id === null ? "POST" : "PATCH",
      draft.id === null ? "" : `/${draft.id}`,
      boostBodyOf(draft, timeZone),
      t("boosts.page.saved"),
    );
  };
  const confirm = async () => {
    if (asking === null) {
      return;
    }
    const { kind, boost } = asking;
    setAsking(null);
    await (kind === "delete"
      ? call("DELETE", `/${boost.id}`, undefined, t("boosts.page.deleted"))
      : call("POST", `/${boost.id}/end`, {}, t("boosts.page.stopped")));
  };

  return (
    <section className={styles.panel} aria-labelledby="boosts-title">
      <h2 id="boosts-title" className={styles.title}>
        {t("boosts.page.title")}
      </h2>
      <p className={styles.muted}>{t("boosts.page.intro")}</p>
      <p className={styles.muted}>{t("boosts.page.lockedNote")}</p>
      <Notes
        problem={problem}
        notice={notice}
        loading={boosts === null && problem === null}
        language={language}
      />
      {asking === null ? null : (
        <ConfirmDialog
          language={language}
          title={t(asking.kind === "delete" ? "boosts.page.delete" : "boosts.page.stop")}
          body={textFor(asking.boost.category, language)}
          confirmLabel={t(asking.kind === "delete" ? "boosts.page.delete" : "boosts.page.stop")}
          noteLabel={null}
          busy={busy}
          cancel={() => setAsking(null)}
          confirm={() => void confirm()}
        />
      )}
      <div className={styles.form} inert={asking !== null}>
        {boosts !== null && boosts.length === 0 ? (
          <p className={styles.muted}>{t("boosts.page.empty")}</p>
        ) : null}
        <ul className={styles.list}>
          {(boosts ?? []).map((boost) => (
            <BoostCard
              key={boost.id}
              boost={boost}
              language={language}
              timeZone={timeZone}
              busy={busy}
              edit={() => setDraft(boostDraftOf(boost, timeZone))}
              remove={() => setAsking({ kind: "delete", boost })}
              stop={() => setAsking({ kind: "stop", boost })}
            />
          ))}
        </ul>
        {draft === null ? (
          <button
            type="button"
            className={styles.button}
            disabled={categories.length === 0}
            onClick={() => setDraft(blankBoost(categories[0]?.id ?? ""))}
          >
            {t("boosts.page.new")}
          </button>
        ) : (
          <BoostForm
            language={language}
            timeZone={timeZone}
            categories={categories}
            draft={draft}
            change={setDraft}
            busy={busy}
            save={() => void save()}
            cancel={() => setDraft(null)}
          />
        )}
      </div>
    </section>
  );
}
