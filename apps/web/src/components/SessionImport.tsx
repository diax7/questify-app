"use client";

import {
  formatNumber,
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
  const read = async (file: File | undefined) => {
    setParsed(file === undefined ? null : parseSessionsCsv(await file.text(), zone, window));
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
      {parsed === null
        ? null
        : parsed.failed.map((failure) => (
            <Notice key={failure.line} tone="warning">
              {t("sessions.page.importFailedRow", {
                line: formatNumber(failure.line, language),
                reason: t(sessionIssueKey(failure.issue)),
              })}
            </Notice>
          ))}
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
