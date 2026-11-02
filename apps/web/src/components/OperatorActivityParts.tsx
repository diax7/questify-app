"use client";

import {
  formatNumber,
  type Language,
  type MessageKey,
  type OperatorActivityRow,
  type OperatorRecent,
} from "@questify/shared";
import { useState } from "react";
import { useTranslator } from "#src/components/TermsScope.tsx";
import {
  actionKey,
  agoText,
  clockOf,
  isQuiet,
  minutesQuiet,
  nextRecent,
  summaryOf,
} from "#src/lib/operator-activity.ts";
import type { Translate } from "#src/lib/language.ts";
import { handleOf } from "#src/lib/players.ts";
import { textFor } from "#src/lib/quests.ts";
import { Button } from "#src/ui/Button.tsx";
import { Figure, PanelGrid, Tile } from "#src/ui/Charts.tsx";
import { Badge, EmptyState, Muted } from "#src/ui/Feedback.tsx";
import { Row, Rows, Section } from "#src/ui/Section.tsx";

/** How many operators the card lists before "View more". */
const OPERATOR_ROWS = 10;

type Titled = Readonly<{ titleAr: string | null; titleEn: string | null }>;

/** A station's name in the page's language, the other one when it has only one. */
export const stationName = (station: Titled, language: Language): string =>
  textFor({ ar: station.titleAr, en: station.titleEn }, language);

/** The five numbers of the event's day as equal tiles. */
export function ActivityTiles({
  language,
  rows,
  asOf,
}: Readonly<{ language: Language; rows: readonly OperatorActivityRow[]; asOf: string }>) {
  const t = useTranslator(language);
  const summary = summaryOf(rows, asOf);
  const tiles = [
    ["operatorActivity.tile.active", summary.active],
    ["operatorActivity.tile.scansHour", summary.scansHour],
    ["operatorActivity.tile.scans", summary.scans],
    ["operatorActivity.tile.awards", summary.awards],
    ["operatorActivity.tile.handOvers", summary.handOvers],
  ] as const;
  return (
    <PanelGrid kind="tiles">
      {tiles.map(([title, count]) => (
        <Tile key={title} title={t(title)}>
          <Figure>{formatNumber(count, language)}</Figure>
        </Tile>
      ))}
    </PanelGrid>
  );
}

/** What an operator last did and when: the action, how long ago and the time of day. */
function LastActivity({
  row,
  asOf,
  language,
}: Readonly<{ row: OperatorActivityRow; asOf: string; language: Language }>) {
  const t = useTranslator(language);
  const quiet = minutesQuiet(row.lastAt, asOf);
  if (quiet === null || row.lastAt === null || row.lastAction === null) {
    return <Muted>{t("operatorActivity.noActivity")}</Muted>;
  }
  return (
    <Muted>
      {t("operatorActivity.last")}:{" "}
      {t("operatorActivity.lastLine", {
        action: t(actionKey(row.lastAction)),
        when: agoText(quiet, language),
      })}{" "}
      (
      <time dateTime={row.lastAt} dir="ltr">
        {clockOf(row.lastAt)}
      </time>
      )
    </Muted>
  );
}

/** The other counts of an operator's day, the ones that are not zero. */
function otherCounts(row: OperatorActivityRow, t: Translate, language: Language): string[] {
  const counts: ReadonlyArray<readonly [MessageKey, number]> = [
    ["operatorActivity.awardsLine", row.awards],
    ["operatorActivity.handOversLine", row.handOvers],
    ["operatorActivity.handledLine", row.handled],
  ];
  return counts
    .filter(([, count]) => count > 0)
    .map(([key, count]) => t(key, { count: formatNumber(count, language) }));
}

