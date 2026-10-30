"use client";

import { formatNumber, type DailyLanguage, type Language } from "@questify/shared";
import { translatorFor } from "#src/lib/language.ts";
import { useWordImport } from "#src/lib/use-word-import.ts";
import type { ImportOutcome } from "#src/lib/word-import-run.ts";
import { Button } from "#src/ui/Button.tsx";
import { Muted, Notice } from "#src/ui/Feedback.tsx";
import { Field, Textarea } from "#src/ui/Field.tsx";
import { Stack, SubHeading, Toolbar } from "#src/ui/Section.tsx";

/** What the list of refused lines leaves out: the lines past the 50 the API shows, or that it may have left out. */
function HiddenRefusals({
  language,
  outcome,
}: Readonly<{ language: Language; outcome: ImportOutcome }>) {
  const t = translatorFor(language);
  const hidden = outcome.refusedCount - outcome.refused.length;
  if (hidden > 0) {
    return <p>{t("console.words.importRefusedMore", { count: formatNumber(hidden, language) })}</p>;
  }
  return outcome.refusedCapped ? <p>{t("console.words.importRefusedMaybe")}</p> : null;
}

function Outcome({ language, outcome }: Readonly<{ language: Language; outcome: ImportOutcome }>) {
  const t = translatorFor(language);
  return (
    <Notice tone="info" as="div" role="status" data-testid="word-import-result">
      <p>
        {t("console.words.importResult", {
          added: formatNumber(outcome.added, language),
          removed: formatNumber(outcome.removed, language),
          total: formatNumber(outcome.total, language),
        })}
      </p>
      {outcome.tooLong === 0 ? null : (
        <>
          <p>
            {t("console.words.importTooLong", { count: formatNumber(outcome.tooLong, language) })}
          </p>
          <ul data-testid="word-import-long">
            {outcome.longSamples.map((line, index) => (
              <li key={`${String(index)}-${line}`} dir="auto">
                {line}
              </li>
            ))}
          </ul>
        </>
      )}
      {outcome.refused.length === 0 ? null : (
        <>
          <p>{t("console.words.importRefused")}</p>
          <ul data-testid="word-import-refused">
            {outcome.refused.map((line, index) => (
              <li key={`${String(index)}-${line}`} dir="auto">
                {line}
              </li>
            ))}
          </ul>
          <HiddenRefusals language={language} outcome={outcome} />
        </>
      )}
    </Notice>
  );
}

/**
 * Adds words to a language's guess list, or removes them: one word per line. The words are valid guesses only; a
 * word becomes a daily word when it is scheduled. The lines the API refuses are shown.
 */
export function DailyWordImport({
  language,
  listLanguage,
  changed,
}: Readonly<{
  language: Language;
  listLanguage: DailyLanguage;
  /** Called with the list's new size after a change, so the list above can read again. */
  changed: (total: number) => void;
}>) {
  const t = translatorFor(language);
  const form = useWordImport(language, listLanguage, changed);
  return (
    <Stack as="section" aria-labelledby="daily-import">
      <SubHeading id="daily-import">{t("console.words.import")}</SubHeading>
      <Muted>{t("console.words.importHelp")}</Muted>
      <Field label={t("console.words.importField")}>
        <Textarea
          dir={listLanguage === "ar" ? "rtl" : "ltr"}
          lang={listLanguage}
          value={form.text}
          disabled={form.busy}
          onChange={(event) => form.setText(event.target.value)}
        />
      </Field>
      <Field label={t("console.words.importFile")}>
        <input
          type="file"
          accept=".txt,text/plain"
          disabled={form.busy}
          onChange={(event) => void form.load(event)}
        />
      </Field>
      <Muted>{t("console.words.importReady", { count: formatNumber(form.ready, language) })}</Muted>
      {form.problem === null ? null : (
        <Notice tone="danger" role="alert">
          {form.problem}
        </Notice>
      )}
      <Toolbar>
        <Button variant="primary" disabled={form.busy} onClick={() => void form.send("add")}>
          {t("console.words.importAdd")}
        </Button>
        <Button variant="quiet" disabled={form.busy} onClick={() => void form.send("remove")}>
          {t("console.words.importRemove")}
        </Button>
      </Toolbar>
      {form.outcome === null ? null : <Outcome language={language} outcome={form.outcome} />}
    </Stack>
  );
}
