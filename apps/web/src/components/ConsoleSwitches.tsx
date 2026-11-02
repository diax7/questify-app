"use client";

import type { FeatureRow, Language, MessageKey, SwitchesView, TuningRow } from "@questify/shared";
import { useState } from "react";
import { CatalogState, PairInputs } from "#src/components/CatalogParts.tsx";
import { keyed, useWrite } from "#src/components/ConsoleOversight.tsx";
import styles from "#src/components/catalog.module.css";
import {
  SWITCHES_API,
  SWITCH_TABS,
  checkMessage,
  featureBody,
  featurePath,
  isMessageDirty,
  messageDraftOf,
  nameKeyOf,
  numberFor,
  readSwitches,
  tuningPath,
  type MessageDraft,
  type SwitchTab,
} from "#src/lib/console-switches.ts";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { useConsoleRead } from "#src/lib/use-console-read.ts";
import { Button } from "#src/ui/Button.tsx";
import { Badge } from "#src/ui/Feedback.tsx";
import { Field, Input, Switch } from "#src/ui/Field.tsx";
import { IconButton } from "#src/ui/IconControl.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Stack, Toolbar } from "#src/ui/Section.tsx";
import { Tabs } from "#src/ui/Tabs.tsx";
import { infoTip } from "#src/ui/info.tsx";

type Writer = Readonly<{
  busy: boolean;
  put: (path: string, body: object) => Promise<boolean>;
  reset: (path: string) => Promise<boolean>;
}>;

/** The message players see while a feature is off, in both languages, saved with its own button. */
function MessageForm({
  language,
  row,
  writer,
  draft,
  onChange,
}: Readonly<{
  language: Language;
  row: FeatureRow;
  writer: Writer;
  draft: MessageDraft;
  onChange: (next: MessageDraft) => void;
}>) {
  const t = translatorFor(language);
  const checked = checkMessage(draft);
  const wrong = checked.ok ? new Set<string>() : checked.fields;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void writer.put(featurePath(row.key), featureBody(false, draft));
      }}
    >
      <Stack>
        <PairInputs
          language={language}
          label={t("console.switches.message")}
          field="message"
          value={draft}
          invalid={wrong}
          disabled={writer.busy}
          onChange={onChange}
        />
        <Toolbar>
          <Button
            type="submit"
            disabled={writer.busy || !checked.ok || !isMessageDirty(row, draft)}
          >
            {t("console.switches.saveMessage")}
          </Button>
        </Toolbar>
      </Stack>
    </form>
  );
}

/** One feature: its switch, and while it is off the message players see, in both languages. */
function FeatureCard({
  language,
  row,
  writer,
}: Readonly<{ language: Language; row: FeatureRow; writer: Writer }>) {
  const t = translatorFor(language);
  const [draft, setDraft] = useState<MessageDraft>(() => messageDraftOf(row));
  const nameKey = nameKeyOf("feature", row.key);
  const name = nameKey === undefined ? row.key : t(nameKey);
  const path = featurePath(row.key);
  return (
    <li className={styles.card} data-testid="switch-card" data-feature={row.key}>
      <div className={styles.head}>
        <span className={styles.name}>
          <Switch
            label={name}
            checked={row.enabled}
            disabled={writer.busy}
            onChange={(event) => void writer.put(path, featureBody(event.target.checked, draft))}
          />
          {row.changed ? <Badge tone="info">{t("console.catalog.changed")}</Badge> : null}
        </span>
        <IconButton
          icon="undo"
          label={t("console.switches.reset", { name })}
          disabled={writer.busy || !row.changed}
          onClick={() => void writer.reset(path)}
        />
      </div>
      {row.enabled ? null : (
        <MessageForm
          language={language}
          row={row}
          writer={writer}
          draft={draft}
          onChange={setDraft}
        />
      )}
    </li>
  );
}

