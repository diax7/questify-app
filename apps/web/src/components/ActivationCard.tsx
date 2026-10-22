"use client";

import { formatEventTime, type Language } from "@questify/shared";
import { useCallback, useEffect, useState } from "react";
import {
  addonName,
  limitBanner,
  limitLine,
  readActivation,
  type ActivationView,
} from "#src/lib/activation.ts";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem } from "#src/lib/sign-in-errors.ts";
import styles from "#src/components/layout.module.css";

type Props = Readonly<{
  language: Language;
  organizerId: string;
  eventId: string;
  myRole: "owner" | "editor";
}>;

const readerZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * Where the event stands with Questify (FR-1019, FR-1020, FR-1021, FR-1729): the owner requests or withdraws
 * activation; once activated, the limit, the 80% and 100% banners, and the add-ons. No price appears anywhere.
 */
export function ActivationCard({ language, organizerId, eventId, myRole }: Props) {
  const t = translatorFor(language);
  const path = `/v1/organizers/${organizerId}/events/${eventId}/activation`;
  const [view, setView] = useState<ActivationView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    const result = await requestJson("GET", path);
    const read = result.ok
      ? readActivation((result.body as { activation?: unknown } | undefined)?.activation)
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

  const act = async (method: "POST" | "DELETE") => {
    setBusy(true);
    const result = await requestJson(method, path);
    setBusy(false);
    setConfirming(false);
    if (!result.ok) {
      setProblem(describeProblem(result.body, language, t).text);
      return;
    }
    await load();
  };

  if (view === null) {
    return problem === null ? null : (
      <p role="alert" className={styles.alert}>
        {problem}
      </p>
    );
  }
  const banner = limitBanner(view);
  const limit = limitLine(view);
  return (
    <section className={styles.card} aria-labelledby="activation-title">
      <h2 id="activation-title" className={styles.subtitle}>
        {t("activation.title")}
      </h2>
      {problem === null ? null : (
        <p role="alert" className={styles.alert}>
          {problem}
        </p>
      )}
      {banner === undefined ? null : (
        <p role="status" className={styles.alert}>
          {t(banner.key, banner.params)}
        </p>
      )}
      {view.state === "activated" ? (
        <>
          <p>{t(limit.key, limit.params)}</p>
          <p className={styles.muted}>{t("activation.players", { count: view.players })}</p>
          <p className={styles.muted}>
            {view.addons.length === 0
              ? t("activation.noAddons")
              : t("activation.addons", {
                  list: view.addons.map((feature) => addonName(feature, t)).join("، "),
                })}
          </p>
        </>
      ) : (
        <DraftActions
          language={language}
          view={view}
          isOwner={myRole === "owner"}
          busy={busy}
          confirming={confirming}
          setConfirming={setConfirming}
          act={(method) => void act(method)}
        />
      )}
    </section>
  );
}

/** A draft's lines and buttons: request (owner), the request's date and withdraw, or the rejection note. */
function DraftActions({
  language,
  view,
  isOwner,
  busy,
  confirming,
  setConfirming,
  act,
}: Readonly<{
  language: Language;
  view: ActivationView;
  isOwner: boolean;
  busy: boolean;
  confirming: boolean;
  setConfirming: (value: boolean) => void;
  act: (method: "POST" | "DELETE") => void;
}>) {
  const t = translatorFor(language);
  if (confirming) {
    return (
      <div role="alertdialog" aria-labelledby="withdraw-title" className={styles.card}>
        <p id="withdraw-title">{t("activation.withdrawConfirm")}</p>
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
            onClick={() => act("DELETE")}
          >
            {t("activation.withdraw")}
          </button>
        </div>
      </div>
    );
  }
  return (
    <>
      <p>{t("activation.notActivated")}</p>
      {view.state === "requested" && view.requestedAt !== null ? (
        <p role="status" className={styles.notice}>
          {t("activation.requested", {
            date: formatEventTime(new Date(view.requestedAt), readerZone(), language),
          })}
        </p>
      ) : null}
      {view.state === "rejected" && view.note !== null ? (
        <p className={styles.alert}>{t("activation.rejected", { note: view.note })}</p>
      ) : null}
      {isOwner ? (
        <div className={styles.actions}>
          {view.state === "requested" ? (
            <button
              type="button"
              className={styles.quiet}
              disabled={busy}
              onClick={() => setConfirming(true)}
            >
              {t("activation.withdraw")}
            </button>
          ) : (
            <button
              type="button"
              className={styles.button}
              disabled={busy}
              onClick={() => act("POST")}
            >
              {t(view.state === "rejected" ? "activation.requestAgain" : "activation.request")}
            </button>
          )}
        </div>
      ) : (
        <p className={styles.muted}>{t("activation.editorHint")}</p>
      )}
      <p className={styles.muted}>{t("activation.priceNote")}</p>
    </>
  );
}
