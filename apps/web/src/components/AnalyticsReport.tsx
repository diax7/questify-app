"use client";

import {
  MIN_GROUP_SIZE,
  formatEventTime,
  formatNumber,
  reportSchema,
  termFor,
  type Language,
  type Report,
  type ReportSurvey,
} from "@questify/shared";
import { useEffect, useId, useState } from "react";
import { useCountText } from "#src/components/AnalyticsSponsor.tsx";
import styles from "#src/components/analytics-report.module.css";
import { useEventTerms, useTranslator } from "#src/components/TermsScope.tsx";
import { textFor } from "#src/lib/quests.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { errorCodeOf } from "#src/lib/sign-in-errors.ts";
import { Button } from "#src/ui/Button.tsx";
import { BarRows, Figure, PanelGrid, Tile, type BarRow } from "#src/ui/Charts.tsx";
import { EmptyState, Muted, Notice } from "#src/ui/Feedback.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Section, Stack, SubHeading } from "#src/ui/Section.tsx";

const SESSION_LOST = new Set(["unauthenticated", "session_expired"]);

type State =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "failed" }>
  | Readonly<{ status: "ready"; report: Report }>;

/** The report's data, asked for when the page opens and again on Try again; showing it is not audited. */
function useReport(language: Language, eventApi: string) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    setState({ status: "loading" });
    void requestJson("GET", `${eventApi}/report`).then((result) => {
      if (!current) {
        return;
      }
      const code = errorCodeOf(result.body);
      if (code !== undefined && SESSION_LOST.has(code)) {
        window.location.assign(`/${language}/sign-in?ended=1`);
        return;
      }
      const parsed = result.ok ? reportSchema.safeParse(result.body) : undefined;
      setState(
        parsed?.success === true ? { status: "ready", report: parsed.data } : { status: "failed" },
      );
    });
    return () => {
      current = false;
    };
  }, [language, eventApi, attempt]);
  return { state, retry: () => setAttempt((count) => count + 1) };
}

