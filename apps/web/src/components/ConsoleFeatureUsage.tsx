"use client";

import {
  USAGE_EVENTS_CAP,
  type FeatureUsageOrganizer,
  type FeatureUsageRow,
  type Language,
} from "@questify/shared";
import { useCallback, useEffect, useState } from "react";
import {
  causeKeyOf,
  featureUsagePath,
  featuresOn,
  readFeatureUsagePage,
  usageKeysOf,
} from "#src/lib/console-feature-usage.ts";
import { nameKeyOf } from "#src/lib/console-switches.ts";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { describeProblem } from "#src/lib/sign-in-errors.ts";
import { Button } from "#src/ui/Button.tsx";
import { Badge, Muted, Notice } from "#src/ui/Feedback.tsx";
import { Field, Form, Input } from "#src/ui/Field.tsx";
import { InfoTip } from "#src/ui/InfoTip.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Card, CardList, Row, Rows, Stack, SubHeading, Toolbar } from "#src/ui/Section.tsx";
import { TextLink } from "#src/ui/Text.tsx";

/** A feature's state as words: On or Off, and what put it there when it is not just the platform's own default. */
function StateBadges({ language, row }: Readonly<{ language: Language; row: FeatureUsageRow }>) {
  const t = translatorFor(language);
  const cause = causeKeyOf(row);
  return (
    <>
      <Badge tone={row.effective ? "success" : "danger"}>
        {t(row.effective ? "console.featureUsage.on" : "console.featureUsage.off")}
      </Badge>
      {cause === null ? null : (
        <Badge tone={row.override === null ? "neutral" : "info"}>{t(cause)}</Badge>
      )}
    </>
  );
}

/** For a feature that is on: in how many of the events read it is on, and in how many it has content. */
function UsageText({
  language,
  row,
  events,
}: Readonly<{ language: Language; row: FeatureUsageRow; events: number }>) {
  const t = translatorFor(language);
  const keys = usageKeysOf(row);
  return (
    <Muted as="span">
      {t(keys.line, { on: row.eventsOn, total: events })}
      {keys.use === null ? null : ` · ${t(keys.use, { used: row.eventsUsing ?? 0 })}`}
    </Muted>
  );
}

function FeatureLine({
  language,
  row,
  events,
}: Readonly<{ language: Language; row: FeatureUsageRow; events: number }>) {
  const t = translatorFor(language);
  const nameKey = nameKeyOf("feature", row.key);
  return (
    <Row
      data-testid="feature-usage-row"
      data-feature={row.key}
      data-state={row.effective ? "on" : "off"}
      main={
        <Stack>
          <span>
            {nameKey === undefined ? row.key : t(nameKey)}{" "}
            <StateBadges language={language} row={row} />
          </span>
          {row.effective ? <UsageText language={language} row={row} events={events} /> : null}
        </Stack>
      }
    />
  );
}

function OrganizerCard({
  language,
  organizer,
}: Readonly<{ language: Language; organizer: FeatureUsageOrganizer }>) {
  const t = translatorFor(language);
  return (
    <Card as="li" data-testid="feature-usage-organizer" data-organizer={organizer.id}>
      <Stack>
        <SubHeading as="h2">
          <TextLink href={`/${language}/console/organizers/${organizer.id}`} strong>
            <bdi>{organizer.name}</bdi>
          </TextLink>
        </SubHeading>
        <Muted>
          {t("console.featureUsage.events", { count: organizer.events })}
          {" · "}
          {t("console.featureUsage.featuresOn", {
            on: featuresOn(organizer.features),
            total: organizer.features.length,
          })}
        </Muted>
        {organizer.more ? <Muted>{t("console.featureUsage.older")}</Muted> : null}
        <Rows>
          {organizer.features.map((row) => (
            <FeatureLine key={row.key} language={language} row={row} events={organizer.events} />
          ))}
        </Rows>
      </Stack>
    </Card>
  );
}

function Results({
  language,
  rows,
  failed,
}: Readonly<{
  language: Language;
  rows: readonly FeatureUsageOrganizer[] | null;
  failed: boolean;
}>) {
  const t = translatorFor(language);
  if (rows === null) {
    return failed ? null : <Muted role="status">{t("common.loading")}</Muted>;
  }
  if (rows.length === 0) {
    return <Muted>{t("console.organizers.none")}</Muted>;
  }
  return (
    <CardList>
      {rows.map((organizer) => (
        <OrganizerCard key={organizer.id} language={language} organizer={organizer} />
      ))}
    </CardList>
  );
}

/** The pages read for a search: the organizers so far, the cursor of the next page, and why the last read failed. */
function useFeatureUsage(language: Language, query: string) {
  const t = translatorFor(language);
  const [rows, setRows] = useState<FeatureUsageOrganizer[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const load = useCallback(
    async (cursor: string | null) => {
      const result = await requestJson("GET", featureUsagePath({ q: query, cursor }));
      const page = result.ok ? readFeatureUsagePage(result.body) : undefined;
      if (page === undefined) {
        setProblem(describeProblem(result.body, language, t).text);
        return;
      }
      setProblem(null);
      setRows((current) =>
        cursor === null ? page.organizers : [...(current ?? []), ...page.organizers],
      );
      setNext(page.nextCursor);
    },
    [query, language, t],
  );
  useEffect(() => {
    void load(null);
  }, [load]);
  return { rows, next, problem, load };
}

/**
 * The console's feature usage (T-714, FR-1839, ADR-550): search organizers by name or slug and see, for each, every
 * event-level feature with its state (on, off, and why) and the events that have it on and use it. Read only; counts
 * only; platform admins only.
 */
export function ConsoleFeatureUsage({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const { rows, next, problem, load } = useFeatureUsage(language, query);
  return (
    <Stack as="section" aria-labelledby="console-feature-usage-title">
      <PageHeader
        titleId="console-feature-usage-title"
        title={t("console.featureUsage.title")}
        info={
          <InfoTip label={t("common.info")}>
            {t("console.featureUsage.intro", { count: USAGE_EVENTS_CAP })}
          </InfoTip>
        }
      />
      <Form
        onSubmit={(submitted) => {
          submitted.preventDefault();
          if (draft === query) {
            void load(null);
          } else {
            setQuery(draft);
          }
        }}
      >
        <Field label={t("console.featureUsage.search")}>
          <Input
            type="search"
            maxLength={254}
            value={draft}
            onChange={(changed) => setDraft(changed.target.value)}
          />
        </Field>
        <Toolbar>
          <Button type="submit" variant="primary">
            {t("console.organizers.find")}
          </Button>
        </Toolbar>
      </Form>
      {problem === null ? null : (
        <Notice tone="danger" role="alert">
          {problem}
        </Notice>
      )}
      <Results language={language} rows={rows} failed={problem !== null} />
      {next === null ? null : (
        <Button variant="quiet" onClick={() => void load(next)}>
          {t("console.organizers.more")}
        </Button>
      )}
    </Stack>
  );
}
