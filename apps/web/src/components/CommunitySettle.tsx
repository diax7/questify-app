"use client";

import type { Language } from "@questify/shared";
import { useState } from "react";
import { ConfirmDialog } from "#src/components/ConfirmDialog.tsx";
import { settleAnswerOf } from "#src/lib/community.ts";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { errorCodeOf } from "#src/lib/sign-in-errors.ts";
import styles from "#src/components/layout.module.css";

/** How many times one press settles again (a transaction from the window still open, or more to pay) before it stops. */
const MAX_CALLS = 12;
/** The wait the API asks for while a transaction from a goal's window is still open (`Retry-After`). */
const SETTLING_WAIT_MS = 5000;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The owner's "Settle and pay now" on the results page (T-306b, ADR-226): asked for first, then calls the settle until
 * every community reward is paid, waiting when the last points are still being counted. `done` is told whether all is
 * paid; `failed` gets an answer that was neither.
 */
export function CommunitySettle({
  language,
  eventApi,
  done,
  failed,
}: Readonly<{
  language: Language;
  eventApi: string;
  done: (paid: boolean) => void;
  failed: (body: unknown) => void;
}>) {
  const t = translatorFor(language);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);

  const settle = async () => {
    setBusy(true);
    for (let call = 0; call < MAX_CALLS; call += 1) {
      const result = await requestJson(
        "POST",
        `${eventApi}/community/settle`,
        {},
        {
          "idempotency-key": crypto.randomUUID(),
        },
      );
      const answer = result.ok ? settleAnswerOf(result.body) : undefined;
      if (answer?.status === "paid") {
        setBusy(false);
        setAsking(false);
        done(true);
        return;
      }
      if (answer === undefined && errorCodeOf(result.body) !== "community_settling") {
        setBusy(false);
        setAsking(false);
        failed(result.body);
        return;
      }
      if (answer === undefined) {
        await pause(SETTLING_WAIT_MS);
      }
    }
    setBusy(false);
    setAsking(false);
    done(false);
  };

  return (
    <div className={styles.form}>
      {asking ? (
        <ConfirmDialog
          language={language}
          title={t("results.settleTitle")}
          body={t("results.settleBody")}
          confirmLabel={t("results.settleNow")}
          noteLabel={null}
          busy={busy}
          cancel={() => setAsking(false)}
          confirm={() => void settle()}
        />
      ) : null}
      {busy ? (
        <p role="status" className={styles.muted}>
          {t("results.settling")}
        </p>
      ) : null}
      <button
        type="button"
        className={styles.button}
        disabled={busy}
        onClick={() => setAsking(true)}
      >
        {t("results.settleNow")}
      </button>
    </div>
  );
}
