"use client";

import { formatNumber, type Language } from "@questify/shared";
import { useEffect, useRef, useState } from "react";
import { problemOf } from "#src/components/PlayerAwards.tsx";
import { translatorFor } from "#src/lib/language.ts";
import { handleOf } from "#src/lib/players.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { textFor } from "#src/lib/quests.ts";
import {
  FILTERS,
  canGiveReason,
  statusKey,
  type QueueFilter,
  type QueueItem,
} from "#src/lib/submissions.ts";
import styles from "#src/components/layout.module.css";

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);

/** One filter's queue, page by page. */
function useQueue(eventApi: string, filter: QueueFilter, onFailure: (body: unknown) => void) {
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const loadedFor = useRef<string | null>(null);
  const load = async (cursor: string | null) => {
    const query = `?filter=${filter}${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
    const result = await requestJson("GET", `${eventApi}/submissions${query}`);
    if (!result.ok) {
      onFailure(result.body);
      return;
    }
    const page = result.body as { submissions: QueueItem[]; nextCursor: string | null };
    setItems((current) =>
      cursor === null ? page.submissions : [...(current ?? []), ...page.submissions],
    );
    setNext(page.nextCursor);
  };
  useEffect(() => {
    // Stryker disable next-line ConditionalExpression,BlockStatement: React runs effects twice in development only
    if (loadedFor.current === filter) {
      return;
    }
    loadedFor.current = filter;
    setItems(null);
    void load(null);
  });
  return {
    items,
    reload: () => void load(null),
    more: next === null ? null : () => void load(next),
  };
}

/** Approve, reject with a reason, or remove an approved one with a reason; each with its own key. */
function ItemActions({
  language,
  eventApi,
  item,
  done,
}: Readonly<{ language: Language; eventApi: string; item: QueueItem; done: () => void }>) {
  const t = translatorFor(language);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const key = useRef(crypto.randomUUID());
  const send = async (path: string, payload: object) => {
    setBusy(true);
    setProblem(null);
    const result = await requestJson(
      "POST",
      `${eventApi}/submissions/${item.id}/${path}`,
      payload,
      {
        "idempotency-key": key.current,
      },
    );
    setBusy(false);
    if (result.ok) {
      key.current = crypto.randomUUID();
      done();
      return;
    }
    // Kept on a failure: trying again cannot act twice.
    setProblem(result.body === undefined ? t("join.network") : problemOf(result.body, language, t));
  };
  const reasonField = (label: "submissions.rejectReason" | "submissions.removeReason") => (
    <label className={styles.field}>
      <span>{t(label)}</span>
      <input
        className={styles.input}
        dir="auto"
        maxLength={300}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
      />
    </label>
  );
  return (
    <div className={styles.formCard}>
      {item.status === "pending" ? (
        <>
          <button
            type="button"
            className={styles.button}
            disabled={busy}
            onClick={() => void send("review", { decision: "approve" })}
          >
            {t("submissions.approve")}
          </button>
          {reasonField("submissions.rejectReason")}
          <button
            type="button"
            className={styles.quiet}
            disabled={busy || !canGiveReason(reason)}
            onClick={() => void send("review", { decision: "reject", reason: reason.trim() })}
          >
            {t("submissions.reject")}
          </button>
        </>
      ) : null}
      {item.status === "approved" ? (
        <>
          {reasonField("submissions.removeReason")}
          <button
            type="button"
            className={styles.quiet}
            disabled={busy || !canGiveReason(reason)}
            onClick={() => void send("remove", { reason: reason.trim() })}
          >
            {t("submissions.remove")}
          </button>
        </>
      ) : null}
      {problem === null ? null : (
        <p role="alert" className={styles.alert}>
          {problem}
        </p>
      )}
    </div>
  );
}

function ItemRow({
  language,
  eventApi,
  item,
  done,
}: Readonly<{ language: Language; eventApi: string; item: QueueItem; done: () => void }>) {
  const t = translatorFor(language);
  const player =
    item.username === null ? t("submissions.deletedPlayer") : handleOf(item.username, language);
  return (
    <li className={styles.card} data-testid="submission">
      <p className={styles.row}>
        <strong dir="auto">{player}</strong>
        <span dir="auto">{textFor(item.questTitle, language)}</span>
        <span dir="ltr">+{formatNumber(item.points, language)}</span>
        <span className={styles.badge}>{t(statusKey(item.status))}</span>
        {item.auto ? <span className={styles.badge}>{t("submissions.auto")}</span> : null}
        {item.marked ? <span className={styles.badge}>{t("submissions.marked")}</span> : null}
      </p>
      <p dir="auto">{item.text ?? t("submissions.erased")}</p>
      {item.reasonSystem ? <p className={styles.muted}>{t("submissions.left")}</p> : null}
      {!item.reasonSystem && item.reason !== null ? (
        <p dir="auto" className={styles.muted}>
          {t("submissions.reasonShown", { reason: item.reason })}
        </p>
      ) : null}
      <ItemActions language={language} eventApi={eventApi} item={item} done={done} />
    </li>
  );
}

type Props = Readonly<{ language: Language; organizerId: string; eventId: string }>;

/**
 * The event's submissions for its team (T-301, FR-324 to FR-328): waiting ones oldest first, the auto-approved ones
 * not yet read (ADR-187), those with a listed word (FR-1628), and the reviewed ones newest first.
 */
export function SubmissionsPanel({ language, organizerId, eventId }: Props) {
  const t = translatorFor(language);
  const eventApi = `/v1/organizers/${organizerId}/events/${eventId}`;
  const [filter, setFilter] = useState<QueueFilter>("pending");
  const [problem, setProblem] = useState<string | null>(null);
  const queue = useQueue(eventApi, filter, (body) => {
    const code = (body as { code?: unknown } | undefined)?.code;
    if (typeof code === "string" && SESSION_LOST.has(code)) {
      window.location.assign(`/${language}/sign-in?ended=1`);
      return;
    }
    setProblem(body === undefined ? t("join.network") : problemOf(body, language, t));
  });
  const markRead = async () => {
    const ids = (queue.items ?? []).map((item) => item.id);
    if (ids.length === 0) {
      return;
    }
    const result = await requestJson("POST", `${eventApi}/submissions/seen`, { ids });
    if (result.ok) {
      queue.reload();
    } else {
      setProblem(
        result.body === undefined ? t("join.network") : problemOf(result.body, language, t),
      );
    }
  };

  return (
    <section className={styles.panel} aria-labelledby="submissions-title">
      <h2 id="submissions-title" className={styles.title}>
        {t("submissions.title")}
      </h2>
      <div role="tablist" className={styles.row}>
        {FILTERS.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={filter === name}
            className={filter === name ? styles.button : styles.quiet}
            onClick={() => setFilter(name)}
          >
            {t(`submissions.filter.${name}`)}
          </button>
        ))}
      </div>
      {problem === null ? null : (
        <p role="alert" className={styles.alert}>
          {problem}
        </p>
      )}
      {queue.items === null && problem === null ? (
        <p className={styles.muted}>{t("common.loading")}</p>
      ) : null}
      {queue.items?.length === 0 ? <p className={styles.muted}>{t("submissions.empty")}</p> : null}
      {filter === "unseen" && (queue.items?.length ?? 0) > 0 ? (
        <button type="button" className={styles.quiet} onClick={() => void markRead()}>
          {t("submissions.markSeen")}
        </button>
      ) : null}
      <ul className={styles.list}>
        {(queue.items ?? []).map((item) => (
          <ItemRow
            key={item.id}
            language={language}
            eventApi={eventApi}
            item={item}
            done={queue.reload}
          />
        ))}
      </ul>
      {queue.more === null ? null : (
        <button type="button" className={styles.quiet} onClick={queue.more}>
          {t("submissions.more")}
        </button>
      )}
    </section>
  );
}
