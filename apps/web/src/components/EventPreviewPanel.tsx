"use client";

import type { Language } from "@questify/shared";
import { useState } from "react";
import { PreviewScreens } from "#src/components/PreviewScreens.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { LANGUAGE_NAMES } from "#src/lib/language.ts";
import { previewOf } from "#src/lib/preview.ts";
import { usePreview } from "#src/lib/use-preview.ts";
import { Muted, Notice } from "#src/ui/Feedback.tsx";
import { FieldGroup, Radio } from "#src/ui/Field.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Stack } from "#src/ui/Section.tsx";

/**
 * The event's player screens as players will see them, in Arabic or English (FR-1022, T-602). It reads what the team's
 * pages read and draws it by the app's own rules, so a switched-off feature is missing here as on the phone. Nothing in
 * it can be pressed.
 */
export function EventPreviewPanel({
  language,
  organizerId,
  eventId,
}: Readonly<{ language: Language; organizerId: string; eventId: string }>) {
  const t = useTranslator(language);
  const [shown, setShown] = useState<Language>(language);
  const read = usePreview(organizerId, eventId);
  return (
    <Stack>
      <PageHeader title={t("preview.title")} />
      <FieldGroup legend={t("preview.language")} layout="choices">
        {(["ar", "en"] as const).map((choice) => (
          <Radio
            key={choice}
            name="preview-language"
            checked={shown === choice}
            onChange={() => setShown(choice)}
            label={LANGUAGE_NAMES[choice]}
          />
        ))}
      </FieldGroup>
      {read.state === "loading" ? <Muted role="status">{t("common.loading")}</Muted> : null}
      {read.state === "failed" ? (
        <Notice role="alert" tone="danger">
          {t("preview.loadFailed")}
        </Notice>
      ) : null}
      {read.state === "ready" ? (
        <PreviewScreens
          preview={previewOf(read.source.event, read.source.categories, read.source.rewards, shown)}
          language={shown}
        />
      ) : null}
    </Stack>
  );
}
