"use client";

import {
  formatNumber,
  termFor,
  type Economy,
  type Language,
  type Participation,
  type QuestsAnalytics,
} from "@questify/shared";
import { useState } from "react";
import { QuestScoreBadge } from "#src/components/QuestScoreBadge.tsx";
import { useEventTerms, useTranslator } from "#src/components/TermsScope.tsx";
import {
  PANEL_ROWS,
  axisTicks,
  funnelOf,
  largestDrop,
  percentOf,
  seriesPoints,
  sourceRows,
  stopsOf,
  type FunnelStep,
  type QuestRow,
} from "#src/lib/analytics.ts";
import { textFor } from "#src/lib/quests.ts";
import { BarRows, LineChart, type BarRow } from "#src/ui/Charts.tsx";
import { Badge, EmptyState, Muted } from "#src/ui/Feedback.tsx";
import { Field, Select } from "#src/ui/Field.tsx";
import { Row, Rows } from "#src/ui/Section.tsx";

type Props<T> = Readonly<{ language: Language; data: T }>;

/** "120 (34%)", or only the number when there is nothing to take a share of. */
function useShareText(language: Language) {
  const t = useTranslator(language);
  return (count: number, percent: number | null): string =>
    percent === null
      ? formatNumber(count, language)
      : t("analytics.share", {
          count: formatNumber(count, language),
          percent: formatNumber(percent, language),
        });
}

/** Players over time (FR-1201): the running count of joined players as a line, with its summary in words. */
export function JoinedOverTime({ language, data }: Props<Participation>) {
  const t = useTranslator(language);
  const points = seriesPoints(data, language);
  const first = points[0];
  const last = points.at(-1);
  if (first === undefined || last === undefined) {
    return <EmptyState>{t("analytics.empty")}</EmptyState>;
  }
  return (
    <LineChart
      points={points}
      ticks={axisTicks(Math.max(...points.map((point) => point.value)))}
      name={t("analytics.overTime")}
      summary={t("analytics.chartSummary", {
        count: formatNumber(points.length, language),
        firstTime: first.label,
        firstValue: formatNumber(first.value, language),
        lastTime: last.label,
        lastValue: formatNumber(last.value, language),
      })}
      format={(value) => formatNumber(value, language)}
    />
  );
}

/** Every point of the line as rows, the newest first: the same values the hover shows. */
export function JoinedOverTimeList({ language, data }: Props<Participation>) {
  const points = seriesPoints(data, language);
  return (
    <Rows>
      {points.toReversed().map((point) => (
        <Row key={point.x} main={<span dir="auto">{point.label}</span>}>
          <Badge>{formatNumber(point.value, language)}</Badge>
        </Row>
      ))}
    </Rows>
  );
}

/** Joined by (FR-1202): six rows that add up to the players joined. */
export function JoinedBySource({ language, data }: Props<Participation>) {
  const t = useTranslator(language);
  const shareText = useShareText(language);
  const rows: readonly BarRow[] = sourceRows(data.sources).map((row) => ({
    key: row.key,
    label: t(`analytics.source.${row.key}`),
    value: shareText(row.count, percentOf(row.count, data.joined)),
    share: data.joined === 0 ? 0 : row.count / data.joined,
  }));
  return <BarRows rows={rows} />;
}

function questBarRow(
  language: Language,
  shareText: (count: number, percent: number | null) => string,
  row: QuestRow,
): BarRow {
  return {
    key: row.id,
    label: (
      <>
        <span dir="auto">{textFor(row.title, language)}</span>
        <QuestScoreBadge language={language} questId={row.id} />
      </>
    ),
    value: shareText(row.done, row.percent),
    share: (row.percent ?? 0) / 100,
    meta: <span dir="auto">{textFor(row.category, language)}</span>,
  };
}

/** The most or the least popular quests (FR-1204), each with its players, its rate and its thumbs score (FR-1211). */
export function QuestList({
  language,
  rows,
}: Readonly<{ language: Language; rows: readonly QuestRow[] }>) {
  const t = useTranslator(language);
  const shareText = useShareText(language);
  if (rows.length === 0) {
    return <EmptyState>{t("control.quests.empty")}</EmptyState>;
  }
  return <BarRows rows={rows.map((row) => questBarRow(language, shareText, row))} />;
}

function funnelRow(
  t: ReturnType<typeof useTranslator>,
  language: Language,
  shareText: (count: number, percent: number | null) => string,
  step: FunnelStep,
): BarRow {
  const badges = (
    <>
      {step.skipped ? <Badge tone="info">{t("control.quests.skipped")}</Badge> : null}
      {step.largest ? <Badge tone="warning">{t("analytics.funnel.largest")}</Badge> : null}
    </>
  );
  return {
    key: step.id,
    label: <span dir="auto">{textFor(step.title, language)}</span>,
    flag: badges,
    value: shareText(step.done, step.percent),
    share: (step.percent ?? 0) / 100,
    meta:
      step.lost === null || step.lost === 0
        ? undefined
        : t("analytics.funnel.lost", {
            count: formatNumber(step.lost, language),
            percent: formatNumber(step.lostPercent ?? 0, language),
          }),
  };
}

