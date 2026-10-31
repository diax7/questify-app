"use client";

import { formatEventTime, formatNumber, type Language, type TeamSession } from "@questify/shared";
import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ConfirmDialog,
  problemOf,
  type Caps,
  type QuestOption,
} from "#src/components/PlayerAwards.tsx";
import { pointsOf, reasonOk, whoOf, kindKey, type ReportLine } from "#src/lib/awards.ts";
import { useTranslator } from "#src/components/TermsScope.tsx";
import { handleOf } from "#src/lib/players.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { textFor, type CategoryView } from "#src/lib/quests.ts";
import { Button } from "#src/ui/Button.tsx";
import { Badge, EmptyState, Muted, Notice } from "#src/ui/Feedback.tsx";
import { Field, FieldGroup, Form, Input, Radio, Select, Textarea } from "#src/ui/Field.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Card, CardList, Section, Stack, Toolbar } from "#src/ui/Section.tsx";
import { infoTip } from "#src/ui/info.tsx";

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);

type SessionOption = Readonly<{ id: string; title: string }>;

const sessionTitle = (session: TeamSession, language: Language): string =>
  (language === "ar"
    ? (session.titleAr ?? session.titleEn)
    : (session.titleEn ?? session.titleAr)) ?? "";

/** The event's report page by page, its caps, its zone and its quests. */
function useAwards(eventApi: string, language: Language, onFailure: (body: unknown) => void) {
  const loaded = useRef(false);
  const [lines, setLines] = useState<ReportLine[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [caps, setCaps] = useState<Caps | null>(null);
  const [timeZone, setTimeZone] = useState("Asia/Riyadh");
  const [quests, setQuests] = useState<QuestOption[]>([]);
  const [sessions, setSessions] = useState<SessionOption[]>([]);
  const load = async (cursor: string | null) => {
    const query = cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`;
    const result = await requestJson("GET", `${eventApi}/awards${query}`);
    if (!result.ok) {
      onFailure(result.body);
      return;
    }
    const page = result.body as { caps: Caps; awards: ReportLine[]; nextCursor: string | null };
    setCaps(page.caps);
    setLines((current) => (cursor === null ? page.awards : [...(current ?? []), ...page.awards]));
    setNext(page.nextCursor);
  };
  useEffect(() => {
    // Stryker disable next-line ConditionalExpression,BlockStatement: React runs effects twice in development only
    if (loaded.current) {
      return;
    }
    loaded.current = true;
    void load(null);
    void requestJson("GET", `${eventApi}/sessions`).then((found) => {
      const listed = found.ok ? (found.body as { sessions: TeamSession[] }).sessions : [];
      setSessions(
        listed.map((session) => ({ id: session.id, title: sessionTitle(session, language) })),
      );
    });
    void Promise.all([requestJson("GET", eventApi), requestJson("GET", `${eventApi}/quests`)]).then(
      ([event, found]) => {
        const zone = event.ok
          ? (event.body as { event?: { timezone?: string } }).event?.timezone
          : undefined;
        setTimeZone(zone ?? "Asia/Riyadh");
        const categories = found.ok
          ? (found.body as { categories: CategoryView[] }).categories
          : [];
        setQuests(
          categories.flatMap((category) =>
            category.quests.map((quest) => ({
              id: quest.id,
              title: textFor(quest.title, language),
              points: quest.points,
            })),
          ),
        );
      },
    );
  });
  return {
    lines,
    caps,
    setCaps,
    timeZone,
    quests,
    sessions,
    reload: () => void load(null),
    more: next === null ? null : () => void load(next),
  };
}

/** FR-310: the owner sets the caps; editors read them. */
function CapsCard({
  language,
  eventApi,
  caps,
  isOwner,
  saved,
}: Readonly<{
  language: Language;
  eventApi: string;
  caps: Caps;
  isOwner: boolean;
  saved: (caps: Caps) => void;
}>) {
  const t = useTranslator(language);
  const [each, setEach] = useState(String(caps.each));
  const [day, setDay] = useState(String(caps.day));
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const wanted = { each: pointsOf(each), day: Number(day) };
    if (
      wanted.each === undefined ||
      !Number.isInteger(wanted.day) ||
      wanted.day < wanted.each ||
      wanted.day > 1000000
    ) {
      setMessage({ ok: false, text: t("awards.capsInvalid") });
      return;
    }
    const result = await requestJson("PUT", `${eventApi}/award-caps`, wanted);
    setMessage(
      result.ok
        ? { ok: true, text: t("awards.capsSaved") }
        : { ok: false, text: problemOf(result.body, language, t) },
    );
    if (result.ok) {
      saved(result.body as Caps);
    }
  };
  return (
    <Section
      title={t("awards.caps")}
      titleId="caps-title"
      description={isOwner ? undefined : t("awards.capsOwnerOnly")}
      info={isOwner ? infoTip(t, "awards.capsHelp") : undefined}
    >
      <Form onSubmit={(event) => void submit(event)}>
        {(
          [
            ["awards.capEach", each, setEach],
            ["awards.capDay", day, setDay],
          ] as const
        ).map(([label, value, set]) => (
          <Field key={label} label={t(label)}>
            <Input
              inputMode="numeric"
              dir="ltr"
              value={value}
              readOnly={!isOwner}
              onChange={(changed) => set(changed.target.value)}
            />
          </Field>
        ))}
        {message === null ? null : (
          <Notice role={message.ok ? "status" : "alert"} tone={message.ok ? "success" : "danger"}>
            {message.text}
          </Notice>
        )}
        {isOwner ? (
          <Button variant="primary" type="submit">
            {t("awards.saveCaps")}
          </Button>
        ) : null}
      </Form>
    </Section>
  );
}

type Preview = Readonly<{
  count: number;
  /** A session target: the bulk awards already made to it (T-505b). */
  earlier?: number;
  matched?: readonly Readonly<{ enrollmentId: string; username: string }>[];
  inactive?: readonly string[];
  notFound?: readonly string[];
}>;

type BulkTargetKind = "list" | "quest" | "session";

const TARGET_LABELS = {
  list: "awards.bulkList",
  quest: "awards.bulkQuest",
  session: "awards.bulkSession",
} as const;

type BulkDraft = Readonly<{
  target: BulkTargetKind;
  lines: string;
  questId: string;
  sessionId: string;
  points: string;
  reason: string;
}>;

/** The one target a quest or session draft names, for the preview and the award. */
function targetBody(draft: BulkDraft): Readonly<Record<string, string>> {
  return draft.target === "quest" ? { questId: draft.questId } : { sessionId: draft.sessionId };
}

/** What the preview checks: the typed lines of a list, else the quest or the session. */
const previewBodyOf = (draft: BulkDraft) =>
  draft.target === "list" ? { lines: draft.lines } : targetBody(draft);

/** What the award pays: the members a list's check matched, else the quest or the session. */
const awardTargetOf = (draft: BulkDraft, preview: Preview) =>
  draft.target === "list"
    ? { enrollmentIds: (preview.matched ?? []).map((row) => row.enrollmentId) }
    : targetBody(draft);

/**
 * The bulk award's draft, with the first quest and the first session picked when none is, and its check: only a new
 * target needs a new check; the amount and the reason do not.
 */
function useBulkDraft(quests: readonly QuestOption[], sessions: readonly SessionOption[]) {
  const [draft, setDraft] = useState<BulkDraft>({
    target: "list",
    lines: "",
    questId: "",
    sessionId: "",
    points: "",
    reason: "",
  });
  const [preview, setPreview] = useState<Preview | null>(null);
  const shown: BulkDraft = {
    ...draft,
    questId: draft.questId === "" ? (quests[0]?.id ?? "") : draft.questId,
    sessionId: draft.sessionId === "" ? (sessions[0]?.id ?? "") : draft.sessionId,
  };
  const change = (next: BulkDraft) => {
    const moved = (["target", "lines", "questId", "sessionId"] as const).some(
      (field) => next[field] !== shown[field],
    );
    if (moved) setPreview(null);
    setDraft(next);
  };
  return { draft, shown, setDraft, change, preview, setPreview };
}

function SessionPicker({
  language,
  sessions,
  draft,
  change,
}: Readonly<{
  language: Language;
  sessions: readonly SessionOption[];
  draft: BulkDraft;
  change: (next: BulkDraft) => void;
}>) {
  const t = useTranslator(language);
  return (
    <Field label={t("awards.bulkSessionPick")}>
      <Select
        value={draft.sessionId}
        onChange={(picked) => change({ ...draft, sessionId: picked.target.value })}
      >
        {sessions.map((session) => (
          <option key={session.id} value={session.id}>
            {session.title}
          </option>
        ))}
      </Select>
    </Field>
  );
}

function BulkFields({
  language,
  quests,
  sessions,
  draft,
  change,
}: Readonly<{
  language: Language;
  quests: readonly QuestOption[];
  sessions: readonly SessionOption[];
  draft: BulkDraft;
  change: (next: BulkDraft) => void;
}>) {
  const t = useTranslator(language);
  const upload = async (file: File | undefined) => {
    if (file !== undefined) {
      change({ ...draft, lines: await file.text() });
    }
  };
  return (
    <>
      <FieldGroup legend={t("awards.what")} layout="choices">
        {(["list", "quest", "session"] as const).map((target) => (
          <Radio
            key={target}
            name="bulk-target"
            checked={draft.target === target}
            disabled={
              (target === "quest" && quests.length === 0) ||
              (target === "session" && sessions.length === 0)
            }
            onChange={() => change({ ...draft, target })}
            label={t(TARGET_LABELS[target])}
          />
        ))}
      </FieldGroup>
      {draft.target === "session" ? (
        <SessionPicker language={language} sessions={sessions} draft={draft} change={change} />
      ) : null}
      {draft.target === "list" ? (
        <>
          <Field label={t("awards.bulkLines")}>
            <Textarea
              dir="auto"
              rows={6}
              value={draft.lines}
              onChange={(typed) => change({ ...draft, lines: typed.target.value })}
            />
          </Field>
          <Field label={t("awards.bulkFile")}>
            <input
              type="file"
              accept=".csv,.txt,text/csv,text/plain"
              onChange={(picked) => void upload(picked.target.files?.[0])}
            />
          </Field>
        </>
      ) : null}
      {draft.target === "quest" ? (
        <Field label={t("awards.quest")}>
          <Select
            value={draft.questId}
            onChange={(picked) => change({ ...draft, questId: picked.target.value })}
          >
            {quests.map((quest) => (
              <option key={quest.id} value={quest.id}>
                {quest.title}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      <Field label={t("awards.amount")}>
        <Input
          inputMode="numeric"
          dir="ltr"
          value={draft.points}
          onChange={(typed) => change({ ...draft, points: typed.target.value })}
        />
      </Field>
      <Field label={t("awards.reason")}>
        <Textarea
          dir="auto"
          maxLength={300}
          value={draft.reason}
          onChange={(typed) => change({ ...draft, reason: typed.target.value })}
        />
      </Field>
    </>
  );
}

function PreviewNote({ language, preview }: Readonly<{ language: Language; preview: Preview }>) {
  const t = useTranslator(language);
  return (
    <div role="status">
      <p>{t("awards.matched", { count: formatNumber(preview.count, language) })}</p>
      {(preview.notFound ?? []).length === 0 ? null : (
        <Muted dir="auto">
          {t("awards.notFound", { lines: (preview.notFound ?? []).join("، ") })}
        </Muted>
      )}
      {(preview.inactive ?? []).length === 0 ? null : (
        <Muted dir="auto">
          {t("awards.inactive", { lines: (preview.inactive ?? []).join("، ") })}
        </Muted>
      )}
      <EarlierNote language={language} earlier={preview.earlier ?? 0} />
    </div>
  );
}

/** A session target that was awarded before: this award pays everyone again (T-505b). */
function EarlierNote({ language, earlier }: Readonly<{ language: Language; earlier: number }>) {
  const t = useTranslator(language);
  return earlier === 0 ? null : (
    <Notice tone="warning">
      {t("awards.bulkEarlier", { count: formatNumber(earlier, language) })}
    </Notice>
  );
}

/** FR-1712: a list or a quest's completers, checked first, then the same points to each after a confirm step. */
function BulkCard({
  language,
  eventApi,
  quests,
  sessions,
  done,
}: Readonly<{
  language: Language;
  eventApi: string;
  quests: readonly QuestOption[];
  sessions: readonly SessionOption[];
  done: () => void;
}>) {
  const t = useTranslator(language);
  const { draft, shown, setDraft, change, preview, setPreview } = useBulkDraft(quests, sessions);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const key = useRef("");
  const points = pointsOf(draft.points);

  const check = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage(null);
    const result = await requestJson(
      "POST",
      `${eventApi}/bulk-awards/preview`,
      previewBodyOf(shown),
    );
    if (!result.ok) {
      setMessage({ ok: false, text: problemOf(result.body, language, t) });
      return;
    }
    setPreview(result.body as Preview);
  };
  const confirm = async () => {
    if (points === undefined || preview === null) {
      return;
    }
    setBusy(true);
    const result = await requestJson(
      "POST",
      `${eventApi}/bulk-awards`,
      { ...awardTargetOf(shown, preview), points, reason: draft.reason.trim() },
      { "idempotency-key": key.current },
    );
    setBusy(false);
    setAsking(false);
    if (!result.ok) {
      setMessage({ ok: false, text: problemOf(result.body, language, t) });
      return;
    }
    const outcome = result.body as { awarded: number; skipped: number };
    setMessage({ ok: true, text: t("awards.bulkDone", outcome) });
    setDraft({ ...draft, lines: "", points: "", reason: "" });
    setPreview(null);
    done();
  };
  const ready =
    preview !== null && preview.count > 0 && points !== undefined && reasonOk(draft.reason);

  return (
    <Section title={t("awards.bulk")} titleId="bulk-title" info={infoTip(t, "awards.bulkHelp")}>
      {asking && points !== undefined && preview !== null ? (
        <ConfirmDialog
          language={language}
          title={t("awards.confirmTitle")}
          busy={busy}
          cancel={() => setAsking(false)}
          confirm={() => void confirm()}
        >
          <p dir="auto">
            {t("awards.bulkConfirmBody", {
              count: formatNumber(preview.count, language),
              points: formatNumber(points, language),
              reason: draft.reason.trim(),
            })}
          </p>
          {draft.target === "session" ? <Muted>{t("awards.bulkSessionLate")}</Muted> : null}
        </ConfirmDialog>
      ) : null}
      <Form onSubmit={(event) => void check(event)}>
        <BulkFields
          language={language}
          quests={quests}
          sessions={sessions}
          draft={shown}
          change={change}
        />
        <Button variant="quiet" type="submit">
          {t("awards.check")}
        </Button>
        {preview === null ? null : <PreviewNote language={language} preview={preview} />}
        {preview !== null && preview.count === 0 ? <Muted>{t("awards.nobody")}</Muted> : null}
        {message === null ? null : (
          <Notice role={message.ok ? "status" : "alert"} tone={message.ok ? "success" : "danger"}>
            {message.text}
          </Notice>
        )}
        <Button
          variant="primary"
          disabled={!ready}
          onClick={() => {
            key.current = crypto.randomUUID();
            setAsking(true);
          }}
        >
          {t("awards.award")}
        </Button>
      </Form>
    </Section>
  );
}

function ReportRow({
  language,
  timeZone,
  line,
}: Readonly<{ language: Language; timeZone: string; line: ReportLine }>) {
  const t = useTranslator(language);
  const who = whoOf(line.by);
  const sign = line.kind === "removal" ? "−" : "+";
  return (
    <Card as="li">
      <Toolbar>
        <strong dir="auto">{handleOf(line.player.username, language)}</strong>
        <span>{t(kindKey(line.kind))}</span>
        {line.quest === null ? null : <span dir="auto">{textFor(line.quest.title, language)}</span>}
        <span dir="ltr">
          {sign}
          {formatNumber(line.points, language)}
        </span>
        {line.bulkId === null ? null : <Badge>{t("awards.bulkTag")}</Badge>}
        {line.removed ? <Badge>{t("awards.removedTag")}</Badge> : null}
      </Toolbar>
      <Muted>
        {formatEventTime(new Date(line.at), timeZone, language)}
        {who === null ? null : ` · ${t("awards.by", { name: who })}`}
      </Muted>
      {line.reason === null ? null : <Muted dir="auto">{line.reason}</Muted>}
    </Card>
  );
}

type Props = Readonly<{
  language: Language;
  organizerId: string;
  eventId: string;
  myRole: "owner" | "editor";
}>;

/**
 * Manual awards for the event's team (T-207): the caps (owner), a bulk award (FR-1712) and the report of every manual
 * award and removal with player, quest or points, reason, who and when (FR-311).
 */
export function AwardsPanel({ language, organizerId, eventId, myRole }: Props) {
  const t = useTranslator(language);
  const eventApi = `/v1/organizers/${organizerId}/events/${eventId}`;
  const [problem, setProblem] = useState<string | null>(null);
  const awards = useAwards(eventApi, language, (body) => {
    const code = (body as { code?: unknown } | undefined)?.code;
    if (typeof code === "string" && SESSION_LOST.has(code)) {
      window.location.assign(`/${language}/sign-in?ended=1`);
      return;
    }
    setProblem(body === undefined ? t("awards.loadFailed") : problemOf(body, language, t));
  });

  return (
    <Stack as="section" aria-labelledby="awards-title">
      <PageHeader titleId="awards-title" title={t("awards.title")} />
      {problem === null ? null : (
        <Notice tone="danger" role="alert">
          {problem}
        </Notice>
      )}
      {awards.caps === null ? null : (
        <CapsCard
          language={language}
          eventApi={eventApi}
          caps={awards.caps}
          isOwner={myRole === "owner"}
          saved={awards.setCaps}
        />
      )}
      <BulkCard
        language={language}
        eventApi={eventApi}
        quests={awards.quests}
        sessions={awards.sessions}
        done={awards.reload}
      />
      <Section title={t("awards.report")}>
        {awards.lines === null && problem === null ? <Muted>{t("common.loading")}</Muted> : null}
        {awards.lines?.length === 0 ? <EmptyState>{t("awards.reportEmpty")}</EmptyState> : null}
        <CardList>
          {(awards.lines ?? []).map((line) => (
            <ReportRow key={line.id} language={language} timeZone={awards.timeZone} line={line} />
          ))}
        </CardList>
        {awards.more === null ? null : (
          <Button variant="secondary" onClick={awards.more}>
            {t("players.more")}
          </Button>
        )}
      </Section>
    </Stack>
  );
}
