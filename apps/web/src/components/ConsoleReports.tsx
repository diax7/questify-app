"use client";

import {
  REPORT_KINDS,
  formatNumber,
  type FlagsAnswer,
  type Language,
  type ReportKind,
  type ReportQueue,
  type ReportTarget,
} from "@questify/shared";
import { useEffect, useState } from "react";
import { clockOf } from "#src/lib/console-organizers.ts";
import { ModerationAddresses } from "#src/components/ModerationAddresses.tsx";
import {
  dueDistance,
  FLAGS_API,
  FLAG_KIND_KEYS,
  inLanguage,
  queuePath,
  readFlags,
  readQueue,
  snapshotLabel,
  targetPage,
} from "#src/lib/console-reports.ts";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem } from "#src/lib/sign-in-errors.ts";
import { Badge, EmptyState, Muted, Notice } from "#src/ui/Feedback.tsx";
import { Field, Select } from "#src/ui/Field.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Row, Rows, Stack } from "#src/ui/Section.tsx";
import { TextLink } from "#src/ui/Text.tsx";
import { infoTip } from "#src/ui/info.tsx";

/** Loads one console read; `undefined` while it loads, the parsed answer, or the problem's words. */
function useConsoleRead<T>(
  language: Language,
  path: string,
  read: (body: unknown) => T | undefined,
): Readonly<{ data: T | undefined; problem: string | null }> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void requestJson("GET", path).then((result) => {
      if (!alive) {
        return;
      }
      const parsed = result.ok ? read(result.body) : undefined;
      setData(parsed);
      setProblem(
        parsed === undefined
          ? describeProblem(result.body, language, translatorFor(language)).text
          : null,
      );
    });
    return () => {
      alive = false;
    };
  }, [language, path, read]);
  return { data, problem };
}

/** "Due in 35 min" or "Overdue by 2 h" (Western digits), from the earliest open report's due time. */
export function DueLine({ language, dueAt }: Readonly<{ language: Language; dueAt: string }>) {
  const t = translatorFor(language);
  const distance = dueDistance(dueAt, Date.now());
  const time = t(distance.unit === "hours" ? "console.reports.hours" : "console.reports.minutes", {
    count: formatNumber(distance.count, language),
  });
  return distance.late ? (
    <Badge tone="warning">{t("console.reports.overdueBy", { time })}</Badge>
  ) : (
    <Muted as="span">{t("console.reports.dueIn", { time })}</Muted>
  );
}

function TargetLine({ language, row }: Readonly<{ language: Language; row: ReportTarget }>) {
  const t = translatorFor(language);
  return (
    <Row
      main={
        <Stack>
          <span>
            <TextLink href={targetPage(language, row.kind, row.targetId)} strong>
              <bdi dir="auto">{snapshotLabel(row.snapshot, language) || t("reports.untitled")}</bdi>
            </TextLink>{" "}
            <Badge>{t(`reports.kind.${row.kind}`)}</Badge>{" "}
            {row.urgent ? <Badge tone="danger">{t("console.reports.urgent")}</Badge> : null}
          </span>
          <DueLine language={language} dueAt={row.dueAt} />
          <Muted as="span">
            {t("console.reports.count", { count: formatNumber(row.reports, language) })}
            {" · "}
            {t("console.reports.since", { time: clockOf(row.firstAt, language) })}
            {row.event === null ? null : (
              <>
                {" · "}
                <bdi dir="auto">{inLanguage(row.event.name, language)}</bdi>
                {" · "}
                <bdi dir="auto">{row.event.organizer}</bdi>
              </>
            )}
          </Muted>
        </Stack>
      }
    />
  );
}

/**
 * Questify's moderation queue (T-705b, FR-1404; T-701b, FR-1732): one row per reported item with how many open reports
 * it has, urgent first (a report from a live event), then the earliest due, with "Due in" or "Overdue by". Every read
 * is audited with counts only. The moderation addresses card sits below.
 */
export function ConsoleReports({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const [kind, setKind] = useState<ReportKind | "">("");
  const { data, problem } = useConsoleRead<ReportQueue>(language, queuePath(kind), readQueue);
  return (
    <Stack as="section" aria-labelledby="console-reports-title">
      <PageHeader
        title={t("console.reports.title")}
        titleId="console-reports-title"
        info={infoTip(t, "console.reports.intro")}
      />
      <Field label={t("console.reports.kind")}>
        <Select
          value={kind}
          onChange={(changed) => setKind(changed.target.value as ReportKind | "")}
        >
          <option value="">{t("console.reports.allKinds")}</option>
          {REPORT_KINDS.map((one) => (
            <option key={one} value={one}>
              {t(`reports.kind.${one}`)}
            </option>
          ))}
        </Select>
      </Field>
      {problem === null ? null : (
        <Notice tone="danger" role="alert">
          {problem}
        </Notice>
      )}
      {data === undefined ? null : (
        <>
          <Muted>
            {t("console.reports.total", { count: formatNumber(data.total, language) })}
            {" · "}
            {t("console.reports.urgentTotal", {
              count: formatNumber(data.urgentTotal, language),
            })}
          </Muted>
          {data.targets.length === 0 ? (
            <EmptyState>{t("console.reports.empty")}</EmptyState>
          ) : (
            <Rows>
              {data.targets.map((row) => (
                <TargetLine key={`${row.kind}:${row.targetId}`} language={language} row={row} />
              ))}
            </Rows>
          )}
        </>
      )}
      <ModerationAddresses language={language} />
    </Stack>
  );
}

/**
 * Open anti-cheat flags across events (T-705b, FR-1404), one row per event, oldest first, linked to the console's event
 * page. Read-only: the event's team resolves them, or support with its access.
 */
export function ConsoleFlags({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const { data, problem } = useConsoleRead<FlagsAnswer>(language, FLAGS_API, readFlags);
  return (
    <Stack as="section" aria-labelledby="console-flags-title">
      <PageHeader
        title={t("console.flags.title")}
        titleId="console-flags-title"
        info={infoTip(t, "console.flags.intro")}
      />
      {problem === null ? null : (
        <Notice tone="danger" role="alert">
          {problem}
        </Notice>
      )}
      {data === undefined ? null : (
        <>
          <Muted>{t("console.flags.total", { count: formatNumber(data.total, language) })}</Muted>
          {data.events.length === 0 ? (
            <EmptyState>{t("console.flags.empty")}</EmptyState>
          ) : (
            <Rows>
              {data.events.map((row) => (
                <Row
                  key={row.eventId}
                  main={
                    <Stack>
                      <span>
                        <TextLink href={`/${language}/console/events/${row.eventId}`} strong>
                          <bdi dir="auto">{inLanguage(row.name, language)}</bdi>
                        </TextLink>{" "}
                        <Badge tone="warning">
                          {t("console.flags.open", { count: formatNumber(row.open, language) })}
                        </Badge>{" "}
                        {row.suspended ? (
                          <Badge tone="danger">{t("console.flags.suspended")}</Badge>
                        ) : null}
                      </span>
                      <Muted as="span">
                        <bdi dir="auto">{row.organizer}</bdi>
                        {" · "}
                        {t("console.reports.since", { time: clockOf(row.oldestAt, language) })}
                        {" · "}
                        {row.kinds
                          .map((one) => t(FLAG_KIND_KEYS[one]))
                          .join(language === "ar" ? "، " : ", ")}
                      </Muted>
                    </Stack>
                  }
                />
              ))}
            </Rows>
          )}
        </>
      )}
    </Stack>
  );
}
