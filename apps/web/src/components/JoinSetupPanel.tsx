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
import styles from "#src/components/layout.module.css";

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
    <div className={styles.row}>
      <button
        type="button"
        className={styles.quiet}
        disabled={busy || index === 0}
        onClick={() => change(moveDraft(drafts, index, -1))}
      >
        {t("joinFields.up")}
      </button>
      <button
        type="button"
        className={styles.quiet}
        disabled={busy || index === drafts.length - 1}
        onClick={() => change(moveDraft(drafts, index, 1))}
      >
        {t("joinFields.down")}
      </button>
      <button
        type="button"
        className={styles.quiet}
        disabled={busy}
        onClick={() => change(drafts.filter((_, at) => at !== index))}
      >
        {t("joinFields.remove")}
      </button>
    </div>
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
    <li className={styles.card}>
      <div className={styles.row}>
        <label className={styles.field}>
          <span>{t("joinFields.kind")}</span>
          <select
            className={styles.input}
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
          </select>
        </label>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={draft.required}
            disabled={busy}
            onChange={(ticked) => set({ required: ticked.target.checked })}
          />
          <span>{t("joinFields.required")}</span>
        </label>
      </div>
      {draft.kind === "custom" ? (
        <div className={styles.row}>
          {(["labelAr", "labelEn"] as const).map((key) => (
            <label key={key} className={styles.field}>
              <span>{t(key === "labelAr" ? "joinFields.labelAr" : "joinFields.labelEn")}</span>
              <input
                className={styles.input}
                dir={key === "labelAr" ? "rtl" : "ltr"}
                maxLength={60}
                value={draft[key]}
                disabled={busy}
                onChange={(typed) => set({ [key]: typed.target.value })}
              />
            </label>
          ))}
        </div>
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
    </li>
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
    <form className={styles.form} onSubmit={(event) => void save(event)}>
      <h2 className={styles.subtitle}>{t("joinFields.title")}</h2>
      <p className={styles.muted}>{t("joinFields.intro")}</p>
      {drafts.length === 0 ? <p className={styles.muted}>{t("joinFields.empty")}</p> : null}
      <ol className={styles.list}>
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
      </ol>
      {drafts.length < JOIN_FIELD_LIMIT ? (
        <button
          type="button"
          className={styles.quiet}
          disabled={busy}
          onClick={() => {
            counter.current += 1;
            setDrafts([...drafts, newDraft(drafts, `new-${counter.current}`)]);
          }}
        >
          {t("joinFields.add")}
        </button>
      ) : null}
      {setup.fields.length > 0 ? (
        <p className={styles.muted}>{t("joinFields.removeWarning")}</p>
      ) : null}
      {problem === null ? null : (
        <p role="alert" className={styles.alert}>
          {problem}
        </p>
      )}
      {notice === null ? null : (
        <p role="status" className={styles.notice}>
          {notice}
        </p>
      )}
      {confirming ? (
        <div role="alertdialog" aria-labelledby="remove-fields" className={styles.card}>
          <p id="remove-fields">{t("joinFields.confirmRemove")}</p>
          <div className={styles.row}>
            <button type="submit" className={styles.button} disabled={busy}>
              {t("joinFields.confirmRemoveYes")}
            </button>
            <button type="button" className={styles.quiet} onClick={() => setConfirming(false)}>
              {t("joinFields.confirmRemoveNo")}
            </button>
          </div>
        </div>
      ) : (
        <button
          type="submit"
          className={styles.button}
          disabled={busy || drafts.some((draft) => needsLabel(draft) || needsOptions(draft))}
          aria-busy={busy}
        >
          {t("joinFields.save")}
        </button>
      )}
    </form>
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
    <form className={styles.form} onSubmit={(event) => void save(event)}>
      <h2 className={styles.subtitle}>{t("joinRules.title")}</h2>
      <label className={styles.check}>
        <input
          type="checkbox"
          checked={guestListOnly}
          disabled={busy}
          onChange={(ticked) => setGuestListOnly(ticked.target.checked)}
        />
        <span>{t("joinRules.guestListOnly")}</span>
      </label>
      <label className={styles.field}>
        <span>{t("joinRules.domains")}</span>
        <textarea
          className={styles.input}
          dir="ltr"
          rows={3}
          value={domains}
          disabled={busy}
          aria-describedby="domains-hint"
          onChange={(typed) => setDomains(typed.target.value)}
        />
        <span id="domains-hint" className={styles.muted}>
          {t("joinRules.domainsHint")}
        </span>
      </label>
      <label className={styles.field}>
        <span>{t("joinRules.welcome")}</span>
        <input
          className={styles.input}
          dir="ltr"
          inputMode="numeric"
          value={welcome}
          disabled={busy || setup.welcomeLocked}
          aria-invalid={amount === "invalid"}
          aria-describedby="welcome-hint"
          onChange={(typed) => setWelcome(typed.target.value)}
        />
        <span id="welcome-hint" className={styles.muted}>
          {t(setup.welcomeLocked ? "joinRules.welcomeLocked" : "joinRules.welcomeHint")}
          {setup.rules.welcomePoints === null || !setup.welcomeLocked
            ? null
            : ` (${formatNumber(setup.rules.welcomePoints, language)})`}
        </span>
      </label>
      {problem === null ? null : (
        <p role="alert" className={styles.alert}>
          {problem}
        </p>
      )}
      {notice === null ? null : (
        <p role="status" className={styles.notice}>
          {notice}
        </p>
      )}
      <button
        type="submit"
        className={styles.button}
        disabled={busy || amount === "invalid"}
        aria-busy={busy}
      >
        {t("joinRules.save")}
      </button>
    </form>
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
    <section className={styles.panel} aria-labelledby="joining-title">
      <h1 id="joining-title" className={styles.title}>
        {t("joining.title")}
      </h1>
      {problem === null ? null : (
        <p role="alert" className={styles.alert}>
          {problem}
        </p>
      )}
      {setup === null ? (
        <p className={styles.muted}>{t("common.loading")}</p>
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
    </section>
  );
}
