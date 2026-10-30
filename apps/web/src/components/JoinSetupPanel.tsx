"use client";

import {
  formatNumber,
  joinFieldKindKey,
  type JoinFieldKind,
  type Language,
} from "@questify/shared";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  JOIN_FIELD_LIMIT,
  removesSavedField,
  domainsOf,
  draftsOf,
  fieldsBody,
  kindsFor,
  moveDraft,
  needsLabel,
  needsOptions,
  newDraft,
  welcomeOf,
  type FieldDraft,
  type JoinFieldView,
  type JoinRules,
  type JoinSetup,
} from "#src/lib/joining.ts";
import { JoinOptionsEditor } from "#src/components/JoinOptionsEditor.tsx";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import { Button } from "#src/ui/Button.tsx";
import { EmptyState, Muted, Notice } from "#src/ui/Feedback.tsx";
import { Checkbox, Field, Form, Input, Select, Textarea } from "#src/ui/Field.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Card, CardList, Section, Stack, Toolbar } from "#src/ui/Section.tsx";
import { InfoTip } from "#src/ui/InfoTip.tsx";

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);

type Props = Readonly<{ language: Language; organizerId: string; eventId: string }>;

/** Turns an API refusal into the text to show; a lost session goes back to sign-in. */
function useProblem(language: Language) {
  const t = translatorFor(language);
  const [problem, setProblem] = useState<string | null>(null);
  const fail = (body: unknown) => {
    const code = errorCodeOf(body);
    if (code !== undefined && SESSION_LOST.has(code)) {
      window.location.assign(`/${language}/sign-in?ended=1`);
      return;
    }
    setProblem(
      code === undefined ? t("players.saveFailed") : describeProblem(body, language, t).text,
    );
  };
  return { problem, setProblem, fail };
}

/** Move a field up or down, or remove it. */
function RowActions({
  language,
  drafts,
  index,
  busy,
  change,
}: Readonly<{
  language: Language;
  drafts: readonly FieldDraft[];
  index: number;
  busy: boolean;
  change: (next: FieldDraft[]) => void;
}>) {
  const t = translatorFor(language);
  return (
    <Toolbar>
      <Button
        variant="quiet"
        disabled={busy || index === 0}
        onClick={() => change(moveDraft(drafts, index, -1))}
      >
        {t("joinFields.up")}
      </Button>
      <Button
        variant="quiet"
        disabled={busy || index === drafts.length - 1}
        onClick={() => change(moveDraft(drafts, index, 1))}
      >
        {t("joinFields.down")}
      </Button>
      <Button
        variant="quiet"
        disabled={busy}
        onClick={() => change(drafts.filter((_, at) => at !== index))}
      >
        {t("joinFields.remove")}
      </Button>
    </Toolbar>
  );
}

function FieldRow({
  language,
  drafts,
  index,
  busy,
  change,
}: Readonly<{
  language: Language;
  drafts: readonly FieldDraft[];
  index: number;
  busy: boolean;
  change: (next: FieldDraft[]) => void;
}>) {
  const t = translatorFor(language);
  const draft = drafts[index] as FieldDraft;
  const set = (patch: Partial<FieldDraft>) =>
    change(drafts.map((row, at) => (at === index ? { ...row, ...patch } : row)));
  return (
    <Card as="li">
      <Toolbar>
        <Field label={t("joinFields.kind")}>
          <Select
            value={draft.kind}
            // A saved field keeps its kind: its answers were given to that question.
            disabled={busy || draft.id !== undefined}
            onChange={(picked) =>
              set({ kind: picked.target.value as JoinFieldKind, options: null })
            }
          >
            {kindsFor(drafts, index).map((kind) => (
              <option key={kind} value={kind}>
                {t(joinFieldKindKey(kind))}
              </option>
            ))}
          </Select>
        </Field>
        <Checkbox
          checked={draft.required}
          disabled={busy}
          onChange={(ticked) => set({ required: ticked.target.checked })}
          label={t("joinFields.required")}
        />
      </Toolbar>
      {draft.kind === "custom" ? (
        <Toolbar>
          {(["labelAr", "labelEn"] as const).map((key) => (
            <Field label={t(key === "labelAr" ? "joinFields.labelAr" : "joinFields.labelEn")}>
              <Input
                dir={key === "labelAr" ? "rtl" : "ltr"}
                maxLength={60}
                value={draft[key]}
                disabled={busy}
                onChange={(typed) => set({ [key]: typed.target.value })}
              />
            </Field>
          ))}
        </Toolbar>
      ) : null}
      {draft.kind === "custom" ? (
        <JoinOptionsEditor
          language={language}
          fieldName={draft[language === "ar" ? "labelAr" : "labelEn"]}
          options={draft.options}
          busy={busy}
          change={(options) => set({ options })}
        />
      ) : null}
      <RowActions language={language} drafts={drafts} index={index} busy={busy} change={change} />
    </Card>
  );
}