function OperatorLine({
  row,
  asOf,
  language,
}: Readonly<{ row: OperatorActivityRow; asOf: string; language: Language }>) {
  const t = useTranslator(language);
  const others = otherCounts(row, t, language);
  return (
    <Row
      main={
        <>
          <strong>
            <bdi>{handleOf(row.username, language)}</bdi>{" "}
            {isQuiet(row, asOf) ? (
              <Badge tone="warning">{t("operatorActivity.quiet")}</Badge>
            ) : null}
          </strong>
          <LastActivity row={row} asOf={asOf} language={language} />
          <Muted>
            {t("operatorActivity.scansLine", {
              hour: formatNumber(row.scansHour, language),
              today: formatNumber(row.scans, language),
            })}
          </Muted>
          {others.length === 0 ? null : <Muted>{others.join(" · ")}</Muted>}
          {row.stations.length === 0 ? null : (
            <Muted>
              {t("operatorActivity.stations")}:{" "}
              {row.stations
                .map((station) =>
                  t("operatorActivity.stationLine", {
                    title: stationName(station, language),
                    count: formatNumber(station.scans, language),
                  }),
                )
                .join(" · ")}
            </Muted>
          )}
        </>
      }
    />
  );
}

/** Each operator with the day's numbers and the last thing they did, the most recently active first. */
export function OperatorRows({
  language,
  rows,
  asOf,
}: Readonly<{ language: Language; rows: readonly OperatorActivityRow[]; asOf: string }>) {
  const t = useTranslator(language);
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, OPERATOR_ROWS);
  return (
    <Section
      level={3}
      title={t("operatorActivity.byOperator")}
      actions={
        rows.length > OPERATOR_ROWS && !all ? (
          <Button
            variant="quiet"
            size="sm"
            onClick={() => setAll(true)}
            aria-label={t("operatorActivity.viewMoreOf", {
              title: t("operatorActivity.byOperator"),
            })}
          >
            {t("operatorActivity.viewMore")}
          </Button>
        ) : undefined
      }
    >
      <Rows>
        {shown.map((row) => (
          <OperatorLine key={row.id} row={row} asOf={asOf} language={language} />
        ))}
      </Rows>
    </Section>
  );
}

function RecentLine({
  action,
  language,
}: Readonly<{ action: OperatorRecent; language: Language }>) {
  const t = useTranslator(language);
  const what = t(actionKey(action.action));
  return (
    <Row
      main={
        <>
          <strong>
            <bdi>{handleOf(action.username, language)}</bdi>
          </strong>
          <Muted>
            {action.questId === null
              ? what
              : t("operatorActivity.recent.row", {
                  action: what,
                  station: stationName(action, language),
                })}
          </Muted>
        </>
      }
    >
      <Muted as="span">
        <time dateTime={action.at} dir="ltr">
          {clockOf(action.at)}
        </time>
      </Muted>
    </Row>
  );
}

/** The latest actions of all the operators, five at first and "View more" for longer lists. */
export function RecentCard({
  language,
  recent,
  limit,
  more,
}: Readonly<{
  language: Language;
  recent: readonly OperatorRecent[];
  limit: number;
  more: (next: number) => void;
}>) {
  const t = useTranslator(language);
  const next = nextRecent(limit);
  return (
    <Section
      level={3}
      title={t("operatorActivity.recent.title")}
      actions={
        next !== null && recent.length >= limit ? (
          <Button
            variant="quiet"
            size="sm"
            onClick={() => more(next)}
            aria-label={t("operatorActivity.viewMoreOf", {
              title: t("operatorActivity.recent.title"),
            })}
          >
            {t("operatorActivity.viewMore")}
          </Button>
        ) : undefined
      }
    >
      {recent.length === 0 ? <EmptyState>{t("operatorActivity.recent.none")}</EmptyState> : null}
      {recent.length === 0 ? null : (
        <Rows>
          {recent.map((action) => (
            <RecentLine
              key={`${action.operatorId}-${action.at}-${action.action}-${action.questId ?? ""}`}
              action={action}
              language={language}
            />
          ))}
        </Rows>
      )}
    </Section>
  );
}
