"use client";

import { formatNumber, joinOptionLabel, type Language } from "@questify/shared";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  draftOf,
  hasValue,
  nameIn,
  pickField,
  pickKind,
  ruleBody,
  ruleWords,
  toggleValue,
  type AudienceDraft,
  type AudienceItem,
  type AudienceView,
} from "#src/lib/audience.ts";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem, errorCodeOf } from "#src/lib/sign-in-errors.ts";
import styles from "#src/components/layout.module.css";

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);

type Props = Readonly<{ language: Language; organizerId: string; eventId: string }>;
type ItemKind = "categories" | "rewards";

type EditorProps = Readonly<{
  language: Language;
  view: AudienceView;
  kind: ItemKind;
  item: AudienceItem;
  busy: boolean;
  save: (body: object) => void;
  cancel: () => void;
}>;

/** The ticks for one rule: the options of the picked choice field, or the event's guest tags. */
function ValueTicks({
  language,
  view,
  draft,
  change,
}: Readonly<{
  language: Language;
  view: AudienceView;
  draft: AudienceDraft;
  change: (draft: AudienceDraft) => void;
}>) {
  const t = useTranslator(language);
  const field = view.fields.find((entry) => entry.id === draft.fieldId);
  const values =
    draft.kind === "answer"
      ? (field?.options ?? []).map((option) => ({
          value: option.id,
          label: joinOptionLabel(option, language),
        }))
      : view.tags.map((entry) => ({
          value: entry.tag,
          label: `${entry.tag} (${formatNumber(entry.guests, language)})`,
        }));
  if (values.length === 0) {
    return (
      <p className={styles.muted}>
        {t(draft.kind === "answer" ? "audience.noFields" : "audience.noTags")}
      </p>
    );
  }
  return (
    <fieldset className={styles.row}>
      {values.map((entry) => (
        <label key={entry.value} className={styles.check}>
          <input
            type="checkbox"
            checked={hasValue(draft, entry.value)}
            onChange={() => change(toggleValue(draft, entry.value))}
          />
          <bdi>{entry.label}</bdi>
        </label>
      ))}
    </fieldset>
  );
}

