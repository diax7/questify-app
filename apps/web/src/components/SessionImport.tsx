"use client";

import {
  formatNumber,
  SESSION_LIMITS,
  parseSessionsCsv,
  type Language,
  type SessionImport,
  type SessionWindow,
} from "@questify/shared";
import { useState } from "react";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { sessionIssueKey } from "#src/lib/sessions.ts";
import { Button } from "#src/ui/Button.tsx";
import { Notice } from "#src/ui/Feedback.tsx";
import { Field, Input } from "#src/ui/Field.tsx";
import { infoTip } from "#src/ui/info.tsx";
import { Section, Toolbar } from "#src/ui/Section.tsx";

/** A file past this size is not read: 500 rows of sessions come to a fraction of it. */
const MAX_FILE_BYTES = 1_000_000;
/** Failed rows listed one by one; the rest are counted, so a wrong file cannot fill the page with notices. */
const SHOWN_FAILURES = 10;

/** What the file read did not give: a file too large, the rows that could not be read and the rows left out. */
function ImportNotices({
  language,
  parsed,
  tooBig,
}: Readonly<{ language: Language; parsed: SessionImport | null; tooBig: boolean }>) {
  const t = useTranslator(language);
  return (
    <>
      {tooBig ? (
        <Notice tone="warning">
          {t("sessions.page.importTooBig", {
            size: formatNumber(MAX_FILE_BYTES / 1_000_000, language),
          })}
        </Notice>
      ) : null}
      {parsed === null
        ? null
        : parsed.failed.slice(0, SHOWN_FAILURES).map((failure) => (
            <Notice key={failure.line} tone="warning">
              {t("sessions.page.importFailedRow", {
                line: formatNumber(failure.line, language),
                reason: t(sessionIssueKey(failure.issue)),
              })}
            </Notice>
          ))}
      {parsed !== null && parsed.failed.length > SHOWN_FAILURES ? (
        <Notice tone="warning">
          {t("sessions.page.importMoreFailed", {
            count: formatNumber(parsed.failed.length - SHOWN_FAILURES, language),
          })}
        </Notice>
      ) : null}
      {parsed !== null && parsed.skipped > 0 ? (
        <Notice tone="warning">
          {t("sessions.page.importSkipped", {
            limit: formatNumber(SESSION_LIMITS.importRows, language),
            count: formatNumber(parsed.skipped, language),
          })}
        </Notice>
      ) : null}
    </>
  );
}

/**
 * The import: a spreadsheet saved as CSV is read in the browser, every row is checked, the rows that cannot be read are
 * listed by line, and the rest are sent together (all or none, FR-808, FR-1794).
 */
export function SessionImportSection({
  language,
  zone,
  window,
  busy,
  template,
  send,
}: Readonly<{
  language: Language;
  zone: string;
  window: SessionWindow;
  busy: boolean;
  template: () => void;
  send: (parsed: SessionImport) => Promise<boolean>;
}>) {
  const t = useTranslator(language);
  const [parsed, setParsed] = useState<SessionImport | null>(null);
  const [version, setVersion] = useState(0);
  const [tooBig, setTooBig] = useState(false);
  const read = async (file: File | undefined) => {
    setTooBig(file !== undefined && file.size > MAX_FILE_BYTES);
    const readable = file !== undefined && file.size <= MAX_FILE_BYTES;
    setParsed(readable ? parseSessionsCsv(await file.text(), zone, window) : null);
  };
  const rows = parsed?.rows.length ?? 0;
  return (
    <Section title={t("sessions.page.import")}>
      <Field label={t("sessions.page.importFile")} info={infoTip(t, "sessions.page.importInfo")}>
        <Input
          key={version}
          type="file"
          accept=".csv,text/csv"
          disabled={busy}
          onChange={(event) => void read(event.target.files?.[0])}
        />
      </Field>
      <ImportNotices language={language} parsed={parsed} tooBig={tooBig} />
      {parsed !== null && rows === 0 ? (
        <Notice tone="info">{t("sessions.page.importNothing")}</Notice>
      ) : null}
      <Toolbar>
        <Button variant="quiet" onClick={template}>
          {t("sessions.page.template")}
        </Button>
        <Button
          variant="primary"
          disabled={busy || rows === 0}
          onClick={() => {
            if (parsed === null) return;
            void send(parsed).then((ok) => {
              if (!ok) return;
              setParsed(null);
              setVersion((current) => current + 1);
            });
          }}
        >
          {t("sessions.page.importSend", { count: formatNumber(rows, language) })}
        </Button>
      </Toolbar>
    </Section>
  );
}
