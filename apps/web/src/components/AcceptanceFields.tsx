import { organizerDocuments, type Acceptance, type Language } from "@questify/shared";
import { translatorFor } from "#src/lib/language.ts";
import { Checkbox, FieldGroup } from "#src/ui/Field.tsx";
import { TextLink } from "#src/ui/Text.tsx";

const LABELS = {
  terms: "staff.accept.terms",
  dpa: "staff.accept.dpa",
  contentRules: "staff.accept.contentRules",
} as const;

/** The three documents an organizer accepts (FR-1726), each with a link to read it in a new tab. */
export function AcceptanceFields({
  language,
  disabled,
}: Readonly<{ language: Language; disabled: boolean }>) {
  const t = translatorFor(language);
  return (
    <FieldGroup layout="choices">
      {organizerDocuments().map((document) => (
        <Checkbox
          key={document.id}
          name={`accept-${document.field}`}
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

/** The versions in force for every box that is ticked; the API refuses anything else. */
export function acceptedFrom(form: FormData): Acceptance {
  const entries = organizerDocuments().map((document) => [
    document.field,
    form.get(`accept-${document.field}`) === "on" ? document.version : "",
  ]);
  return Object.fromEntries(entries) as Acceptance;
}
