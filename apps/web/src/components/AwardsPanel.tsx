"use client";

import { formatEventTime, formatNumber, type Language } from "@questify/shared";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ConfirmDialog,
  problemOf,
  type Caps,
  type QuestOption,
} from "#src/components/PlayerAwards.tsx";
import { pointsOf, reasonOk, whoOf, kindKey, type ReportLine } from "#src/lib/awards.ts";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { handleOf } from "#src/lib/players.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { textFor, type CategoryView } from "#src/lib/quests.ts";
import styles from "#src/components/layout.module.css";

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);

/** The event's report page by page, its caps, its zone and its quests. */
function useAwards(eventApi: string, language: Language, onFailure: (body: unknown) => void) {
  const loaded = useRef(false);
  const [lines, setLines] = useState<ReportLine[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [caps, setCaps] = useState<Caps | null>(null);
  const [timeZone, setTimeZone] = useState("Asia/Riyadh");
  const [quests, setQuests] = useState<QuestOption[]>([]);
  const load = async (cursor: string | null) => {
    const query = cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`;
    const result = await requestJson("GET", `${eventApi}/awards${query}`);
    if (!result.ok) {
      onFailure(result.body);
      return;
    }
    const page = result.body as { caps: Caps; awards: ReportLine[]; nextCursor: string | null };
    setCaps(page.caps);
    setLines((current) => (cursor === null ? page.awards : [...(current ?? []), ...page.awards]));
    setNext(page.nextCursor);
  };
  useEffect(() => {
    // Stryker disable next-line ConditionalExpression,BlockStatement: React runs effects twice in development only
    if (loaded.current) {
      return;
    }
    loaded.current = true;
    void load(null);
    void Promise.all([requestJson("GET", eventApi), requestJson("GET", `${eventApi}/quests`)]).then(
      ([event, found]) => {
        const zone = event.ok
          ? (event.body as { event?: { timezone?: string } }).event?.timezone
          : undefined;
        setTimeZone(zone ?? "Asia/Riyadh");
        const categories = found.ok
          ? (found.body as { categories: CategoryView[] }).categories
          : [];
        setQuests(
          categories.flatMap((category) =>
            category.quests.map((quest) => ({
              id: quest.id,
              title: textFor(quest.title, language),
              points: quest.points,
            })),
          ),
        );
      },
    );
  });
  return {
    lines,
    caps,
    setCaps,
    timeZone,
    quests,
    reload: () => void load(null),
    more: next === null ? null : () => void load(next),
  };
}

/** FR-310: the owner sets the caps; editors read them. */
function CapsCard({
  language,
  eventApi,
  caps,
  isOwner,
  saved,
}: Readonly<{
  language: Language;
  eventApi: string;
  caps: Caps;
  isOwner: boolean;
  saved: (caps: Caps) => void;
}>) {
  const t = useTranslator(language);
  const [each, setEach] = useState(String(caps.each));
  const [day, setDay] = useState(String(caps.day));
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const wanted = { each: pointsOf(each), day: Number(day) };
    if (
      wanted.each === undefined ||
      !Number.isInteger(wanted.day) ||
      wanted.day < wanted.each ||
      wanted.day > 1000000
    ) {
      setMessage({ ok: false, text: t("awards.capsInvalid") });
      return;
    }
    const result = await requestJson("PUT", `${eventApi}/award-caps`, wanted);
    setMessage(
      result.ok
        ? { ok: true, text: t("awards.capsSaved") }
        : { ok: false, text: problemOf(result.body, language, t) },
    );
    if (result.ok) {
      saved(result.body as Caps);
    }
  };
  return (
    <form
      className={styles.formCard}
      onSubmit={(event) => void submit(event)}
      aria-labelledby="caps-title"
    >
      <h3 id="caps-title" className={styles.subtitle}>
        {t("awards.caps")}
      </h3>
      <p className={styles.muted}>{t(isOwner ? "awards.capsHelp" : "awards.capsOwnerOnly")}</p>
      {(
        [
          ["awards.capEach", each, setEach],
          ["awards.capDay", day, setDay],
        ] as const
      ).map(([label, value, set]) => (
        <label key={label} className={styles.field}>
          <span>{t(label)}</span>
          <input
            className={styles.input}
            inputMode="numeric"
            dir="ltr"
            value={value}
            readOnly={!isOwner}
            onChange={(changed) => set(changed.target.value)}
          />
        </label>
      ))}
      {message === null ? null : (
        <p
          role={message.ok ? "status" : "alert"}
          className={message.ok ? styles.notice : styles.alert}
        >
          {message.text}
        </p>
      )}
      {isOwner ? (
        <button type="submit" className={styles.button}>
          {t("awards.saveCaps")}
        </button>
      ) : null}
    </form>
  );
}

type Preview = Readonly<{
  count: number;
  matched?: readonly Readonly<{ enrollmentId: string; username: string }>[];
  inactive?: readonly string[];
  notFound?: readonly string[];
}>;

type BulkDraft = Readonly<{
  target: "list" | "quest";
  lines: string;
  questId: string;
  points: string;
  reason: string;
}>;

function BulkFields({
  language,
  quests,
  draft,
  change,
}: Readonly<{
  language: Language;
  quests: readonly QuestOption[];
  draft: BulkDraft;
  change: (next: BulkDraft) => void;
}>) {
  const t = useTranslator(language);
  const upload = async (file: File | undefined) => {
    if (file !== undefined) {
      change({ ...draft, lines: await file.text() });
    }
  };
  return (
    <>
      <fieldset className={styles.choices}>
        <legend>{t("awards.what")}</legend>
        {(["list", "quest"] as const).map((target) => (
          <label key={target} className={styles.check}>
            <input
              type="radio"
              name="bulk-target"
              checked={draft.target === target}
              disabled={target === "quest" && quests.length === 0}
              onChange={() => change({ ...draft, target })}
            />
            {t(target === "list" ? "awards.bulkList" : "awards.bulkQuest")}
          </label>
        ))}
      </fieldset>
      {draft.target === "list" ? (
        <>
          <label className={styles.field}>
            <span>{t("awards.bulkLines")}</span>
            <textarea
              className={styles.input}
              dir="auto"
              rows={6}
              value={draft.lines}
              onChange={(typed) => change({ ...draft, lines: typed.target.value })}
            />
          </label>
          <label className={styles.field}>
            <span>{t("awards.bulkFile")}</span>
            <input
              type="file"
              accept=".csv,.txt,text/csv,text/plain"
              onChange={(picked) => void upload(picked.target.files?.[0])}
            />
          </label>
        </>
      ) : (
        <label className={styles.field}>
          <span>{t("awards.quest")}</span>
          <select
            className={styles.input}
            value={draft.questId}
            onChange={(picked) => change({ ...draft, questId: picked.target.value })}
          >
            {quests.map((quest) => (
              <option key={quest.id} value={quest.id}>
                {quest.title}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className={styles.field}>
        <span>{t("awards.amount")}</span>
        <input
          className={styles.input}
          inputMode="numeric"
          dir="ltr"
          value={draft.points}
          onChange={(typed) => change({ ...draft, points: typed.target.value })}
        />
      </label>
      <label className={styles.field}>
        <span>{t("awards.reason")}</span>
        <textarea
          className={styles.input}
          dir="auto"
          maxLength={300}
          value={draft.reason}
          onChange={(typed) => change({ ...draft, reason: typed.target.value })}
        />
      </label>
    </>
  );
}

function PreviewNote({ language, preview }: Readonly<{ language: Language; preview: Preview }>) {
  const t = useTranslator(language);
  return (
    <div role="status">
      <p>{t("awards.matched", { count: formatNumber(preview.count, language) })}</p>
      {(preview.notFound ?? []).length === 0 ? null : (
        <p dir="auto" className={styles.muted}>
          {t("awards.notFound", { lines: (preview.notFound ?? []).join("، ") })}
        </p>
      )}
      {(preview.inactive ?? []).length === 0 ? null : (
        <p dir="auto" className={styles.muted}>
          {t("awards.inactive", { lines: (preview.inactive ?? []).join("، ") })}
        </p>
      )}
    </div>
  );
}

/** FR-1712: a list or a quest's completers, checked first, then the same points to each after a confirm step. */
function BulkCard({
  language,
  eventApi,
  quests,
  done,
}: Readonly<{
  language: Language;
  eventApi: string;
  quests: readonly QuestOption[];
  done: () => void;
}>) {
  const t = useTranslator(language);
  const [draft, setDraft] = useState<BulkDraft>({
    target: "list",
    lines: "",
    questId: "",
    points: "",
    reason: "",
  });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const key = useRef("");
  const questId = draft.questId === "" ? (quests[0]?.id ?? "") : draft.questId;
  const points = pointsOf(draft.points);
  // Only a new target needs a new check; the amount and the reason do not.
  const change = (next: BulkDraft) => {
    if (next.target !== draft.target || next.lines !== draft.lines || next.questId !== questId) {
      setPreview(null);
    }
    setDraft(next);
  };

  const check = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage(null);
    const body = draft.target === "list" ? { lines: draft.lines } : { questId };
    const result = await requestJson("POST", `${eventApi}/bulk-awards/preview`, body);
    if (!result.ok) {
      setMessage({ ok: false, text: problemOf(result.body, language, t) });
      return;
    }
    setPreview(result.body as Preview);
  };
  const confirm = async () => {
    if (points === undefined || preview === null) {
      return;
    }
    setBusy(true);
    const target =
      draft.target === "list"
        ? { enrollmentIds: (preview.matched ?? []).map((row) => row.enrollmentId) }
        : { questId };
    const result = await requestJson(
      "POST",
      `${eventApi}/bulk-awards`,
      { ...target, points, reason: draft.reason.trim() },
      { "idempotency-key": key.current },
    );
    setBusy(false);
    setAsking(false);
    if (!result.ok) {
      setMessage({ ok: false, text: problemOf(result.body, language, t) });
      return;
    }
    const outcome = result.body as { awarded: number; skipped: number };
    setMessage({ ok: true, text: t("awards.bulkDone", outcome) });
    setDraft({ ...draft, lines: "", points: "", reason: "" });
    setPreview(null);
    done();
  };
  const ready =
    preview !== null && preview.count > 0 && points !== undefined && reasonOk(draft.reason);

  return (
    <section className={styles.formCard} aria-labelledby="bulk-title">
      {asking && points !== undefined && preview !== null ? (
        <ConfirmDialog
          language={language}
          title={t("awards.confirmTitle")}
          busy={busy}
          cancel={() => setAsking(false)}
          confirm={() => void confirm()}
        >
          <p dir="auto">
            {t("awards.bulkConfirmBody", {
              count: formatNumber(preview.count, language),
              points: formatNumber(points, language),
              reason: draft.reason.trim(),
            })}
          </p>
        </ConfirmDialog>
      ) : null}
      <form className={styles.form} inert={asking} onSubmit={(event) => void check(event)}>
        <h3 id="bulk-title" className={styles.subtitle}>
          {t("awards.bulk")}
        </h3>
        <p className={styles.muted}>{t("awards.bulkHelp")}</p>
        <BulkFields
          language={language}
          quests={quests}
          draft={{ ...draft, questId }}
          change={change}
        />
        <button type="submit" className={styles.quiet}>
          {t("awards.check")}
        </button>
        {preview === null ? null : <PreviewNote language={language} preview={preview} />}
        {preview !== null && preview.count === 0 ? (
          <p className={styles.muted}>{t("awards.nobody")}</p>
        ) : null}
        {message === null ? null : (
          <p
            role={message.ok ? "status" : "alert"}
            className={message.ok ? styles.notice : styles.alert}
          >
            {message.text}
          </p>
        )}
        <button
          type="button"
          className={styles.button}
          disabled={!ready}
          onClick={() => {
            key.current = crypto.randomUUID();
            setAsking(true);
          }}
        >
          {t("awards.award")}
        </button>
      </form>
    </section>
  );
}

function ReportRow({
  language,
  timeZone,
  line,
}: Readonly<{ language: Language; timeZone: string; line: ReportLine }>) {
  const t = useTranslator(language);
  const who = whoOf(line.by);
  const sign = line.kind === "removal" ? "−" : "+";
  return (
    <li className={styles.card}>
      <p className={styles.row}>
        <strong dir="auto">{handleOf(line.player.username, language)}</strong>
        <span>{t(kindKey(line.kind))}</span>
        {line.quest === null ? null : <span dir="auto">{textFor(line.quest.title, language)}</span>}
        <span dir="ltr">
          {sign}
          {formatNumber(line.points, language)}
        </span>
        {line.bulkId === null ? null : <span className={styles.badge}>{t("awards.bulkTag")}</span>}
        {line.removed ? <span className={styles.badge}>{t("awards.removedTag")}</span> : null}
      </p>
      <p className={styles.muted}>
        {formatEventTime(new Date(line.at), timeZone, language)}
        {who === null ? null : ` · ${t("awards.by", { name: who })}`}
      </p>
      {line.reason === null ? null : (
        <p dir="auto" className={styles.muted}>
          {line.reason}
        </p>
      )}
    </li>
  );
}

type Props = Readonly<{
  language: Language;
  organizerId: string;
  eventId: string;
  myRole: "owner" | "editor";
}>;

/**
 * Manual awards for the event's team (T-207): the caps (owner), a bulk award (FR-1712) and the report of every manual
 * award and removal with player, quest or points, reason, who and when (FR-311).
 */
export function AwardsPanel({ language, organizerId, eventId, myRole }: Props) {
  const t = useTranslator(language);
  const eventApi = `/v1/organizers/${organizerId}/events/${eventId}`;
  const [problem, setProblem] = useState<string | null>(null);
  const awards = useAwards(eventApi, language, (body) => {
    const code = (body as { code?: unknown } | undefined)?.code;
    if (typeof code === "string" && SESSION_LOST.has(code)) {
      window.location.assign(`/${language}/sign-in?ended=1`);
      return;
    }
    setProblem(body === undefined ? t("awards.loadFailed") : problemOf(body, language, t));
  });

  return (
    <section className={styles.panel} aria-labelledby="awards-title">
      <h2 id="awards-title" className={styles.title}>
        {t("awards.title")}
      </h2>
      {problem === null ? null : (
        <p role="alert" className={styles.alert}>
          {problem}
        </p>
      )}
      {awards.caps === null ? null : (
        <CapsCard
          language={language}
          eventApi={eventApi}
          caps={awards.caps}
          isOwner={myRole === "owner"}
          saved={awards.setCaps}
        />
      )}
      <BulkCard
        language={language}
        eventApi={eventApi}
        quests={awards.quests}
        done={awards.reload}
      />
      <h3 className={styles.subtitle}>{t("awards.report")}</h3>
      {awards.lines === null && problem === null ? (
        <p className={styles.muted}>{t("common.loading")}</p>
      ) : null}
      {awards.lines?.length === 0 ? (
        <p className={styles.muted}>{t("awards.reportEmpty")}</p>
      ) : null}
      <ul className={styles.list}>
        {(awards.lines ?? []).map((line) => (
          <ReportRow key={line.id} language={language} timeZone={awards.timeZone} line={line} />
        ))}
      </ul>
      {awards.more === null ? null : (
        <button type="button" className={styles.quiet} onClick={awards.more}>
          {t("players.more")}
        </button>
      )}
    </section>
  );
}
