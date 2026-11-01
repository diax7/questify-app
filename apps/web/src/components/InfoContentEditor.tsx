"use client";

import {
  CONTACTS_MAX,
  CONTACT_KINDS,
  FAQ_MAX,
  INFO_LIMITS,
  LINK_URL_MAX,
  type Contact,
  type ContactKind,
  type FaqEntry,
  type HomeContent,
  type InfoSection,
  type Language,
} from "@questify/shared";
import { EntryList, type EntryNames } from "#src/components/EntryList.tsx";
import { EditorSection, TextPair } from "#src/components/HomeContentFields.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { emptyContact, emptyFaq } from "#src/lib/home-content-editor.ts";
import { Button } from "#src/ui/Button.tsx";
import { Field, Input, Select } from "#src/ui/Field.tsx";

const FAQ_NAMES: EntryNames = {
  earlier: "layout.faq.earlier",
  later: "layout.faq.later",
  remove: "layout.faq.remove",
};
const CONTACT_NAMES: EntryNames = {
  earlier: "layout.contact.earlier",
  later: "layout.contact.later",
  remove: "layout.contact.remove",
};

/** The input of a contact's value: the kind decides its label, what the keyboard offers and the longest value the server takes. */
const VALUE_FIELDS = {
  email: { label: "layout.field.email", type: "email", max: INFO_LIMITS.contactValue },
  phone: { label: "layout.field.phone", type: "tel", max: INFO_LIMITS.contactValue },
  link: { label: "layout.field.url", type: "url", max: LINK_URL_MAX },
} as const;

type EditorProps<T> = Readonly<{ language: Language; value: T; onChange: (next: T) => void }>;

function FaqEditor({ language, value, onChange }: EditorProps<FaqEntry>) {
  return (
    <>
      <TextPair
        language={language}
        field="layout.field.question"
        value={value.question}
        max={INFO_LIMITS.question}
        onChange={(question) => onChange({ ...value, question })}
      />
      <TextPair
        language={language}
        field="layout.field.answer"
        value={value.answer}
        max={INFO_LIMITS.answer}
        multiline
        onChange={(answer) => onChange({ ...value, answer })}
      />
    </>
  );
}

function ContactEditor({ language, value, onChange }: EditorProps<Contact>) {
  const t = useTranslator(language);
  const field = VALUE_FIELDS[value.kind];
  return (
    <>
      <TextPair
        language={language}
        field="layout.field.label"
        value={value.label}
        max={INFO_LIMITS.contactLabel}
        onChange={(label) => onChange({ ...value, label })}
      />
      <Field label={t("layout.field.contactKind")}>
        <Select
          value={value.kind}
          onChange={(event) =>
            onChange({ ...value, kind: event.target.value as ContactKind, value: "" })
          }
        >
          {CONTACT_KINDS.map((kind) => (
            <option key={kind} value={kind}>
              {t(`layout.contact.${kind}`)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t(field.label)}>
        <Input
          type={field.type}
          dir="ltr"
          maxLength={field.max}
          value={value.value}
          onChange={(event) => onChange({ ...value, value: event.target.value })}
        />
      </Field>
    </>
  );
}

/**
 * The editor of one section of the event info page that holds the organizer's own words (FR-1835): the About text, the
 * questions and answers, or the ways to reach the organizer. It edits the page's draft, so the preview redraws as the organizer
 * types, and nothing is saved until Save layout.
 */
export function InfoContentEditor({
  language,
  section,
  title,
  content,
  onChange,
  onClose,
}: Readonly<{
  language: Language;
  section: InfoSection;
  title: string;
  content: HomeContent;
  onChange: (next: HomeContent) => void;
  onClose: () => void;
}>) {
  const t = useTranslator(language);
  return (
    <EditorSection language={language} title={title} onClose={onClose}>
      {section === "about" ? (
        <TextPair
          language={language}
          field="layout.field.body"
          value={content.about}
          max={INFO_LIMITS.about}
          multiline
          onChange={(about) => onChange({ ...content, about })}
        />
      ) : null}
      {section === "faq" ? (
        <EntryList
          language={language}
          entries={content.faq}
          limit={FAQ_MAX}
          heading={(_entry, n) => t("layout.faq", { n })}
          names={FAQ_NAMES}
          footer={
            <Button
              variant="secondary"
              onClick={() => onChange({ ...content, faq: [...content.faq, emptyFaq()] })}
            >
              {t("layout.faq.add")}
            </Button>
          }
          onChange={(faq) => onChange({ ...content, faq })}
        >
          {(entry, replace) => <FaqEditor language={language} value={entry} onChange={replace} />}
        </EntryList>
      ) : null}
      {section === "contacts" ? (
        <EntryList
          language={language}
          entries={content.contacts}
          limit={CONTACTS_MAX}
          heading={(_entry, n) => t("layout.contact", { n })}
          names={CONTACT_NAMES}
          footer={
            <Button
              variant="secondary"
              onClick={() =>
                onChange({ ...content, contacts: [...content.contacts, emptyContact()] })
              }
            >
              {t("layout.contact.add")}
            </Button>
          }
          onChange={(contacts) => onChange({ ...content, contacts })}
        >
          {(entry, replace) => (
            <ContactEditor language={language} value={entry} onChange={replace} />
          )}
        </EntryList>
      ) : null}
    </EditorSection>
  );
}