/** The save refusal or the saved notice, announced to screen readers. */
function Feedback({
  problem,
  notice,
}: Readonly<{ problem: string | null; notice: string | null }>) {
  return (
    <>
      {problem === null ? null : (
        <Notice tone="danger" role="alert">
          {problem}
        </Notice>
      )}
      {notice === null ? null : (
        <Notice tone="info" role="status">
          {notice}
        </Notice>
      )}
    </>
  );
}

/** The fields save button, or the confirmation shown before a save that removes saved fields. */
function FieldsFooter({
  language,
  busy,
  confirming,
  incomplete,
  cancel,
}: Readonly<{
  language: Language;
  busy: boolean;
  confirming: boolean;
  incomplete: boolean;
  cancel: () => void;
}>) {
  const t = translatorFor(language);
  if (!confirming) {
    return (
      <Button variant="primary" type="submit" disabled={busy || incomplete} aria-busy={busy}>
        {t("joinFields.save")}
      </Button>
    );
  }
  return (
    <Notice tone="warning" as="div" role="alert" labelledBy="remove-fields">
      <p id="remove-fields">{t("joinFields.confirmRemove")}</p>
      <Toolbar>
        <Button variant="primary" type="submit" disabled={busy}>
          {t("joinFields.confirmRemoveYes")}
        </Button>
        <Button variant="quiet" onClick={cancel}>
          {t("joinFields.confirmRemoveNo")}
        </Button>
      </Toolbar>
    </Notice>
  );
}

/** The welcome reward amount, read-only with the fixed amount once it is locked. */
function WelcomeField({
  language,
  setup,
  value,
  busy,
  invalid,
  change,
}: Readonly<{
  language: Language;
  setup: JoinSetup;
  value: string;
  busy: boolean;
  invalid: boolean;
  change: (next: string) => void;
}>) {
  const t = translatorFor(language);
  return (
    <Field
      label={t("joinRules.welcome")}
      help={
        setup.welcomeLocked ? (
          <>
            {t("joinRules.welcomeLocked")}
            {setup.rules.welcomePoints === null
              ? null
              : ` (${formatNumber(setup.rules.welcomePoints, language)})`}
          </>
        ) : undefined
      }
      info={
        setup.welcomeLocked ? undefined : (
          <InfoTip label={t("common.info")}>{t("joinRules.welcomeHint")}</InfoTip>
        )
      }
    >
      <Input
        dir="ltr"
        inputMode="numeric"
        value={value}
        disabled={busy || setup.welcomeLocked}
        aria-invalid={invalid}
        onChange={(typed) => change(typed.target.value)}
      />
    </Field>
  );
}

/** The join fields editor (FR-129): up to five, in order, saved as one list against the version read. */
function FieldsEditor({
  language,
  base,
  setup,
  saved,
}: Readonly<{
  language: Language;
  base: string;
  setup: JoinSetup;
  saved: (version: number, fields: readonly JoinFieldView[]) => void;
}>) {
  const t = translatorFor(language);
  const [drafts, setDrafts] = useState<FieldDraft[]>(() => draftsOf(setup.fields));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const { problem, setProblem, fail } = useProblem(language);
  const counter = useRef(0);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!confirming && removesSavedField(setup.fields, drafts)) {
      setConfirming(true);
      return;
    }
    setConfirming(false);
    setBusy(true);
    setProblem(null);
    setNotice(null);
    const result = await requestJson("PUT", `${base}/fields`, fieldsBody(setup.version, drafts));
    setBusy(false);
    if (!result.ok) {
      fail(result.body);
      return;
    }
    const body = result.body as { version: number; fields: JoinFieldView[] };
    setDrafts(draftsOf(body.fields));
    saved(body.version, body.fields);
    setNotice(t("joinFields.saved"));
  };

  return (
    <Section
      title={t("joinFields.title")}
      info={<InfoTip label={t("common.info")}>{t("joinFields.intro")}</InfoTip>}
    >
      <Form onSubmit={(event) => void save(event)}>
        {drafts.length === 0 ? <EmptyState>{t("joinFields.empty")}</EmptyState> : null}
        <CardList>
          {drafts.map((draft, index) => (
            <FieldRow
              key={draft.key}
              language={language}
              drafts={drafts}
              index={index}
              busy={busy}
              change={setDrafts}
            />
          ))}
        </CardList>
        {drafts.length < JOIN_FIELD_LIMIT ? (
          <Button
            variant="quiet"
            disabled={busy}
            onClick={() => {
              counter.current += 1;
              setDrafts([...drafts, newDraft(drafts, `new-${counter.current}`)]);
            }}
          >
            {t("joinFields.add")}
          </Button>
        ) : null}
        {setup.fields.length > 0 ? <Muted>{t("joinFields.removeWarning")}</Muted> : null}
        <Feedback problem={problem} notice={notice} />
        <FieldsFooter
          language={language}
          busy={busy}
          confirming={confirming}
          incomplete={drafts.some((draft) => needsLabel(draft) || needsOptions(draft))}
          cancel={() => setConfirming(false)}
        />
      </Form>
    </Section>
  );
}

