"use client";

import type { Language, MarketingChannel } from "@questify/shared";
import { useState } from "react";
import { translatorFor } from "#src/lib/language.ts";
import { optOutResult, type OptOutResult } from "#src/lib/opt-out.ts";
import { postJson } from "#src/lib/post-json.ts";
import styles from "#src/components/layout.module.css";

type Props = Readonly<{
  language: Language;
  /** The signed token from the link; the API checks it. Null when the link cannot be read at all. */
  token: string | null;
  channel: MarketingChannel | null;
}>;

/**
 * The page an opt-out link opens (T-407, FR-1114). Opening the link changes nothing: mail programs and link scanners
 * open links, so the person confirms with a button, which posts the token. No sign-in is needed.
 */
export function OptOutForm({ language, token, channel }: Props) {
  const t = translatorFor(language);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<OptOutResult | null>(null);
  if (token === null || channel === null || result === "invalid") {
    return (
      <p role="alert" className={styles.alert}>
        {t("optOut.invalid")}
      </p>
    );
  }
  const name = t(`optOut.channel.${channel}`);
  if (result === "done") {
    return (
      <p role="status" className={styles.notice}>
        {t("optOut.done", { channel: name })}
      </p>
    );
  }
  const turnOff = async () => {
    setBusy(true);
    setResult(optOutResult(await postJson("/v1/public/marketing/opt-out", { token })));
    setBusy(false);
  };
  return (
    <div className={styles.form}>
      <p>{t("optOut.ask", { channel: name })}</p>
      {result === null ? null : (
        <p role="alert" className={styles.alert}>
          {t(result === "too_many" ? "optOut.tooMany" : "error.network")}
        </p>
      )}
      <button
        type="button"
        className={styles.button}
        disabled={busy}
        aria-busy={busy}
        onClick={() => void turnOff()}
      >
        {t("optOut.confirm")}
      </button>
    </div>
  );
}
