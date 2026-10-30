"use client";

import type { Language } from "@questify/shared";
import { useEffect, useState } from "react";
import { LANGUAGE_NAMES, otherLanguage, translatorFor } from "#src/lib/language.ts";
import { ButtonLink } from "#src/ui/Button.tsx";
import { Muted } from "#src/ui/Feedback.tsx";
import { TextLink } from "#src/ui/Text.tsx";

const TOKEN = /^[A-Za-z0-9_-]{50}$/;

/** The invite token in this page's fragment: undefined before it is read, null when there is none. */
function useFragmentToken(): string | null | undefined {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    setToken(TOKEN.test(hash) ? hash : null);
  }, []);
  return token;
}

/** The same page in the other language, keeping the token: the fragment never reaches the server, so it is added here. */
export function OtherLanguageLink({ language }: Readonly<{ language: Language }>) {
  const token = useFragmentToken();
  const other = otherLanguage(language);
  return (
    <TextLink
      href={`/${other}/op${typeof token === "string" ? `#${token}` : ""}`}
      lang={other}
      hrefLang={other}
    >
      {LANGUAGE_NAMES[other]}
    </TextLink>
  );
}

/**
 * The app link for the invite token in this page's fragment, or a note that the link is incomplete. Without the app the
 * link does nothing, so the store links follow it when they are set.
 */
export function OpenInApp({
  language,
  appStoreUrl,
  playStoreUrl,
}: Readonly<{
  language: Language;
  appStoreUrl?: string | undefined;
  playStoreUrl?: string | undefined;
}>) {
  const t = translatorFor(language);
  const token = useFragmentToken();
  if (token === undefined) {
    return null;
  }
  if (token === null) {
    return <Muted>{t("invitePage.missing")}</Muted>;
  }
  return (
    <>
      <ButtonLink variant="primary" href={`questify://operator-invite/${token}`}>
        {t("invitePage.open")}
      </ButtonLink>
      {playStoreUrl === undefined ? null : (
        <TextLink href={playStoreUrl}>{t("eventPage.play")}</TextLink>
      )}
      {appStoreUrl === undefined ? null : <TextLink href={appStoreUrl}>App Store</TextLink>}
    </>
  );
}