/** Who can join (FR-134, FR-135) and the welcome reward (FR-136), fixed once anyone joined or the event is live. */
function RulesEditor({
  language,
  base,
  setup,
}: Readonly<{ language: Language; base: string; setup: JoinSetup }>) {
  const t = translatorFor(language);
  const [guestListOnly, setGuestListOnly] = useState(setup.rules.guestListOnly);
  const [domains, setDomains] = useState(setup.rules.emailDomains.join("\n"));
  const [welcome, setWelcome] = useState(
    setup.rules.welcomePoints === null ? "" : String(setup.rules.welcomePoints),
  );
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const { problem, setProblem, fail } = useProblem(language);
  const amount = welcomeOf(welcome);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (amount === "invalid") {
      return;
    }
    setBusy(true);
    setProblem(null);
    setNotice(null);
    const result = await requestJson("PUT", `${base}/rules`, {
      guestListOnly,
      emailDomains: domainsOf(domains),
      ...(setup.welcomeLocked ? {} : { welcomePoints: amount }),
    });
    setBusy(false);
    if (!result.ok) {
      fail(result.body);
      return;
    }
    const { rules } = result.body as { rules: JoinRules };
    setDomains(rules.emailDomains.join("\n"));
    setNotice(t("joinRules.saved"));
  };

  return (
    <Section title={t("joinRules.title")}>
      <Form onSubmit={(event) => void save(event)}>
        <Checkbox
          checked={guestListOnly}
          disabled={busy}
          onChange={(ticked) => setGuestListOnly(ticked.target.checked)}
          label={t("joinRules.guestListOnly")}
        />
        <Field
          label={t("joinRules.domains")}
          info={<InfoTip label={t("common.info")}>{t("joinRules.domainsHint")}</InfoTip>}
        >
          <Textarea
            dir="ltr"
            rows={3}
            value={domains}
            disabled={busy}
            onChange={(typed) => setDomains(typed.target.value)}
          />
        </Field>
        <WelcomeField
          language={language}
          setup={setup}
          value={welcome}
          busy={busy}
          invalid={amount === "invalid"}
          change={setWelcome}
        />
        <Feedback problem={problem} notice={notice} />
        <Button
          variant="primary"
          type="submit"
          disabled={busy || amount === "invalid"}
          aria-busy={busy}
        >
          {t("joinRules.save")}
        </Button>
      </Form>
    </Section>
  );
}

/**
 * An event's join setup (T-212): the join fields, who can join and the welcome reward. Owners and editors both edit;
 * the API checks the event's reach and the database guards the welcome amount.
 */
export function JoinSetupPanel({ language, organizerId, eventId }: Props) {
  const t = translatorFor(language);
  const base = `/v1/organizers/${organizerId}/events/${eventId}/join`;
  const loaded = useRef(false);
  const [setup, setSetup] = useState<JoinSetup | null>(null);
  const { problem, fail } = useProblem(language);

  useEffect(() => {
    // Stryker disable next-line ConditionalExpression,BlockStatement: React runs effects twice in development only
    if (loaded.current) {
      return;
    }
    loaded.current = true;
    void requestJson("GET", base).then((result) =>
      result.ok ? setSetup(result.body as JoinSetup) : fail(result.body),
    );
  });

  return (
    <Stack as="section" aria-labelledby="joining-title">
      <PageHeader titleId="joining-title" title={t("joining.title")} />
      {problem === null ? null : (
        <Notice tone="danger" role="alert">
          {problem}
        </Notice>
      )}
      {setup === null ? (
        <Muted>{t("common.loading")}</Muted>
      ) : (
        <>
          <FieldsEditor
            language={language}
            base={base}
            setup={setup}
            saved={(version, fields) => setSetup({ ...setup, version, fields })}
          />
          <RulesEditor language={language} base={base} setup={setup} />
        </>
      )}
    </Stack>
  );
}