/** "Who sees it" for one category or reward: everyone, players with chosen answers, or guests with chosen tags. */
function RuleEditor({ language, view, kind, item, busy, save, cancel }: EditorProps) {
  const t = useTranslator(language);
  const [draft, setDraft] = useState<AudienceDraft>(() => draftOf(item.audience, view.fields));
  const body = ruleBody(draft);
  return (
    <div className={styles.form}>
      <fieldset className={styles.form}>
        <legend>{t("audience.who")}</legend>
        {(["everyone", "answer", "tag"] as const).map((choice) => (
          <label key={choice} className={styles.check}>
            <input
              type="radio"
              name={`audience-${item.id}`}
              checked={draft.kind === choice}
              onChange={() => setDraft(pickKind(draft, choice))}
            />
            <span>{t(`audience.kind.${choice}`)}</span>
          </label>
        ))}
      </fieldset>
      {draft.kind === "answer" && view.fields.length > 0 ? (
        <label className={styles.field}>
          <span>{t("audience.field")}</span>
          <select
            className={styles.input}
            value={draft.fieldId}
            onChange={(picked) => setDraft(pickField(draft, picked.target.value))}
          >
            {view.fields.map((field) => (
              <option key={field.id} value={field.id}>
                {nameIn(field.label, language)}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {draft.kind === "everyone" ? null : (
        <ValueTicks language={language} view={view} draft={draft} change={setDraft} />
      )}
      {kind === "rewards" && draft.kind === "answer" ? (
        <p className={styles.muted}>{t("audience.rewardHint")}</p>
      ) : null}
      <div className={styles.row}>
        <button
          type="button"
          className={styles.button}
          disabled={busy || body === undefined}
          onClick={() => body !== undefined && save(body)}
        >
          {t("audience.save")}
        </button>
        <button type="button" className={styles.quiet} disabled={busy} onClick={cancel}>
          {t("audience.cancel")}
        </button>
      </div>
    </div>
  );
}

/** One category or reward: its name, who sees it and how many players match now. */
function ItemRow({
  language,
  view,
  item,
  editing,
  children,
  edit,
}: Readonly<{
  language: Language;
  view: AudienceView;
  item: AudienceItem;
  editing: boolean;
  children: ReactNode;
  edit: () => void;
}>) {
  const t = useTranslator(language);
  const words = ruleWords(item.audience, view.fields, language);
  const name = nameIn(item.name, language);
  return (
    <li className={styles.card}>
      <p className={styles.row}>
        <strong>
          <bdi>{name}</bdi>
        </strong>
        {item.removed ? <span className={styles.badge}>{t("audience.removed")}</span> : null}
      </p>
      <p className={styles.muted}>
        {words === null
          ? t("audience.everyone")
          : t(words.field === null ? "audience.byTag" : "audience.byAnswer", {
              field: words.field ?? "",
              values: words.values,
            })}
        {item.members === null
          ? null
          : ` · ${t("audience.members", { count: formatNumber(item.members, language) })}`}
      </p>
      {editing ? (
        children
      ) : (
        <button
          type="button"
          className={styles.quiet}
          aria-label={`${t("audience.change")} ${name}`}
          onClick={edit}
        >
          {t("audience.change")}
        </button>
      )}
    </li>
  );
}

/** The categories or the rewards, each with its rule and, while being changed, its editor. */
function ItemList({
  language,
  view,
  kind,
  editing,
  busy,
  setEditing,
  save,
}: Readonly<{
  language: Language;
  view: AudienceView;
  kind: ItemKind;
  editing: string | null;
  busy: boolean;
  setEditing: (id: string | null) => void;
  save: (id: string, body: object) => void;
}>) {
  const t = useTranslator(language);
  return (
    <>
      <h3 className={styles.subtitle}>{t(`audience.${kind}`)}</h3>
      {view[kind].length === 0 ? <p className={styles.muted}>{t(`audience.no.${kind}`)}</p> : null}
      <ul className={styles.list}>
        {view[kind].map((item) => (
          <ItemRow
            key={item.id}
            language={language}
            view={view}
            item={item}
            editing={editing === item.id}
            edit={() => setEditing(item.id)}
          >
            <RuleEditor
              language={language}
              view={view}
              kind={kind}
              item={item}
              busy={busy}
              save={(body) => save(item.id, body)}
              cancel={() => setEditing(null)}
            />
          </ItemRow>
        ))}
      </ul>
    </>
  );
}

/**
 * "Who sees what" (T-220, FR-1708): each category and reward is for everyone, for players whose answer to a choice
 * field is one of chosen options, or for guests with chosen tags. Others do not see it and cannot complete or
 * reserve it. Owners and editors.
 */
export function AudiencePanel({ language, organizerId, eventId }: Props) {
  const t = useTranslator(language);
  const base = `/v1/organizers/${organizerId}/events/${eventId}/audience`;
  const loaded = useRef(false);
  const [view, setView] = useState<AudienceView | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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

  useEffect(() => {
    // Stryker disable next-line ConditionalExpression,BlockStatement: React runs effects twice in development only
    if (loaded.current) {
      return;
    }
    loaded.current = true;
    void requestJson("GET", base).then((answer) =>
      answer.ok ? setView(answer.body as AudienceView) : fail(answer.body),
    );
  });

  const save = async (kind: ItemKind, id: string, body: object) => {
    setBusy(true);
    setProblem(null);
    setNotice(null);
    const answer = await requestJson("PUT", `${base}/${kind}/${id}`, body);
    setBusy(false);
    if (!answer.ok) {
      fail(answer.body);
      return;
    }
    const { item } = answer.body as { item: AudienceItem };
    setView((current) =>
      current === null
        ? current
        : { ...current, [kind]: current[kind].map((row) => (row.id === id ? item : row)) },
    );
    setEditing(null);
    setNotice(t("audience.saved"));
  };

  return (
    <section className={styles.panel} aria-labelledby="audience-title">
      <h2 id="audience-title" className={styles.title}>
        {t("audience.title")}
      </h2>
      <p className={styles.muted}>{t("audience.intro")}</p>
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
      {view === null ? null : (
        <>
          {(["categories", "rewards"] as const).map((kind) => (
            <ItemList
              key={kind}
              language={language}
              view={view}
              kind={kind}
              editing={editing}
              busy={busy}
              setEditing={setEditing}
              save={(id, body) => void save(kind, id, body)}
            />
          ))}
        </>
      )}
    </section>
  );
}
