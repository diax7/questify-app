"use client";

import { formatNumber, type Language } from "@questify/shared";
import { useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "#src/components/ConfirmDialog.tsx";
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

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);

type Props = Readonly<{ language: Language; organizerId: string; eventId: string }>;

/**
 * The event's join requests and waiting list (T-218, FR-1819, FR-1821): the owner and editors accept or decline each,
 * or accept all (oldest first, while places are free) after a confirmation. Shown only while there are any.
 */
export function JoinRequestsPanel({ language, organizerId, eventId }: Props) {
  const t = translatorFor(language);
  const base = `/v1/organizers/${organizerId}/events/${eventId}/join-requests`;
  const loaded = useRef(false);
  const [requests, setRequests] = useState<JoinRequest[] | null>(null);
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

  const load = async () => {
    const result = await requestJson("GET", `${base}?limit=100`);
    if (!result.ok) {
      failed(result.body);
      return;
    }
    setRequests((result.body as { requests: JoinRequest[] }).requests);
  };

  useEffect(() => {
    // Stryker disable next-line ConditionalExpression,BlockStatement: React runs effects twice in development only
    if (loaded.current) {
      return;
    }
    loaded.current = true;
    void load();
  });

  const act = async (path: string, said: (body: unknown) => string | null) => {
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
    setNotice(said(result.body));
    await load();
  };

  if (requests === null || requests.length === 0) {
    return problem === null ? null : (
      <p role="alert" className={styles.alert}>
        {problem}
      </p>
    );
  }
  const waiting = requests.filter((request) => request.status === "pending").length;
  return (
    <section className={styles.panel} aria-labelledby="requests-title">
      <h2 id="requests-title" className={styles.title}>
        {t("requests.title")}
      </h2>
      <p className={styles.muted}>
        {t("requests.count", { count: formatNumber(waiting, language) })}
      </p>
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
      {askAll ? (
        <ConfirmDialog
          language={language}
          title={t("requests.acceptAllTitle")}
          body={t("requests.acceptAllBody")}
          confirmLabel={t("requests.acceptAll")}
          noteLabel={null}
          busy={busy}
          cancel={() => setAskAll(false)}
          confirm={() =>
            void act("accept-all", (body) => {
              const done = body as { accepted: number; remaining: number };
              return t("requests.acceptedAll", {
                accepted: formatNumber(done.accepted, language),
                remaining: formatNumber(done.remaining, language),
              });
            })
          }
        />
      ) : waiting > 0 ? (
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
          <li key={request.enrollmentId} className={styles.card}>
            <p className={styles.row}>
              <strong dir="auto">@{request.username}</strong>
              <span className={styles.badge}>
                {t(
                  request.status === "declined"
                    ? "players.status.declined"
                    : request.waitlisted
                      ? "requests.waitlist"
                      : "requests.asked",
                )}
              </span>
            </p>
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.button}
                disabled={busy}
                aria-label={`${t("requests.accept")} @${request.username}`}
                onClick={() => void act(`${request.enrollmentId}/accept`, () => null)}
              >
                {t("requests.accept")}
              </button>
              {request.status === "pending" ? (
                <button
                  type="button"
                  className={styles.quiet}
                  disabled={busy}
                  aria-label={`${t("requests.decline")} @${request.username}`}
                  onClick={() => void act(`${request.enrollmentId}/decline`, () => null)}
                >
                  {t("requests.decline")}
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
