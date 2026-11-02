"use client";

import type { Acceptance, Language } from "@questify/shared";
import { translatorFor } from "#src/lib/language.ts";
import { useOrganizerDocuments } from "#src/lib/use-organizer-documents.ts";
import { Button } from "#src/ui/Button.tsx";
import { Muted, Notice } from "#src/ui/Feedback.tsx";
import { Checkbox, FieldGroup } from "#src/ui/Field.tsx";
import { TextLink } from "#src/ui/Text.tsx";

const LABELS = {
  terms: "staff.accept.terms",
  dpa: "staff.accept.dpa",
  contentRules: "staff.accept.contentRules",
} as const;

const FIELDS = ["terms", "dpa", "contentRules"] as const;

/**
 * The three documents an organizer accepts (FR-1726), each with a link to read it in a new tab. The versions in force come
 * from the API; each box carries its version as its value, so a ticked box is the version the person saw.
 */
export function AcceptanceFields({
  language,
  disabled,
}: Readonly<{ language: Language; disabled: boolean }>) {
  const t = translatorFor(language);
  const state = useOrganizerDocuments();
  if (state.kind === "loading") {
    return <Muted role="status">{t("common.loading")}</Muted>;
  }
  if (state.kind === "failed") {
    return (
      <Notice tone="danger" role="alert">
        {t("error.generic")}{" "}
        <Button size="sm" onClick={state.retry}>
          {t("common.retry")}
        </Button>
      </Notice>
    );
  }
  return (
    <FieldGroup layout="choices">
      {state.documents.map((document) => (
        <Checkbox
          key={document.id}
          name={`accept-${document.field}`}
          value={document.version}
          required
          disabled={disabled}
          label={
            <>
              {t(LABELS[document.field])} (
              <TextLink href={`/${language}/legal/${document.id}`} target="_blank" rel="noopener">
                {t("staff.readDocument")}
              </TextLink>
              )
            </>
          }
        />
      ))}
    </FieldGroup>
  );
}

/** The version of every box that is ticked (the box's value), empty for the others; the API refuses anything but the versions in force. */
export function acceptedFrom(form: FormData): Acceptance {
  const entries = FIELDS.map((field) => {
    const value = form.get(`accept-${field}`);
    return [field, typeof value === "string" ? value : ""];
  });
  return Object.fromEntries(entries) as Acceptance;
}
