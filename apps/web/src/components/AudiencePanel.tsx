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
import { Button } from "#src/ui/Button.tsx";
import { Badge, Muted, Notice } from "#src/ui/Feedback.tsx";
import { Checkbox, Field, FieldGroup, Radio, Select } from "#src/ui/Field.tsx";
import { Card, CardList, Row, Section, SubHeading, Toolbar } from "#src/ui/Section.tsx";
import { infoTip } from "#src/ui/info.tsx";

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
    return <Muted>{t(draft.kind === "answer" ? "audience.noFields" : "audience.noTags")}</Muted>;
  }
  return (
    <FieldGroup layout="choiceGrid">
      {values.map((entry) => (
        <Checkbox
          key={entry.value}
          checked={hasValue(draft, entry.value)}
          onChange={() => change(toggleValue(draft, entry.value))}
          label={
            <>
              <bdi>{entry.label}</bdi>
            </>
          }
        />
      ))}
    </FieldGroup>
  );
}

/** "Who sees it" for one category or reward: everyone, players with chosen answers, or guests with chosen tags. */
function RuleEditor({ language, view, kind, item, busy, save, cancel }: EditorProps) {
  const t = useTranslator(language);
  const [draft, setDraft] = useState<AudienceDraft>(() => draftOf(item.audience, view.fields));
  const body = ruleBody(draft);
  return (
    <FieldGroup>
      <FieldGroup>
        <legend>{t("audience.who")}</legend>
        {(["everyone", "answer", "tag"] as const).map((choice) => (
          <Radio
            name={`audience-${item.id}`}
            checked={draft.kind === choice}
            onChange={() => setDraft(pickKind(draft, choice))}
            label={t(`audience.kind.${choice}`)}
          />
        ))}
      </FieldGroup>
      {draft.kind === "answer" && view.fields.length > 0 ? (
        <Field label={t("audience.field")}>
          <Select
            value={draft.fieldId}
            onChange={(picked) => setDraft(pickField(draft, picked.target.value))}
          >
            {view.fields.map((field) => (
              <option key={field.id} value={field.id}>
                {nameIn(field.label, language)}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      {draft.kind === "everyone" ? null : (
        <ValueTicks language={language} view={view} draft={draft} change={setDraft} />
      )}
      {kind === "rewards" && draft.kind === "answer" ? (
        <Muted>{t("audience.rewardHint")}</Muted>
      ) : null}
      <Toolbar>
        <Button
          variant="primary"
          disabled={busy || body === undefined}
          onClick={() => body !== undefined && save(body)}
        >
          {t("audience.save")}
        </Button>
        <Button variant="quiet" disabled={busy} onClick={cancel}>
          {t("audience.cancel")}
        </Button>
      </Toolbar>
    </FieldGroup>
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
    <Card as="li">
      <Row
        as="div"
        main={
          <>
            <Toolbar>
              <strong>
                <bdi>{name}</bdi>
              </strong>
              {item.removed ? <Badge>{t("audience.removed")}</Badge> : null}
            </Toolbar>
            <Muted>
              {words === null
                ? t("audience.everyone")
                : t(words.field === null ? "audience.byTag" : "audience.byAnswer", {
                    field: words.field ?? "",
                    values: words.values,
                  })}
              {item.members === null
                ? null
                : ` · ${t("audience.members", { count: formatNumber(item.members, language) })}`}
            </Muted>
          </>
        }
      >
        {editing ? null : (
          <Button variant="quiet" aria-label={`${t("audience.change")} ${name}`} onClick={edit}>
            {t("audience.change")}
          </Button>
        )}
      </Row>
      {editing ? children : null}
    </Card>
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
      <SubHeading>{t(`audience.${kind}`)}</SubHeading>
      {view[kind].length === 0 ? <Muted>{t(`audience.no.${kind}`)}</Muted> : null}
      <CardList>
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
      </CardList>
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
    <Section
      title={t("audience.title")}
      titleId="audience-title"
      info={infoTip(t, "audience.intro")}
    >
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
    </Section>
  );
}
