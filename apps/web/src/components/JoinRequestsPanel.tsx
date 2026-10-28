"use client";

import { formatNumber, type Language } from "@questify/shared";
import { useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "#src/components/ConfirmDialog.tsx";
import { acceptAllInCalls } from "#src/lib/accept-all.ts";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import styles from "#src/components/layout.module.css";

type JoinRequest = Readonly<{
  enrollmentId: string;
  username: string;
  status: "pending" | "declined";
  waitlisted: boolean;
}>;

type Page = Readonly<{ requests: JoinRequest[]; pending: number; nextCursor: string | null }>;

type Translate = ReturnType<typeof translatorFor>;

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);

type Props = Readonly<{ language: Language; organizerId: string; eventId: string }>;

/** The queue as loaded so far: the first page again after every decision, later pages appended by "Show more". */
function useRequestPages(base: string, failed: (body: unknown) => void) {
  const loaded = useRef(false);
  const [requests, setRequests] = useState<JoinRequest[] | null>(null);
  const [pending, setPending] = useState(0);
  const [next, setNext] = useState<string | null>(null);

  const load = async (cursor: string | null) => {
    const query = cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`;
    const result = await requestJson("GET", `${base}?limit=100${query}`);
    if (!result.ok) {
      failed(result.body);
      return;
    }
    const page = result.body as Page;
    setRequests((current) =>
      cursor === null || current === null ? page.requests : [...current, ...page.requests],
    );
    setPending(page.pending);
    setNext(page.nextCursor);
  };

  useEffect(() => {
    // Stryker disable next-line ConditionalExpression,BlockStatement: React runs effects twice in development only
    if (loaded.current) {
      return;
    }
    loaded.current = true;
    void load(null);
  });

  return {
    requests,
    pending,
    reload: () => load(null),
    more: next === null ? null : () => void load(next),
  };
}

type ItemProps = Readonly<{
  request: JoinRequest;
  t: Translate;
  busy: boolean;
  act: (path: string) => void;
}>;

function RequestItem({ request, t, busy, act }: ItemProps) {
  const badge =
    request.status === "declined"
      ? "players.status.declined"
      : request.waitlisted
        ? "requests.waitlist"
        : "requests.asked";
  return (
    <li className={styles.card}>
      <p className={styles.row}>
        <strong dir="auto">@{request.username}</strong>
        <span className={styles.badge}>{t(badge)}</span>
      </p>
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.button}
          disabled={busy}
          aria-label={`${t("requests.accept")} @${request.username}`}
          onClick={() => act(`${request.enrollmentId}/accept`)}
        >
          {t("requests.accept")}
        </button>
        {request.status === "pending" ? (
          <button
            type="button"
            className={styles.quiet}
            disabled={busy}
            aria-label={`${t("requests.decline")} @${request.username}`}
            onClick={() => act(`${request.enrollmentId}/decline`)}
          >
            {t("requests.decline")}
          </button>
        ) : null}
      </div>
    </li>
  );
}

/** The last action's problem (an alert) or its result (a status line). */
function Messages({
  problem,
  notice,
}: Readonly<{ problem: string | null; notice: string | null }>) {
  return (
    <>
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
    </>
  );
}

type AcceptAllDeps = Readonly<{
  base: string;
  language: Language;
  t: Translate;
  failed: (body: unknown) => void;
  reload: () => Promise<void>;
  setBusy: (busy: boolean) => void;
  setProblem: (problem: string | null) => void;
  setNotice: (notice: string | null) => void;
}>;

/**
 * Accept all (T-218) in calls of at most 1,000 (T-501d, ADR-353 (5)): a progress line while the calls run; at the end
 * the totals, or, when a call fails partway, what the earlier calls accepted and the failure.
 */
function acceptAllAction(deps: AcceptAllDeps): () => Promise<void> {
  const count = (value: number) => formatNumber(value, deps.language);
  const accepting = (accepted: number) =>
    deps.setNotice(deps.t("requests.acceptingAll", { accepted: count(accepted) }));
  return async () => {
    deps.setBusy(true);
    deps.setProblem(null);
    accepting(0);
    const outcome = await acceptAllInCalls(
      () => requestJson("POST", `${deps.base}/accept-all`),
      (sofar) => accepting(sofar.accepted),
    );
    deps.setBusy(false);
    if (outcome.kind === "done") {
      deps.setNotice(
        deps.t("requests.acceptedAll", {
          accepted: count(outcome.accepted),
          remaining: count(outcome.remaining),
        }),
      );
    } else {
      deps.setNotice(
        outcome.accepted > 0
          ? deps.t("requests.acceptedBeforeError", { accepted: count(outcome.accepted) })
          : null,
      );
      deps.failed(outcome.body);
    }
    if (outcome.kind === "done" || outcome.accepted > 0) await deps.reload();
  };
}

/**
 * The event's join requests and waiting list (T-218, FR-1819, FR-1821): the owner and editors accept or decline each,
 * or accept all (oldest first, while places are free, 1,000 a call) after a confirmation. Shown while there are any, or
 * while a result or a problem is on screen.
 */
export function JoinRequestsPanel({ language, organizerId, eventId }: Props) {
  const t = translatorFor(language);
  const base = `/v1/organizers/${organizerId}/events/${eventId}/join-requests`;
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [askAll, setAskAll] = useState(false);

  const failed = (body: unknown) => {
    const code = errorCodeOf(body);
    if (code !== undefined && SESSION_LOST.has(code)) {
      window.location.assign(`/${language}/sign-in?ended=1`);
      return;
    }
    setProblem(code === undefined ? t("requests.failed") : describeProblem(body, language, t).text);
  };
  const queue = useRequestPages(base, failed);

  const act = async (path: string) => {
    setBusy(true);
    setProblem(null);
    setNotice(null);
    const result = await requestJson("POST", `${base}/${path}`);
    setBusy(false);
    setAskAll(false);
    if (!result.ok) {
      failed(result.body);
      return;
    }
    await queue.reload();
  };
  const runAcceptAll = acceptAllAction({
    base,
    language,
    t,
    failed,
    reload: queue.reload,
    setBusy,
    setProblem,
    setNotice,
  });
  const acceptAll = () => {
    setAskAll(false);
    void runAcceptAll();
  };

  const requests = queue.requests ?? [];
  if (requests.length === 0 && problem === null && notice === null) {
    return null;
  }
  return (
    <section className={styles.panel} aria-labelledby="requests-title">
      <h2 id="requests-title" className={styles.title}>
        {t("requests.title")}
      </h2>
      <p className={styles.muted}>
        {t("requests.count", { count: formatNumber(queue.pending, language) })}
      </p>
      <Messages problem={problem} notice={notice} />
      {askAll ? (
        <ConfirmDialog
          language={language}
          title={t("requests.acceptAllTitle")}
          body={t("requests.acceptAllBody")}
          confirmLabel={t("requests.acceptAll")}
          noteLabel={null}
          busy={busy}
          cancel={() => setAskAll(false)}
          confirm={acceptAll}
        />
      ) : queue.pending > 0 ? (
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.button}
            disabled={busy}
            onClick={() => setAskAll(true)}
          >
            {t("requests.acceptAll")}
          </button>
        </div>
      ) : null}
      <ul className={styles.list} inert={askAll}>
        {requests.map((request) => (
          <RequestItem
            key={request.enrollmentId}
            request={request}
            t={t}
            busy={busy}
            act={(path) => void act(path)}
          />
        ))}
      </ul>
      {queue.more === null ? null : (
        <button type="button" className={styles.quiet} disabled={busy} onClick={queue.more}>
          {t("players.more")}
        </button>
      )}
    </section>
  );
}