function Survey({ language, survey }: Readonly<{ language: Language; survey: ReportSurvey }>) {
  const t = useTranslator(language);
  const text = useCountText(language);
  const summary = (question: ReportSurvey["questions"][number]): string => {
    if (question.choices !== null) {
      return question.choices
        .map((choice) => `${textFor(choice.text, language)}: ${text(choice.count)}`)
        .join(" · ");
    }
    if (question.kind === "rating") {
      return question.average === null
        ? text(null)
        : t("report.survey.average", { average: formatNumber(question.average, language) });
    }
    return question.written === null
      ? text(null)
      : t("report.survey.written", { count: formatNumber(question.written, language) });
  };
  return (
    <li className={styles.survey}>
      <strong dir="auto">{textFor(survey.title, language)}</strong>
      {survey.responses === 0 ? <Muted>{t("surveyResults.csv.noAnswers")}</Muted> : null}
      {survey.responses === null ? (
        <Muted>{t("report.survey.fewer", { count: formatNumber(MIN_GROUP_SIZE, language) })}</Muted>
      ) : null}
      {survey.responses !== null && survey.responses > 0 ? (
        <>
          <Muted>
            {t("report.survey.responses", { count: formatNumber(survey.responses, language) })}
          </Muted>
          <ul className={styles.questions}>
            {survey.questions.map((question, index) => (
              <li key={index}>
                <span dir="auto">{textFor(question.text, language)}</span>
                {" — "}
                <span dir="auto">{summary(question)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </li>
  );
}

function barRows(
  items: readonly Readonly<{ label: string; count: number | null }>[],
  text: (count: number | null) => string,
): BarRow[] {
  const most = Math.max(1, ...items.map((item) => item.count ?? 0));
  return items.map((item, index) => ({
    key: `${index}`,
    label: <span dir="auto">{item.label}</span>,
    value: text(item.count),
    share: (item.count ?? 0) / most,
  }));
}

function Headline({ language, report }: Readonly<{ language: Language; report: Report }>) {
  const t = useTranslator(language);
  const currency = termFor(useEventTerms().currency, language);
  const number = (value: number) => formatNumber(value, language);
  const { headline } = report;
  const tiles: readonly (readonly [string, string])[] = [
    [t("analytics.joined"), number(headline.joined)],
    [t("analytics.active"), number(headline.active)],
    [
      t("analytics.activation"),
      headline.activation === null ? "—" : `${number(headline.activation)}%`,
    ],
    [t("analytics.returning"), number(headline.returning)],
    [t("analytics.earned", { currency }), number(headline.earned)],
    [t("analytics.spent", { currency }), number(headline.spent)],
    [t("analytics.sponsor.redemptions"), number(headline.redeemed)],
  ];
  const id = useId();
  return (
    <Stack as="section" aria-labelledby={id}>
      <SubHeading as="h3" id={id}>
        {t("report.numbers")}
      </SubHeading>
      <PanelGrid kind="tiles">
        {tiles.map(([title, value]) => (
          <Tile key={title} title={title}>
            <Figure>{value}</Figure>
          </Tile>
        ))}
      </PanelGrid>
    </Stack>
  );
}

function TopLists({ language, report }: Readonly<{ language: Language; report: Report }>) {
  const t = useTranslator(language);
  const text = useCountText(language);
  const number = (value: number) => formatNumber(value, language);
  return (
    <div className={styles.twoUp}>
      <Section level={3} title={t("analytics.mostPopular")}>
        {report.quests.length === 0 ? (
          <EmptyState>{t("analytics.empty")}</EmptyState>
        ) : (
          <BarRows
            rows={barRows(
              report.quests.map((quest) => ({
                label: textFor(quest.title, language),
                count: quest.done,
              })),
              (count) => (count === null ? text(null) : number(count)),
            )}
          />
        )}
      </Section>
      <Section level={3} title={t("analytics.rewards")}>
        {report.rewards.length === 0 ? (
          <EmptyState>{t("analytics.rewards.empty")}</EmptyState>
        ) : (
          <BarRows
            rows={barRows(
              report.rewards.map((reward) => ({
                label: textFor(reward.name, language),
                count: reward.redeemed,
              })),
              (count) =>
                count === null
                  ? text(null)
                  : t("analytics.rewards.redeemed", { count: number(count) }),
            )}
          />
        )}
      </Section>
    </div>
  );
}

function Surveys({ language, report }: Readonly<{ language: Language; report: Report }>) {
  const t = useTranslator(language);
  if (report.surveys.length === 0) {
    return null;
  }
  return (
    <Section level={3} title={t("report.surveys")}>
      <ul className={styles.surveys}>
        {report.surveys.map((survey, index) => (
          <Survey key={index} language={language} survey={survey} />
        ))}
      </ul>
      {report.moreSurveys === 0 ? null : (
        <Muted>
          {t("report.survey.more", { count: formatNumber(report.moreSurveys, language) })}
        </Muted>
      )}
    </Section>
  );
}

function Sheet({ language, report }: Readonly<{ language: Language; report: Report }>) {
  const t = useTranslator(language);
  const { event } = report;
  const moment = (iso: string) => formatEventTime(new Date(iso), event.zone, language);
  const dates =
    event.startsAt === null
      ? ""
      : `${moment(event.startsAt)} – ${event.endsAt === null ? t("report.noEnd") : moment(event.endsAt)}`;
  return (
    <article className={styles.sheet} aria-labelledby="report-event">
      <div className={styles.masthead}>
        <p className={styles.kicker}>{t("report.title")}</p>
        <h2 id="report-event" className={styles.event} dir="auto">
          {textFor(event.name, language)}
        </h2>
        <p className={styles.dates}>{dates}</p>
      </div>
      {report.rehearsal ? (
        <Notice tone="info" role="note">
          {t("analytics.rehearsal")}
        </Notice>
      ) : null}
      <Headline language={language} report={report} />
      <TopLists language={language} report={report} />
      <Surveys language={language} report={report} />
    </article>
  );
}

/**
 * Writes the audit entry of printing the report, then opens the print dialog. A refused or failed entry prints nothing:
 * a report that leaves the system leaves a record (FR-1206).
 */
function usePrint(language: Language, eventApi: string) {
  const [failed, setFailed] = useState(false);
  const print = async () => {
    const result = await requestJson("POST", `${eventApi}/report`);
    const code = errorCodeOf(result.body);
    if (code !== undefined && SESSION_LOST.has(code)) {
      window.location.assign(`/${language}/sign-in?ended=1`);
      return;
    }
    setFailed(!result.ok);
    if (result.ok) {
      window.print();
    }
  };
  return { failed, print: () => void print() };
}

/**
 * The event's one-page report (T-608, FR-1208): the headline numbers, the most popular quests and rewards and each
 * survey's results, with no player in it. The button records the print in the audit log, then prints the page; the print
 * style keeps the sheet alone on A4 pages, so "Save as PDF" in the browser's print dialog is the PDF (ADR-393).
 */
export function AnalyticsReport({
  language,
  organizerId,
  eventId,
}: Readonly<{ language: Language; organizerId: string; eventId: string }>) {
  const t = useTranslator(language);
  const eventApi = `/v1/organizers/${organizerId}/events/${eventId}`;
  const { state, retry } = useReport(language, eventApi);
  const { failed: printFailed, print } = usePrint(language, eventApi);
  return (
    <Stack as="section" aria-labelledby="report-title">
      <div className={styles.screenOnly}>
        <PageHeader
          titleId="report-title"
          title={t("report.title")}
          back={{
            href: `/${language}/organizers/${organizerId}/events/${eventId}/analytics`,
            label: t("analytics.title"),
          }}
          actions={
            <Button variant="primary" disabled={state.status !== "ready"} onClick={print}>
              {t("report.print")}
            </Button>
          }
        />
        {printFailed ? (
          <Notice tone="danger" role="alert">
            {t("report.printFailed")}
          </Notice>
        ) : null}
        {state.status === "loading" ? <Muted>{t("common.loading")}</Muted> : null}
        {state.status === "failed" ? (
          <Notice tone="danger" role="alert">
            {t("analytics.loadFailed")}{" "}
            <Button size="sm" onClick={retry}>
              {t("common.retry")}
            </Button>
          </Notice>
        ) : null}
      </div>
      {state.status === "ready" ? <Sheet language={language} report={state.report} /> : null}
    </Stack>
  );
}