/** The steps of one category as bars, with where players stopped. */
export function FunnelBars({
  language,
  steps,
  all,
}: Readonly<{ language: Language; steps: readonly FunnelStep[]; all: boolean }>) {
  const t = useTranslator(language);
  const shareText = useShareText(language);
  const shown = all ? steps : steps.slice(0, PANEL_ROWS);
  if (shown.length === 0) {
    return <EmptyState>{t("analytics.funnel.empty")}</EmptyState>;
  }
  return <BarRows rows={shown.map((step) => funnelRow(t, language, shareText, step))} />;
}

/** The categories that have steps, and which one the funnel opens on: the one with the largest drop, else the first. */
export function funnelChoices(data: QuestsAnalytics) {
  const choices = data.categories
    .map((category) => ({ category, steps: funnelOf(category, data.joined) }))
    .filter((choice) => choice.steps.length > 0);
  const stop = stopsOf(data)[0];
  const first = choices.find((choice) => choice.category.id === stop?.categoryId) ?? choices[0];
  return { choices, firstId: first?.category.id ?? null };
}

/** Category funnel (FR-1204): choose a category, read how many players reached each step and where they stopped. */
export function CategoryFunnel({ language, data }: Props<QuestsAnalytics>) {
  const t = useTranslator(language);
  const { choices, firstId } = funnelChoices(data);
  const [picked, setPicked] = useState<string | null>(null);
  const current =
    choices.find((choice) => choice.category.id === (picked ?? firstId)) ?? choices[0];
  if (current === undefined) {
    return <EmptyState>{t("analytics.funnel.empty")}</EmptyState>;
  }
  const drop = largestDrop(current.steps);
  return (
    <>
      <Field label={t("analytics.funnel.choose")}>
        <Select value={current.category.id} onChange={(event) => setPicked(event.target.value)}>
          {choices.map((choice) => (
            <option key={choice.category.id} value={choice.category.id}>
              {textFor(choice.category.name, language)}
            </option>
          ))}
        </Select>
      </Field>
      <Muted>
        <Badge>
          {t(current.category.inOrder ? "analytics.funnel.inOrder" : "analytics.funnel.anyOrder")}
        </Badge>
        {drop?.step.lost != null ? (
          <>
            {" "}
            <span dir="auto">
              {t("analytics.stops.after", { title: textFor(drop.after.title, language) })}
              {": "}
              {t("analytics.funnel.lost", {
                count: formatNumber(drop.step.lost, language),
                percent: formatNumber(drop.step.lostPercent ?? 0, language),
              })}
            </span>
          </>
        ) : null}
      </Muted>
      <FunnelBars language={language} steps={current.steps} all={false} />
    </>
  );
}

/** The full funnel of every category with steps, for "View more". */
export function AllFunnels({ language, data }: Props<QuestsAnalytics>) {
  const { choices } = funnelChoices(data);
  return (
    <>
      {choices.map((choice) => (
        <section key={choice.category.id} aria-label={textFor(choice.category.name, language)}>
          <h3 dir="auto">{textFor(choice.category.name, language)}</h3>
          <FunnelBars language={language} steps={choice.steps} all />
        </section>
      ))}
    </>
  );
}

/** Where players stop (FR-1204): the largest drop of each category in order, the biggest first. */
export function WherePlayersStop({
  language,
  data,
  all,
}: Props<QuestsAnalytics> & Readonly<{ all: boolean }>) {
  const t = useTranslator(language);
  const stops = stopsOf(data);
  const shown = all ? stops : stops.slice(0, PANEL_ROWS);
  if (shown.length === 0) {
    return <EmptyState>{t("analytics.stops.empty")}</EmptyState>;
  }
  return (
    <BarRows
      rows={shown.map((stop) => ({
        key: stop.categoryId,
        label: <span dir="auto">{textFor(stop.category, language)}</span>,
        value: t("analytics.funnel.lost", {
          count: formatNumber(stop.lost, language),
          percent: formatNumber(stop.lostPercent, language),
        }),
        share: stop.lostPercent / 100,
        meta: (
          <span dir="auto">
            {t("analytics.stops.after", { title: textFor(stop.after, language) })}
          </span>
        ),
      }))}
    />
  );
}

/** Redemptions per reward (FR-1205): redeemed, still waiting at the desk, and stock left. */
export function RewardRedemptions({
  language,
  data,
  all,
}: Props<Economy> & Readonly<{ all: boolean }>) {
  const t = useTranslator(language);
  const shown = all ? data.rewards : data.rewards.slice(0, PANEL_ROWS);
  if (shown.length === 0) {
    return <EmptyState>{t("analytics.rewards.empty")}</EmptyState>;
  }
  const most = Math.max(1, ...data.rewards.map((reward) => reward.redeemed));
  return (
    <BarRows
      rows={shown.map((reward) => ({
        key: reward.id,
        label: <span dir="auto">{textFor(reward.name, language)}</span>,
        flag: reward.removed ? (
          <Badge tone="info">{t("analytics.rewards.removed")}</Badge>
        ) : undefined,
        value: t("analytics.rewards.redeemed", { count: formatNumber(reward.redeemed, language) }),
        share: reward.redeemed / most,
        meta: t("analytics.rewards.meta", {
          unclaimed: formatNumber(reward.unclaimed, language),
          left: formatNumber(reward.stockLeft, language),
        }),
      }))}
    />
  );
}

/** The event's currency word for a tile title ("Points"), as the event renamed it. */
export function useCurrencyWord(language: Language): string {
  return termFor(useEventTerms().currency, language);
}
