"use client";

import { formatEventTime, formatNumber, type Language } from "@questify/shared";
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

/** The event's report page by page, its caps, its zone and its quests. */
function useAwards(eventApi: string, language: Language, onFailure: (body: unknown) => void) {
  const loaded = useRef(false);
  const [lines, setLines] = useState<ReportLine[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [caps, setCaps] = useState<Caps | null>(null);
  const [timeZone, setTimeZone] = useState("Asia/Riyadh");
  const [quests, setQuests] = useState<QuestOption[]>([]);
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
  matched?: readonly Readonly<{ enrollmentId: string; username: string }>[];
  inactive?: readonly string[];
  notFound?: readonly string[];
}>;

type BulkDraft = Readonly<{
  target: "list" | "quest";
  lines: string;
  questId: string;
  points: string;
  reason: string;
}>;

function BulkFields({
  language,
  quests,
  draft,
  change,
}: Readonly<{
  language: Language;
  quests: readonly QuestOption[];
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
        {(["list", "quest"] as const).map((target) => (
          <Radio
            key={target}
            name="bulk-target"
            checked={draft.target === target}
            disabled={target === "quest" && quests.length === 0}
            onChange={() => change({ ...draft, target })}
            label={t(target === "list" ? "awards.bulkList" : "awards.bulkQuest")}
          />
        ))}
      </FieldGroup>
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
      ) : (
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
      )}
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
    </div>
  );
}

/** FR-1712: a list or a quest's completers, checked first, then the same points to each after a confirm step. */
function BulkCard({
  language,
  eventApi,
  quests,
  done,
}: Readonly<{
  language: Language;
  eventApi: string;
  quests: readonly QuestOption[];
  done: () => void;
}>) {
  const t = useTranslator(language);
  const [draft, setDraft] = useState<BulkDraft>({
    target: "list",
    lines: "",
    questId: "",
    points: "",
    reason: "",
  });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const key = useRef("");
  const questId = draft.questId === "" ? (quests[0]?.id ?? "") : draft.questId;
  const points = pointsOf(draft.points);
  // Only a new target needs a new check; the amount and the reason do not.
  const change = (next: BulkDraft) => {
    if (next.target !== draft.target || next.lines !== draft.lines || next.questId !== questId) {
      setPreview(null);
    }
    setDraft(next);
  };

  const check = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage(null);
    const body = draft.target === "list" ? { lines: draft.lines } : { questId };
    const result = await requestJson("POST", `${eventApi}/bulk-awards/preview`, body);
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
    const target =
      draft.target === "list"
        ? { enrollmentIds: (preview.matched ?? []).map((row) => row.enrollmentId) }
        : { questId };
    const result = await requestJson(
      "POST",
      `${eventApi}/bulk-awards`,
      { ...target, points, reason: draft.reason.trim() },
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
        </ConfirmDialog>
      ) : null}
      <Form onSubmit={(event) => void check(event)}>
        <BulkFields
          language={language}
          quests={quests}
          draft={{ ...draft, questId }}
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
