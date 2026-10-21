"use client";

import type { Language } from "@questify/shared";
import { useState } from "react";
import { translatorFor } from "#src/lib/language.ts";
import styles from "#src/components/layout.module.css";

type Props = Readonly<{
  language: Language;
  /** The event's join link, which the app's paste offer reads on first open (FR-114, `parseJoinLink`). */
  link: string;
  /** The App Store page; without it (before T-010) the button only copies. */
  appStoreUrl: string | undefined;
}>;

/**
 * The iPhone path (FR-114): copies the event's join link, then opens the App Store; the app offers to paste it on first
 * open. The store opens only after the copy finished; a refused copy says so and shows the link to copy by hand.
 */
export function CopyEventLink({ language, link, appStoreUrl }: Props) {
  const t = translatorFor(language);
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
    } catch {
      setState("failed");
      return;
    }
    setState("copied");
    if (appStoreUrl !== undefined) {
      window.location.assign(appStoreUrl);
    }
  };

  return (
    <div className={styles.form}>
      <button type="button" className={styles.button} onClick={() => void copy()}>
        {t(appStoreUrl === undefined ? "eventPage.copyOnly" : "eventPage.iphone")}
      </button>
      {state === "copied" ? (
        <p role="status" className={styles.notice}>
          {t("eventPage.copied")}
        </p>
      ) : null}
      {state === "failed" ? (
        <>
          <p role="status" className={styles.alert}>
            {t("eventPage.copyFailed")}
          </p>
          <input
            className={styles.input}
            dir="ltr"
            readOnly
            value={link}
            aria-label={t("eventPage.copyOnly")}
            ref={(field) => field?.select()}
          />
        </>
      ) : null}
    </div>
  );
}
