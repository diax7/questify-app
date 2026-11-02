"use client";

import type { Language } from "@questify/shared";
import { useEffect, useState } from "react";
import { CatalogState, EditorButtons, useCatalog } from "#src/components/CatalogParts.tsx";
import styles from "#src/components/catalog.module.css";
import {
  CONTACT_API,
  contactDocOf,
  contactDraftOf,
  contactProblems,
  isContactDirty,
  readContact,
  type ContactDraft,
} from "#src/lib/console-messaging.ts";
import { translatorFor } from "#src/lib/language.ts";
import { Field, Input } from "#src/ui/Field.tsx";
import { Stack } from "#src/ui/Section.tsx";

/**
 * The support contact (T-706, FR-1731): the WhatsApp number, the phone number and the email the contact page, the app and
 * the legal pages show. An empty field is not shown; numbers are in international form (+966...).
 */
export function SupportContactEditor({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const catalog = useCatalog(language, CONTACT_API, readContact);
  const row = catalog.state.kind === "ready" ? catalog.state.value : undefined;
  const [draft, setDraft] = useState<ContactDraft | null>(null);
  useEffect(() => {
    if (row !== undefined) {
      setDraft(contactDraftOf(row));
    }
  }, [row]);
  const wrong = draft === null ? new Set<string>() : contactProblems(draft);
  const field = (name: keyof ContactDraft, label: string, mode: "tel" | "email") => (
    <Field
      key={name}
      label={label}
      error={wrong.has(name) ? t("console.messages.contact.invalid") : undefined}
    >
      <Input
        dir="ltr"
        type={mode}
        inputMode={mode}
        value={draft?.[name] ?? ""}
        disabled={catalog.busy}
        onChange={(event) => setDraft({ ...(draft as ContactDraft), [name]: event.target.value })}
      />
    </Field>
  );
  return (
    <Stack>
      <CatalogState language={language} catalog={catalog}>
        {(current) =>
          draft === null ? null : (
            <form
              className={styles.card}
              data-testid="contact-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (wrong.size === 0) {
                  void catalog.save("", contactDocOf(draft));
                }
              }}
            >
              <Stack>
                {field("whatsapp", t("console.messages.contact.whatsapp"), "tel")}
                {field("phone", t("console.messages.contact.phone"), "tel")}
                {field("email", t("console.messages.contact.email"), "email")}
                <EditorButtons
                  language={language}
                  busy={catalog.busy}
                  canSave={wrong.size === 0 && isContactDirty(current, draft)}
                  onDiscard={() => setDraft(contactDraftOf(current))}
                />
              </Stack>
            </form>
          )
        }
      </CatalogState>
    </Stack>
  );
}