/** One tuning number: its field with its range, saved with the number's own button. */
function NumberCard({
  language,
  row,
  writer,
}: Readonly<{ language: Language; row: TuningRow; writer: Writer }>) {
  const t = translatorFor(language);
  const [text, setText] = useState(String(row.value));
  const nameKey = nameKeyOf("number", row.key);
  const name = nameKey === undefined ? row.key : t(nameKey);
  const value = numberFor(row, text);
  const path = tuningPath(row.key);
  return (
    <li className={styles.card} data-testid="number-card" data-number={row.key}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (value !== undefined) {
            void writer.put(path, { value });
          }
        }}
      >
        <Stack>
          <div className={styles.head}>
            <span className={styles.name}>
              {name}
              {row.changed ? <Badge tone="info">{t("console.catalog.changed")}</Badge> : null}
            </span>
            <span className={styles.code} dir="ltr">
              {row.min}–{row.max}
            </span>
          </div>
          <Field
            label={name}
            error={value === undefined ? t("console.catalog.invalid") : undefined}
          >
            <Input
              type="number"
              inputMode="numeric"
              dir="ltr"
              min={row.min}
              max={row.max}
              step={1}
              value={text}
              disabled={writer.busy}
              data-field={row.key}
              onChange={(event) => setText(event.target.value)}
            />
          </Field>
          <Toolbar>
            <Button
              type="submit"
              disabled={writer.busy || value === undefined || value === row.value}
            >
              {t("console.catalog.save")}
            </Button>
            <IconButton
              icon="undo"
              label={t("console.switches.reset", { name })}
              disabled={writer.busy || !row.changed}
              onClick={() => void writer.reset(path)}
            />
          </Toolbar>
        </Stack>
      </form>
    </li>
  );
}

function SwitchesBody({
  language,
  tab,
  view,
  writer,
}: Readonly<{ language: Language; tab: SwitchTab; view: SwitchesView; writer: Writer }>) {
  return tab === "features" ? (
    <ul className={styles.cards}>
      {view.features.map((row) => (
        <FeatureCard key={JSON.stringify(row)} language={language} row={row} writer={writer} />
      ))}
    </ul>
  ) : (
    <ul className={styles.cards}>
      {view.tuning.map((row) => (
        <NumberCard key={JSON.stringify(row)} language={language} row={row} writer={writer} />
      ))}
    </ul>
  );
}

/**
 * The console's platform switches and tuning numbers (T-703, FR-1405, FR-1769, FR-1770). Platform admins only. A switch
 * saves at once; the players' message and a number save with their own button; the arrow puts one back to what the app
 * ships with. The list is read again after every save, so the page shows what the database holds now.
 */
export function ConsoleSwitches({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const [tab, setTab] = useState<SwitchTab>("features");
  const { state, reload } = useConsoleRead(SWITCHES_API, readSwitches);
  const [notice, setNotice] = useState<string | null>(null);
  const write = useWrite(language, (done) => {
    setNotice(done);
    void reload();
  });
  const writer: Writer = {
    busy: write.busy,
    put: (path, body) =>
      write.run(() => requestJson("PUT", path, body, keyed()), t("console.catalog.saved")),
    reset: (path) =>
      write.run(
        () => requestJson("DELETE", path, undefined, keyed()),
        t("console.catalog.reverted"),
      ),
  };
  return (
    <Stack as="section" aria-labelledby="console-switches-title">
      <PageHeader
        titleId="console-switches-title"
        title={t("console.switches.title")}
        info={infoTip(t, "console.switches.intro")}
      />
      <Tabs
        label={t("console.switches.tabs")}
        items={SWITCH_TABS.map((key) => ({
          key,
          label: t(`console.switches.tab.${key}` satisfies MessageKey),
          current: key === tab,
          select: () => setTab(key),
        }))}
      />
      <CatalogState language={language} catalog={{ state, reload, notice, problem: write.problem }}>
        {(view) => <SwitchesBody language={language} tab={tab} view={view} writer={writer} />}
      </CatalogState>
    </Stack>
  );
}
