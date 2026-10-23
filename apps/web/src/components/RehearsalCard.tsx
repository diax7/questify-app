"use client";

import { formatNumber, type Language } from "@questify/shared";
import { useCallback, useEffect, useState } from "react";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { erasedLine, holdsData, readRehearsal, type RehearsalView } from "#src/lib/rehearsal.ts";
import { describeProblem } from "#src/lib/sign-in-errors.ts";
import styles from "#src/components/layout.module.css";

type Props = Readonly<{ language: Language; organizerId: string; eventId: string }>;

type Confirming = "rotate" | "erase" | null;

/**
 * Rehearsal (FR-1721, FR-1722; T-211): the code the team joins with in the app, how much rehearsal holds, the notice
 * that go-live erases it, and Change code and Erase rehearsal, each confirmed. After go-live: what the wipe erased.
 */
export function RehearsalCard({ language, organizerId, eventId }: Props) {
  const t = translatorFor(language);
  const path = `/v1/organizers/${organizerId}/events/${eventId}/rehearsal`;
  const [view, setView] = useState<RehearsalView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    const result = await requestJson("GET", path);
    const read = result.ok
      ? readRehearsal((result.body as { rehearsal?: unknown } | undefined)?.rehearsal)
      : undefined;
    if (read === undefined) {
      setProblem(describeProblem(result.body, language, translatorFor(language)).text);
      return;
    }
    setProblem(null);
    setView(read);
  }, [path, language]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (what: "rotate" | "erase") => {
    setBusy(true);
    const result = await requestJson("POST", `${path}/${what === "rotate" ? "code" : "erase"}`);
    setBusy(false);
    setConfirming(null);
    if (!result.ok) {
      setProblem(describeProblem(result.body, language, t).text);
      return;
    }
    setCopied(false);
    await load();
  };

  const copy = async (code: string) => {
    await navigator.clipboard.writeText(code).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  };

  if (view === null) {
    return problem === null ? null : (
      <p role="alert" className={styles.alert}>
        {problem}
      </p>
    );
  }
  const erased = erasedLine(view);
  if (!view.open && erased === undefined) {
    return null;
  }
  const number = (value: number) => formatNumber(value, language);
  return (
    <section className={styles.card} aria-labelledby="rehearsal-title">
      <h2 id="rehearsal-title" className={styles.subtitle}>
        {t("rehearsal.title")}
      </h2>
      {problem === null ? null : (
        <p role="alert" className={styles.alert}>
          {problem}
        </p>
      )}
      {erased === undefined ? null : (
        <p role="status" className={styles.notice}>
          {t(erased.key, erased.params)}
        </p>
      )}
      {view.open && view.code !== null ? (
        <>
          <p>{t("rehearsal.intro")}</p>
          <p>
            <strong dir="ltr">{t("rehearsal.code", { code: view.code })}</strong>
          </p>
          <p className={styles.muted}>{t("rehearsal.onlyTeam")}</p>
          <p className={styles.muted}>
            {t("rehearsal.accounts", { count: number(view.now.accounts), cap: number(view.cap) })}
          </p>
          {holdsData(view.now) ? (
            <>
              <p className={styles.muted}>
                {t("rehearsal.counts", {
                  completions: number(view.now.completions),
                  points: number(view.now.points),
                  reservations: number(view.now.reservations),
                })}
              </p>
              <p role="status" className={styles.alert}>
                {t("rehearsal.notice")}
              </p>
            </>
          ) : null}
          {confirming === null ? (
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.button}
                onClick={() => void copy(view.code ?? "")}
              >
                {t("rehearsal.copy")}
              </button>
              <button
                type="button"
                className={styles.quiet}
                disabled={busy}
                onClick={() => setConfirming("rotate")}
              >
                {t("rehearsal.rotate")}
              </button>
              <button
                type="button"
                className={styles.quiet}
                disabled={busy}
                onClick={() => setConfirming("erase")}
              >
                {t("rehearsal.erase")}
              </button>
            </div>
          ) : (
            <div role="alertdialog" aria-labelledby="rehearsal-confirm" className={styles.card}>
              <p id="rehearsal-confirm">
                {t(confirming === "rotate" ? "rehearsal.rotateConfirm" : "rehearsal.eraseConfirm")}
              </p>
              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.quiet}
                  disabled={busy}
                  onClick={() => setConfirming(null)}
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  className={styles.button}
                  disabled={busy}
                  onClick={() => void act(confirming)}
                >
                  {t(confirming === "rotate" ? "rehearsal.rotate" : "rehearsal.erase")}
                </button>
              </div>
            </div>
          )}
          {copied ? (
            <p role="status" className={styles.muted}>
              {t("rehearsal.copied")}
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
