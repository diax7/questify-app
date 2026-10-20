import { organizerDocuments, type Acceptance, type Language } from "@questify/shared";
import { translatorFor } from "#src/lib/language.ts";
import styles from "#src/components/layout.module.css";

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
    <fieldset className={styles.choices}>
      {organizerDocuments().map((document) => (
        <label key={document.id} className={styles.check}>
          <input type="checkbox" name={`accept-${document.field}`} required disabled={disabled} />
          <span>
            {t(LABELS[document.field])} (
            <a
              className={styles.textLink}
              href={`/${language}/legal/${document.id}`}
              target="_blank"
              rel="noopener"
            >
              {t("staff.readDocument")}
            </a>
            )
          </span>
        </label>
      ))}
    </fieldset>
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
