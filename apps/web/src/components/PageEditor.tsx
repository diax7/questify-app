"use client";

import {
  INFO_LIMITS,
  LINK_URL_MAX,
  LIST_ITEMS_MAX,
  PAGE_BLOCKS_MAX,
  PAGE_BLOCK_KINDS,
  type CustomPage,
  type Language,
  type PageBlock,
} from "@questify/shared";
import { EntryList, type EntryNames } from "#src/components/EntryList.tsx";
import { TextPair } from "#src/components/HomeContentFields.tsx";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { emptyPage, emptyPart } from "#src/lib/home-content-editor.ts";
import { Button } from "#src/ui/Button.tsx";
import { Field, Input } from "#src/ui/Field.tsx";
import { Muted } from "#src/ui/Feedback.tsx";
import { Toolbar } from "#src/ui/Section.tsx";

const PART_NAMES: EntryNames = {
  earlier: "layout.part.earlier",
  later: "layout.part.later",
  remove: "layout.part.remove",
};

/** A list holds up to ten lines of up to 120 characters each, and the box takes that many. */
const LIST_BOX_MAX = LIST_ITEMS_MAX * (INFO_LIMITS.listItem + 1);

function PartEditor({
  language,
  value,
  onChange,
}: Readonly<{ language: Language; value: PageBlock; onChange: (next: PageBlock) => void }>) {
  const t = useTranslator(language);
  switch (value.kind) {
    case "heading":
      return (
        <TextPair
          language={language}
          field="layout.field.title"
          value={value.text}
          max={INFO_LIMITS.heading}
          onChange={(text) => onChange({ ...value, text })}
        />
      );
    case "text":
      return (
        <TextPair
          language={language}
          field="layout.field.body"
          value={value.text}
          max={INFO_LIMITS.paragraph}
          multiline
          onChange={(text) => onChange({ ...value, text })}
        />
      );
    case "list":
      return (
        <TextPair
          language={language}
          field="layout.field.items"
          value={value.items}
          max={LIST_BOX_MAX}
          multiline
          onChange={(items) => onChange({ ...value, items })}
        />
      );
    default:
      return (
        <>
          <TextPair
            language={language}
            field="layout.field.label"
            value={value.label}
            max={INFO_LIMITS.linkLabel}
            onChange={(label) => onChange({ ...value, label })}
          />
          <Field label={t("layout.field.url")}>
            <Input
              type="url"
              dir="ltr"
              placeholder="https://"
              maxLength={LINK_URL_MAX}
              value={value.url}
              onChange={(event) => onChange({ ...value, url: event.target.value })}
            />
          </Field>
        </>
      );
  }
}

function AddParts({
  language,
  page,
  onChange,
}: Readonly<{ language: Language; page: CustomPage; onChange: (next: CustomPage) => void }>) {
  const t = useTranslator(language);
  return (
    <>
      {PAGE_BLOCK_KINDS.map((kind) => (
        <Button
          key={kind}
          variant="secondary"
          onClick={() => onChange({ ...page, blocks: [...page.blocks, emptyPart(kind)] })}
        >
          {t(`layout.part.add.${kind}`)}
        </Button>
      ))}
    </>
  );
}

/**
 * The editor of the one extra page (FR-1835): a title and up to twelve parts, each a heading, a paragraph, a list or a link, in
 * the order they are shown. Pictures wait for the photo storage (T-613b). With no page there is a button to add one; with a
 * page there is a button to remove it, which asks first.
 */
export function PageEditor({
  language,
  page,
  onChange,
  onRemove,
}: Readonly<{
  language: Language;
  page: CustomPage | null;
  onChange: (next: CustomPage | null) => void;
  onRemove: () => void;
}>) {
  const t = useTranslator(language);
  if (page === null) {
    return (
      <Toolbar>
        <Button variant="secondary" onClick={() => onChange(emptyPage())}>
          {t("layout.page.add")}
        </Button>
      </Toolbar>
    );
  }
  return (
    <>
      <TextPair
        language={language}
        field="layout.field.title"
        value={page.title}
        max={INFO_LIMITS.pageTitle}
        onChange={(title) => onChange({ ...page, title })}
      />
      <EntryList
        language={language}
        entries={page.blocks}
        limit={PAGE_BLOCKS_MAX}
        heading={(part, n) => t("layout.part", { kind: t(`layout.part.${part.kind}`), n })}
        names={PART_NAMES}
        footer={<AddParts language={language} page={page} onChange={onChange} />}
        onChange={(blocks) => onChange({ ...page, blocks })}
      >
        {(part, replace) => <PartEditor language={language} value={part} onChange={replace} />}
      </EntryList>
      {page.blocks.length < PAGE_BLOCKS_MAX ? null : (
        <Muted>{t("layout.partsFull", { max: PAGE_BLOCKS_MAX })}</Muted>
      )}
      <Toolbar>
        <Button variant="quiet" onClick={onRemove}>
          {t("layout.page.remove")}
        </Button>
      </Toolbar>
    </>
  );
}
