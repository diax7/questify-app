"use client";

import type { Language } from "@questify/shared";
import { useState } from "react";
import { translatorFor } from "#src/lib/language.ts";
import { Button } from "#src/ui/Button.tsx";
import { Notice } from "#src/ui/Feedback.tsx";
import { FieldGroup, Input } from "#src/ui/Field.tsx";

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
    <FieldGroup>
      <Button variant="primary" onClick={() => void copy()}>
        {t(appStoreUrl === undefined ? "eventPage.copyOnly" : "eventPage.iphone")}
      </Button>
      {state === "copied" ? (
        <Notice tone="info" role="status">
          {t("eventPage.copied")}
        </Notice>
      ) : null}
      {state === "failed" ? (
        <>
          <Notice tone="danger" role="status">
            {t("eventPage.copyFailed")}
          </Notice>
          <Input
            dir="ltr"
            readOnly
            value={link}
            aria-label={t("eventPage.copyOnly")}
            ref={(field) => field?.select()}
          />
        </>
      ) : null}
    </FieldGroup>
  );
}
