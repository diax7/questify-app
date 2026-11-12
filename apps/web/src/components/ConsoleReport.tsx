"use client";

import {
  HOLD_REASONS,
  isHoldKind,
  type HoldKind,
  type Language,
  type LiveHold,
  type ReportDetail,
  type ReportEntry,
  type ReportKind,
  type ReportSnapshot,
} from "@questify/shared";
import { useCallback, useEffect, useState } from "react";
import { ConfirmedButton, Problem, keyed, useWrite } from "#src/components/ConsoleOversight.tsx";
import { clockOf } from "#src/lib/console-organizers.ts";
import {
  HOLDS_API,
  OUTCOME_KEYS,
  RELEASE_HOLD_API,
  inLanguage,
  outcomesFor,
  readDetail,
  resolvePath,
  snapshotLabel,
  targetPath,
} from "#src/lib/console-reports.ts";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem } from "#src/lib/sign-in-errors.ts";
import { Badge, Muted, Notice } from "#src/ui/Feedback.tsx";
import { Field, Select, Textarea } from "#src/ui/Field.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Row, Rows, Section, Stack, Toolbar } from "#src/ui/Section.tsx";
import { TextLink } from "#src/ui/Text.tsx";
import { RemotePhoto } from "#src/ui/RemotePhoto.tsx";

const NOTE_MIN = 10;
const NOTE_MAX = 300;
const usableNote = (note: string): boolean => {
  const length = note.trim().length;
  return length >= NOTE_MIN && length <= NOTE_MAX;
};

type Target = Readonly<{ kind: ReportKind; targetId: string }>;

/** A snapshot's title and text in the reader's language; "Removed" when the item is gone. */
function SnapshotText({
  language,
  snapshot,
}: Readonly<{ language: Language; snapshot: ReportSnapshot | null }>) {
  const t = translatorFor(language);
  if (snapshot === null) {
    return <Muted>{t("console.report.gone")}</Muted>;
  }
  const text = inLanguage(snapshot.text, language);
  return (
    <Stack>
      <strong dir="auto">{snapshotLabel(snapshot, language)}</strong>
      {text === "" ? null : <p dir="auto">{text}</p>}
    </Stack>
  );
}

function ReportLine({ language, report }: Readonly<{ language: Language; report: ReportEntry }>) {
  const t = translatorFor(language);
  return (
    <Row
      main={
        <Stack>
          <span>
            <Badge tone="warning">{t(`reports.reason.${report.reason}`)}</Badge>{" "}
            {report.status === "open" ? null : (
              <Badge>{t(OUTCOME_KEYS[report.outcome ?? "dismissed"])}</Badge>
            )}{" "}
            {report.marked ? <Badge tone="danger">{t("console.report.marked")}</Badge> : null}
          </span>
          {report.note === null ? null : <p dir="auto">{report.note}</p>}
          <Muted as="span">
            {report.reporter === null ? (
              t("console.report.reporterGone")
            ) : (
              <bdi dir="auto">@{report.reporter}</bdi>
            )}
            {" · "}
            {clockOf(report.createdAt, language)}
          </Muted>
        </Stack>
      }
    />
  );
}

/** The two steps of a hold: their words, how the button looks, and where they go. */
const STEPS = {
  unpublish: {
    title: "console.report.unpublish",
    note: "console.report.noteOrganizer",
    ask: "console.report.unpublishAsk",
    variant: "danger",
    path: HOLDS_API,
  },
  republish: {
    title: "console.report.republish",
    note: "console.report.noteRelease",
    ask: "console.report.republishAsk",
    variant: "secondary",
    path: RELEASE_HOLD_API,
  },
} as const;

function HoldReason({
  language,
  value,
  change,
}: Readonly<{ language: Language; value: string; change: (next: string) => void }>) {
  const t = translatorFor(language);
  return (
    <Field label={t("console.report.reason")}>
      <Select value={value} onChange={(changed) => change(changed.target.value)}>
        <option value="">{t("console.player.reason.choose")}</option>
        {HOLD_REASONS.map((code) => (
          <option key={code} value={code}>
            {t(`reports.reason.${code}`)}
          </option>
        ))}
      </Select>
    </Field>
  );
}

function HeldFacts({ language, held }: Readonly<{ language: Language; held: LiveHold }>) {
  const t = translatorFor(language);
  return (
    <Notice tone="warning" as="div">
      <p>
        {t("console.report.heldSince", {
          time: clockOf(held.heldAt, language),
          reason: t(`reports.reason.${held.reasonCode}`),
        })}
      </p>
      <p dir="auto">{held.note}</p>
    </Notice>
  );
}

/** Unpublish with a reason and a note the organizer reads, or publish again with a note; each asked once. */
function HoldPanel({
  language,
  kind,
  detail,
  onDone,
}: Readonly<{ language: Language; kind: HoldKind; detail: ReportDetail; onDone: () => void }>) {
  const t = translatorFor(language);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const { busy, problem, run } = useWrite(language, onDone);
  const step = STEPS[detail.hold === null ? "unpublish" : "republish"];
  const target = { kind, targetId: detail.targetId, note: note.trim() };
  const body = detail.hold === null ? { ...target, reasonCode: reason } : target;
  const ready = usableNote(note) && (detail.hold !== null || reason !== "");
  return (
    <Section title={t(step.title)} level={3}>
      <Stack>
        <Problem problem={problem} />
        {detail.hold === null ? (
          <HoldReason language={language} value={reason} change={setReason} />
        ) : (
          <HeldFacts language={language} held={detail.hold} />
        )}
        <Field label={t(step.note)}>
          <Textarea
            dir="auto"
            maxLength={NOTE_MAX}
            value={note}
            onChange={(changed) => setNote(changed.target.value)}
          />
        </Field>
        <ConfirmedButton
          language={language}
          label={t(step.title)}
          question={t(step.ask)}
          variant={step.variant}
          disabled={busy || !ready}
          act={() => void run(() => requestJson("POST", step.path, body, keyed()), "")}
        />
      </Stack>
    </Section>
  );
}

