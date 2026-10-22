"use client";

import type { Language } from "@questify/shared";
import { useEffect, useState } from "react";
import { translatorFor } from "#src/lib/language.ts";
import styles from "#src/components/layout.module.css";

const TOKEN = /^[A-Za-z0-9_-]{50}$/;

/** The app link for the invite token in this page's fragment, or a note that the link is incomplete. */
export function OpenInApp({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const [token, setToken] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    setToken(TOKEN.test(hash) ? hash : null);
  }, []);
  if (token === undefined) {
    return null;
  }
  if (token === null) {
    return <p className={styles.muted}>{t("invitePage.missing")}</p>;
  }
  return (
    <a className={styles.button} href={`questify://operator-invite/${token}`}>
      {t("invitePage.open")}
    </a>
  );
}
