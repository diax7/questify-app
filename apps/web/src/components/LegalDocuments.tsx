"use client";

import type { Language, LegalDocumentId } from "@questify/shared";
import { useState } from "react";
import { CatalogState } from "#src/components/CatalogParts.tsx";
import { ConfirmedButton, keyed, useWrite } from "#src/components/ConsoleOversight.tsx";
import styles from "#src/components/catalog.module.css";
import {
  DOCUMENT_NAMES,
  LEGAL_API,
  ORGANIZER_DOCUMENTS,
  PLAYER_DOCUMENTS,
  checkPublish,
  publicTextPath,
  publishDraftOf,
  readLegal,
  readPublicText,
  versionsPath,
  type LegalDocuments as Documents,
  type PublishDraft,
} from "#src/lib/console-legal.ts";
import { directionOf, translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { useConsoleRead } from "#src/lib/use-console-read.ts";
import { Button } from "#src/ui/Button.tsx";
import { Badge } from "#src/ui/Feedback.tsx";
import { Field, Input, Textarea } from "#src/ui/Field.tsx";
import { IconButton } from "#src/ui/IconControl.tsx";
import { Stack, SubHeading, Toolbar } from "#src/ui/Section.tsx";

type Entry = Documents[number];

function PublishEditor({
  language,
  document,
  inForce,
  busy,
  onPublish,
  onDone,
}: Readonly<{
  language: Language;
  document: LegalDocumentId;
  inForce: string;
  busy: boolean;
  onPublish: (draft: PublishDraft) => void;
  onDone: () => void;
}>) {
  const t = translatorFor(language);
  const [draft, setDraft] = useState<PublishDraft>(() => publishDraftOf(inForce));
  const checked = checkPublish(draft);
  const wrong = checked.ok ? new Set<string>() : checked.fields;
  const invalid = (field: string) => (wrong.has(field) ? t("console.catalog.invalid") : undefined);
  const fill = async (): Promise<void> => {
    const result = await requestJson("GET", publicTextPath(document));
    const text = result.ok ? readPublicText(result.body) : undefined;
    if (text !== undefined) {
      setDraft((before) => ({ ...before, ar: text.ar ?? before.ar, en: text.en ?? before.en }));
    }
  };
  return (
    <form onSubmit={(event) => event.preventDefault()}>
      <Stack>
        <Field label={t("console.legal.version")} error={invalid("version")}>
          <Input
            dir="ltr"
            value={draft.version}
            disabled={busy}
            onChange={(event) => setDraft({ ...draft, version: event.target.value })}
          />
        </Field>
        <div className={styles.pair}>
          {(["en", "ar"] as const).map((code) => (
            <Field
              key={code}
              label={t(code === "ar" ? "console.legal.textAr" : "console.legal.textEn")}
              error={invalid(`text.${code}`)}
            >
              <Textarea
                lang={code}
                dir={directionOf(code)}
                rows={12}
                value={draft[code]}
                disabled={busy}
                onChange={(event) => setDraft({ ...draft, [code]: event.target.value })}
              />
            </Field>
          ))}
        </div>
        <Field label={t("console.legal.why")} error={invalid("note")}>
          <Input
            value={draft.note}
            disabled={busy}
            onChange={(event) => setDraft({ ...draft, note: event.target.value })}
          />
        </Field>
        <Toolbar>
          <Button variant="secondary" disabled={busy} onClick={() => void fill()}>
            {t("console.legal.loadCurrent")}
          </Button>
          <Button variant="quiet" disabled={busy} onClick={onDone}>
            {t("console.catalog.discard")}
          </Button>
        </Toolbar>
        <ConfirmedButton
          language={language}
          label={t("console.legal.publish")}
          question={t("console.legal.publishAsk", { version: draft.version.trim() })}
          variant="primary"
          disabled={busy || !checked.ok}
          act={() => onPublish(draft)}
        />
      </Stack>
    </form>
  );
}

function DocumentCard({
  language,
  entry,
  busy,
  publish,
}: Readonly<{
  language: Language;
  entry: Entry;
  busy: boolean;
  publish: (document: LegalDocumentId, draft: PublishDraft) => Promise<boolean>;
}>) {
  const t = translatorFor(language);
  const [editing, setEditing] = useState(false);
  const current = entry.versions.find((version) => version.inForce)?.version ?? "";
  const name = t(DOCUMENT_NAMES[entry.document]);
  return (
    <li
      className={styles.card}
      data-testid="legal-card"
      data-id={entry.document}
      data-editing={editing}
    >
      <div className={styles.head}>
        <span className={styles.name}>
          {name} <Badge tone="info">{t("console.legal.inForce", { version: current })}</Badge>
        </span>
        <div className={styles.tools}>
          <IconButton
            icon="edit"
            label={t("console.legal.newVersion", { name })}
            disabled={busy || editing}
            onClick={() => setEditing(true)}
          />
        </div>
      </div>
      {editing ? (
        <PublishEditor
          language={language}
          document={entry.document}
          inForce={current}
          busy={busy}
          onPublish={(draft) =>
            void publish(entry.document, draft).then((done) =>
              done ? setEditing(false) : undefined,
            )
          }
          onDone={() => setEditing(false)}
        />
      ) : (
        <ul className={styles.facts} dir="ltr" aria-label={t("console.legal.history")}>
          {entry.versions.map((version) => (
            <li key={version.version} data-testid="legal-version">
              v{version.version} · {version.publishedAt.slice(0, 10)}
              {version.hasText ? "" : ` · ${t("console.legal.noText")}`}
              {version.note === null ? "" : ` · ${version.note}`}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function Group({
  language,
  heading,
  ids,
  documents,
  busy,
  publish,
}: Readonly<{
  language: Language;
  heading: string;
  ids: readonly LegalDocumentId[];
  documents: Documents;
  busy: boolean;
  publish: (document: LegalDocumentId, draft: PublishDraft) => Promise<boolean>;
}>) {
  return (
    <>
      <SubHeading as="h3">{heading}</SubHeading>
      <ul className={styles.cards}>
        {documents
          .filter((entry) => ids.includes(entry.document))
          .map((entry) => (
            <DocumentCard
              key={entry.document}
              language={language}
              entry={entry}
              busy={busy}
              publish={publish}
            />
          ))}
      </ul>
    </>
  );
}

/**
 * The six legal documents (T-707, FR-1781): the version in force and the history of each, and a form to publish a later
 * version with its Arabic and English text. A published version is in force at once and can never be edited; a correction
 * is a newer version. Platform admins only.
 */
export function LegalDocuments({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const { state, reload } = useConsoleRead(LEGAL_API, readLegal);
  const [notice, setNotice] = useState<string | null>(null);
  const write = useWrite(language, (done) => {
    setNotice(done);
    void reload();
  });
  const publish = (document: LegalDocumentId, draft: PublishDraft): Promise<boolean> => {
    const checked = checkPublish(draft);
    if (!checked.ok) {
      return Promise.resolve(false);
    }
    return write.run(
      () => requestJson("POST", versionsPath(document), checked.doc, keyed()),
      t("console.legal.published", { version: checked.doc.version }),
    );
  };
  return (
    <Stack>
      <CatalogState language={language} catalog={{ state, reload, problem: write.problem, notice }}>
        {(documents) => (
          <>
            <Group
              language={language}
              heading={t("console.legal.players")}
              ids={PLAYER_DOCUMENTS}
              documents={documents}
              busy={write.busy}
              publish={publish}
            />
            <Group
              language={language}
              heading={t("console.legal.organizers")}
              ids={ORGANIZER_DOCUMENTS}
              documents={documents}
              busy={write.busy}
              publish={publish}
            />
          </>
        )}
      </CatalogState>
    </Stack>
  );
}