/** Where the other actions live: the player's record (rename, ban) or the event (suspend). */
function ElsewhereLink({
  language,
  detail,
}: Readonly<{ language: Language; detail: ReportDetail }>) {
  const t = translatorFor(language);
  if (detail.kind === "username") {
    return detail.player === null || detail.player.status === "deleted" ? null : (
      <TextLink href={`/${language}/console/players/${detail.player.id}`}>
        {t("console.report.openPlayer")}
      </TextLink>
    );
  }
  return isHoldKind(detail.kind) || detail.event === null ? null : (
    <TextLink href={`/${language}/console/events/${detail.event.id}`}>
      {t("console.report.openEvent")}
    </TextLink>
  );
}

/** Closes every open report of the target with the action taken, asked once. */
function ClosePanel({
  language,
  detail,
  onDone,
}: Readonly<{ language: Language; detail: ReportDetail; onDone: () => void }>) {
  const t = translatorFor(language);
  const { busy, problem, run } = useWrite(language, onDone);
  const open = detail.reports.some((one) => one.status === "open");
  const close = (outcome: keyof typeof OUTCOME_KEYS) =>
    void run(
      () => requestJson("POST", resolvePath(detail.kind, detail.targetId), { outcome }, keyed()),
      "",
    );
  return (
    <Section title={t("console.report.close")} level={3}>
      <Stack>
        <ElsewhereLink language={language} detail={detail} />
        <Problem problem={problem} />
        {open ? (
          <Toolbar>
            {outcomesFor(detail.kind).map((outcome) => (
              <ConfirmedButton
                key={outcome}
                language={language}
                label={t(OUTCOME_KEYS[outcome])}
                question={t("console.report.closeAsk")}
                variant={outcome === "dismissed" ? "secondary" : "primary"}
                disabled={busy}
                act={() => close(outcome)}
              />
            ))}
          </Toolbar>
        ) : (
          <Muted>{t("console.report.noneOpen")}</Muted>
        )}
      </Stack>
    </Section>
  );
}

/** The item's kind, event, organizer and whether the event is suspended. */
function TargetFacts({ language, detail }: Readonly<{ language: Language; detail: ReportDetail }>) {
  const t = translatorFor(language);
  const event = detail.event;
  return (
    <Toolbar>
      <Badge>{t(`reports.kind.${detail.kind}`)}</Badge>
      {event === null ? null : (
        <>
          <TextLink href={`/${language}/console/events/${event.id}`}>
            <bdi dir="auto">{inLanguage(event.name, language)}</bdi>
          </TextLink>
          <Muted as="span">{event.organizer}</Muted>
          {event.suspended ? <Badge tone="danger">{t("console.flags.suspended")}</Badge> : null}
        </>
      )}
    </Toolbar>
  );
}

function TargetBody({
  language,
  detail,
  reload,
}: Readonly<{ language: Language; detail: ReportDetail; reload: () => void }>) {
  const t = translatorFor(language);
  return (
    <>
      <TargetFacts language={language} detail={detail} />
      <Section title={t("console.report.reported")} level={3}>
        <SnapshotText language={language} snapshot={detail.reports[0]?.snapshot ?? null} />
      </Section>
      <Section title={t("console.report.now")} level={3}>
        <SnapshotText language={language} snapshot={detail.current} />
        {detail.photo === undefined || detail.photo === null ? null : (
          <RemotePhoto src={detail.photo.url} alt={t("photo.alt")} expired={t("photo.expired")} />
        )}
      </Section>
      {isHoldKind(detail.kind) && detail.current !== null ? (
        <HoldPanel language={language} kind={detail.kind} detail={detail} onDone={reload} />
      ) : null}
      <ClosePanel language={language} detail={detail} onDone={reload} />
      <Section title={t("console.report.list")} level={3}>
        <Rows>
          {detail.reports.map((report) => (
            <ReportLine key={report.id} language={language} report={report} />
          ))}
        </Rows>
      </Section>
    </>
  );
}

/**
 * One reported item in the console (T-705b, FR-1404, FR-1414): what each reporter saw beside what it says now, its
 * event and organizer, and the actions: unpublish or publish again for a quest, a reward or an announcement; the
 * player's record for a username (rename, ban); the event's page for the rest (suspend); then close the reports with
 * the action taken. Every read and action is audited with ids only.
 */
export function ConsoleReport({
  language,
  kind,
  targetId,
}: Readonly<{ language: Language } & Target>) {
  const t = translatorFor(language);
  const [detail, setDetail] = useState<ReportDetail | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const load = useCallback(async () => {
    const result = await requestJson("GET", targetPath(kind, targetId));
    const parsed = result.ok ? readDetail(result.body) : undefined;
    setDetail(parsed ?? null);
    setProblem(parsed === undefined ? describeProblem(result.body, language, t).text : null);
  }, [kind, targetId, language, t]);
  useEffect(() => {
    void load();
  }, [load]);
  const shown = detail?.current ?? detail?.reports[0]?.snapshot ?? null;
  return (
    <Stack as="section" aria-labelledby="console-report-title">
      <PageHeader
        title={snapshotLabel(shown, language) || t("reports.untitled")}
        titleId="console-report-title"
        back={{ href: `/${language}/console/reports`, label: t("console.reports.title") }}
      />
      <Problem problem={problem} />
      {detail === null ? null : (
        <TargetBody language={language} detail={detail} reload={() => void load()} />
      )}
    </Stack>
  );
}
