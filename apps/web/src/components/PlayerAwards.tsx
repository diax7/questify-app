"use client";

import { formatEventTime, formatNumber, type Language } from "@questify/shared";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  capProblem,
  firstBonusLabel,
  kindKey,
  removeBonusHint,
  pointsOf,
  reasonOk,
  whoOf,
  type LedgerLine,
} from "#src/lib/awards.ts";
import { useTranslator } from "#src/components/TermsScope.tsx";
import type { Translate } from "#src/lib/language.ts";
import { handleOf } from "#src/lib/players.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { textFor } from "#src/lib/quests.ts";
import { describeProblem } from "#src/lib/sign-in-errors.ts";
import { Card, CardList, SubHeading, Toolbar } from "#src/ui/Section.tsx";
import { Button } from "#src/ui/Button.tsx";
import { Dialog } from "#src/ui/Dialog.tsx";
import { Badge, Muted, Notice } from "#src/ui/Feedback.tsx";
import { Field, FieldGroup, Form, Input, Radio, Select, Textarea } from "#src/ui/Field.tsx";

export type QuestOption = Readonly<{ id: string; title: string; points: number }>;
export type Caps = Readonly<{ each: number; day: number }>;

/** Asks before an award or a removal goes out (F-196); Escape cancels, focus starts on the title. */
export function ConfirmDialog({
  language,
  title,
  busy,
  cancel,
  confirm,
  children,
}: Readonly<{
  language: Language;
  title: string;
  busy: boolean;
  cancel: () => void;
  confirm: () => void;
  children: ReactNode;
}>) {
  const t = useTranslator(language);
  return (
    <Dialog
      title={title}
      busy={busy}
      cancel={cancel}
      actions={
        <>
          <Button variant="secondary" disabled={busy} onClick={cancel}>
            {t("awards.back")}
          </Button>
          <Button variant="primary" disabled={busy} onClick={confirm}>
            {t("awards.confirm")}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}

/** The API's refusal in words: the cap that applies (FR-310), else the API's own message. */
export function problemOf(body: unknown, language: Language, t: Translate): string {
  return capProblem(body, t) ?? describeProblem(body, language, t).text;
}

/** One player's record, newest first, page by page. */
function useRecord(url: string) {
  const loaded = useRef(false);
  const [lines, setLines] = useState<LedgerLine[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [failed, setFailed] = useState<unknown>(null);
  const load = async (cursor: string | null) => {
    const result = await requestJson(
      "GET",
      cursor === null ? url : `${url}?cursor=${encodeURIComponent(cursor)}`,
    );
    if (!result.ok) {
      setFailed(result.body ?? {});
      return;
    }
    const page = result.body as { entries: LedgerLine[]; nextCursor: string | null };
    setLines((current) => (cursor === null ? page.entries : [...(current ?? []), ...page.entries]));
    setNext(page.nextCursor);
  };
  useEffect(() => {
    // Stryker disable next-line ConditionalExpression,BlockStatement: React runs effects twice in development only
    if (loaded.current) {
      return;
    }
    loaded.current = true;
    void load(null);
  });
  return {
    lines,
    failed,
    reload: () => void load(null),
    more: next === null ? null : () => void load(next),
  };
}

function RecordLine({
  language,
  timeZone,
  line,
  remove,
}: Readonly<{
  language: Language;
  timeZone: string;
  line: LedgerLine;
  remove: (line: LedgerLine) => void;
}>) {
  const t = useTranslator(language);
  const who = whoOf(line.by);
  const title = textFor(line.title, language);
  return (
    <Card as="li">
      <Toolbar>
        <strong>
          {firstBonusLabel(t, line, (value) => formatNumber(value, language)) ??
            t(kindKey(line.kind))}
        </strong>
        {title === "" ? null : <span dir="auto">{title}</span>}
        <span dir="ltr">
          {line.scoreDelta > 0 ? "+" : ""}
          {formatNumber(line.scoreDelta, language)}
        </span>
        {line.removed ? <Badge>{t("awards.removedTag")}</Badge> : null}
      </Toolbar>
      <Muted>
        {formatEventTime(new Date(line.at), timeZone, language)}
        {who === null ? null : ` · ${t("awards.by", { name: who })}`}
      </Muted>
      {line.reason === null ? null : <Muted dir="auto">{line.reason}</Muted>}
      {line.removable ? (
        <Button variant="quiet" onClick={() => remove(line)}>
          {t("awards.remove")}
        </Button>
      ) : null}
    </Card>
  );
}

type Draft = Readonly<{
  mode: "points" | "quest";
  points: string;
  questId: string;
  reason: string;
}>;

function AwardFields({
  language,
  quests,
  draft,
  change,
}: Readonly<{
  language: Language;
  quests: readonly QuestOption[];
  draft: Draft;
  change: (next: Draft) => void;
}>) {
  const t = useTranslator(language);
  return (
    <>
      <FieldGroup legend={t("awards.what")} layout="choices">
        {(["points", "quest"] as const).map((mode) => (
          <Radio
            key={mode}
            name="award-mode"
            checked={draft.mode === mode}
            disabled={mode === "quest" && quests.length === 0}
            onChange={() => change({ ...draft, mode })}
            label={t(mode === "points" ? "awards.somePoints" : "awards.aQuest")}
          />
        ))}
      </FieldGroup>
      {draft.mode === "points" ? (
        <Field label={t("awards.amount")}>
          <Input
            inputMode="numeric"
            dir="ltr"
            value={draft.points}
            onChange={(changed) => change({ ...draft, points: changed.target.value })}
          />
        </Field>
      ) : (
        <Field label={t("awards.quest")}>
          <Select
            value={draft.questId}
            onChange={(changed) => change({ ...draft, questId: changed.target.value })}
          >
            {quests.map((quest) => (
              <option key={quest.id} value={quest.id}>
                {quest.title} ({formatNumber(quest.points, language)})
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field label={t("awards.reason")} help={t("awards.reasonHelp")}>
        <Textarea
          dir="auto"
          maxLength={300}
          value={draft.reason}
          onChange={(changed) => change({ ...draft, reason: changed.target.value })}
        />
      </Field>
    </>
  );
}

type Asking =
  | Readonly<{
      kind: "award";
      points: number;
      questId: string | null;
      label: string;
      reason: string;
    }>
  | Readonly<{ kind: "remove"; line: LedgerLine; reason: string }>;

/** The confirm step of an award or a removal; a removal asks for its reason here. */
function AskDialog({
  language,
  username,
  asking,
  busy,
  change,
  cancel,
  confirm,
}: Readonly<{
  language: Language;
  username: string | null;
  asking: Asking;
  busy: boolean;
  change: (next: Asking) => void;
  cancel: () => void;
  confirm: () => void;
}>) {
  const t = useTranslator(language);
  const name = handleOf(username, language);
  if (asking.kind === "award") {
    const points = formatNumber(asking.points, language);
    return (
      <ConfirmDialog
        language={language}
        title={t("awards.confirmTitle")}
        busy={busy}
        cancel={cancel}
        confirm={confirm}
      >
        <p dir="auto">
          {t("awards.confirmBody", {
            name,
            points: asking.label === "" ? points : `${asking.label}: ${points}`,
            reason: asking.reason,
          })}
        </p>
      </ConfirmDialog>
    );
  }
  const hint = removeBonusHint(t, asking.line, (value) => formatNumber(value, language));
  return (
    <ConfirmDialog
      language={language}
      title={t("awards.removeTitle", {
        points: formatNumber(asking.line.scoreDelta, language),
        name,
      })}
      busy={busy || !reasonOk(asking.reason)}
      cancel={cancel}
      confirm={confirm}
    >
      <p>{t("awards.removeBody")}</p>
      {hint === undefined ? null : <Muted>{hint}</Muted>}
      <Field label={t("awards.reason")}>
        <Textarea
          dir="auto"
          maxLength={300}
          value={asking.reason}
          onChange={(typed) => change({ ...asking, reason: typed.target.value })}
        />
      </Field>
    </ConfirmDialog>
  );
}

/** Sends a confirmed award or removal once; a retry of the same confirm reuses its key. */
function sendAsked(eventApi: string, enrollmentId: string, sending: Asking, key: string) {
  const headers = { "idempotency-key": key };
  if (sending.kind === "remove") {
    return requestJson(
      "POST",
      `${eventApi}/entries/${sending.line.id}/remove`,
      { reason: sending.reason },
      headers,
    );
  }
  const body =
    sending.questId === null
      ? { points: sending.points, reason: sending.reason }
      : { questId: sending.questId, reason: sending.reason };
  return requestJson("POST", `${eventApi}/players/${enrollmentId}/awards`, body, headers);
}

function RecordSection({
  language,
  timeZone,
  record,
  remove,
}: Readonly<{
  language: Language;
  timeZone: string;
  record: ReturnType<typeof useRecord>;
  remove: (line: LedgerLine) => void;
}>) {
  const t = useTranslator(language);
  return (
    <>
      <SubHeading>{t("awards.record")}</SubHeading>
      {record.failed === null ? null : (
        <Notice tone="danger" role="alert">
          {problemOf(record.failed, language, t)}
        </Notice>
      )}
      {record.lines === null && record.failed === null ? (
        <Muted>{t("common.loading")}</Muted>
      ) : null}
      {record.lines?.length === 0 ? <Muted>{t("awards.recordEmpty")}</Muted> : null}
      <CardList>
        {(record.lines ?? []).map((line) => (
          <RecordLine
            key={line.id}
            language={language}
            timeZone={timeZone}
            line={line}
            remove={remove}
          />
        ))}
      </CardList>
      {record.more === null ? null : (
        <Button variant="quiet" onClick={record.more}>
          {t("players.more")}
        </Button>
      )}
    </>
  );
}

type Props = Readonly<{
  language: Language;
  /** `/v1/organizers/{id}/events/{id}`. */
  eventApi: string;
  player: Readonly<{ enrollmentId: string; username: string | null }>;
  quests: readonly QuestOption[];
  timeZone: string;
  /** The event's caps for an editor; null for the owner, who has none. */
  caps: Caps | null;
  changed: () => void;
}>;

/**
 * One player's points record on the dashboard (FR-320, FR-1027, FR-1601): every entry with who and why, Remove on a
 * credit entry, and an award by hand with a required reason, each through a confirm step. Owners and editors.
 */
export function PlayerAwards({
  language,
  eventApi,
  player,
  quests,
  timeZone,
  caps,
  changed,
}: Props) {
  const t = useTranslator(language);
  const record = useRecord(`${eventApi}/players/${player.enrollmentId}/entries`);
  const [draft, setDraft] = useState<Draft>({
    mode: "points",
    points: "",
    questId: quests[0]?.id ?? "",
    reason: "",
  });
  const [asking, setAsking] = useState<Asking | null>(null);
  const key = useRef("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const name = handleOf(player.username, language);

  const quest = quests.find((option) => option.id === draft.questId);
  const amount = draft.mode === "points" ? pointsOf(draft.points) : quest?.points;

  const ask = (next: Asking) => {
    key.current = crypto.randomUUID();
    setProblem(null);
    setNotice(null);
    setAsking(next);
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (amount !== undefined && reasonOk(draft.reason)) {
      const byQuest = draft.mode === "quest";
      ask({
        kind: "award",
        points: amount,
        questId: byQuest ? draft.questId : null,
        label: byQuest ? (quest?.title ?? "") : "",
        reason: draft.reason.trim(),
      });
    }
  };
  const send = async (sending: Asking) => {
    setBusy(true);
    const result = await sendAsked(eventApi, player.enrollmentId, sending, key.current);
    setBusy(false);
    setAsking(null);
    if (!result.ok) {
      setProblem(problemOf(result.body, language, t));
      return;
    }
    if (sending.kind === "award") {
      setNotice(t("awards.awarded", { name, points: formatNumber(sending.points, language) }));
      setDraft({ ...draft, points: "", reason: "" });
    } else {
      setNotice(t("awards.removedNotice"));
    }
    record.reload();
    changed();
  };

  return (
    <>
      {asking === null ? null : (
        <AskDialog
          language={language}
          username={player.username}
          asking={asking}
          busy={busy}
          change={setAsking}
          cancel={() => setAsking(null)}
          confirm={() => void send(asking)}
        />
      )}
      <FieldGroup>
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
        <Form card onSubmit={submit} aria-label={t("awards.awardTitle", { name })}>
          <SubHeading>{t("awards.awardTitle", { name })}</SubHeading>
          <AwardFields language={language} quests={quests} draft={draft} change={setDraft} />
          <Muted>
            {caps === null
              ? t("awards.noLimit")
              : t("awards.capNote", {
                  each: formatNumber(caps.each, language),
                  day: formatNumber(caps.day, language),
                })}
          </Muted>
          <Button
            variant="primary"
            type="submit"
            disabled={amount === undefined || !reasonOk(draft.reason)}
          >
            {t("awards.award")}
          </Button>
        </Form>
        <RecordSection
          language={language}
          timeZone={timeZone}
          record={record}
          remove={(chosen) => ask({ kind: "remove", line: chosen, reason: "" })}
        />
      </FieldGroup>
    </>
  );
}
