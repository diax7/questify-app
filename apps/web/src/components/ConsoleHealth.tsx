"use client";

import type { HealthFact, HealthTile, HealthView, Language } from "@questify/shared";
import { Fragment, useId, useState } from "react";
import styles from "#src/components/health.module.css";
import { nameIn } from "#src/lib/console.ts";
import { clockOf } from "#src/lib/console-organizers.ts";
import {
  HEALTH_API,
  STATE_ICON,
  cappedCount,
  factValue,
  readHealthView,
} from "#src/lib/console-platform.ts";
import { translatorFor } from "#src/lib/language.ts";
import { useConsoleRead } from "#src/lib/use-console-read.ts";
import { Button } from "#src/ui/Button.tsx";
import { Figure, PanelGrid, Tile } from "#src/ui/Charts.tsx";
import { Badge, Muted, Notice } from "#src/ui/Feedback.tsx";
import { Icon } from "#src/ui/Icon.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { FactList, Stack, SubHeading } from "#src/ui/Section.tsx";
import { TextLink } from "#src/ui/Text.tsx";

const STATE_TONE = { ok: "success", warning: "warning", down: "danger" } as const;

/** The pages reread the health every half minute while they are open; the API allows 60 reads a minute. */
const REFRESH_MS = 30_000;
/** The point entries of one event are counted up to this many, so a busy event reads "100,000+". */
const ENTRIES_CAP = 100_001;

function Facts({
  language,
  label,
  facts,
}: Readonly<{ language: Language; label: string; facts: readonly HealthFact[] }>) {
  const t = translatorFor(language);
  return (
    <FactList label={label}>
      {facts.map((fact) => (
        <Fragment key={fact.key}>
          <dt>{t(`console.health.fact.${fact.key}`)}</dt>
          <dd data-testid={`fact-${fact.key}`}>{factValue(t, fact, language)}</dd>
        </Fragment>
      ))}
    </FactList>
  );
}

function Busiest({
  language,
  busiest,
}: Readonly<{ language: Language; busiest: HealthView["busiest"] }>) {
  const t = translatorFor(language);
  return (
    <Stack>
      <SubHeading as="h4">{t("console.health.busiest")}</SubHeading>
      {busiest.length === 0 ? (
        <Muted>{t("console.health.busiestNone")}</Muted>
      ) : (
        <ul className={styles.list} data-testid="busiest-events">
          {busiest.map((event) => (
            <li key={event.id} className={styles.line}>
              <TextLink strong href={`/${language}/console/events/${event.id}`} dir="auto">
                {nameIn(event.name, language)}
              </TextLink>
              <Muted as="span">
                <bdi>{event.organizer}</bdi>
                {" · "}
                {t("console.health.busiestEntries", {
                  count: cappedCount(event.entries, language, ENTRIES_CAP),
                })}
              </Muted>
            </li>
          ))}
        </ul>
      )}
    </Stack>
  );
}

/** One tile: its name, its main figure, its state with the icon and the word, and the rest behind View more. */
function HealthTileCard({
  language,
  tile,
  busiest,
}: Readonly<{ language: Language; tile: HealthTile; busiest: HealthView["busiest"] }>) {
  const t = translatorFor(language);
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const hasMore = tile.facts.length > 0 || tile.key === "events";
  return (
    <div className={styles.cell} data-testid={`health-${tile.key}`} data-state={tile.state}>
      <Tile title={t(`console.health.tile.${tile.key}`)} level={2}>
        <Stack>
          <Figure>{factValue(t, tile.figure, language)}</Figure>
          <Muted as="span">{t(`console.health.fact.${tile.figure.key}`)}</Muted>
          <span className={styles.state}>
            <span className={`${styles.mark} ${styles[tile.state]}`}>
              <Icon name={STATE_ICON[tile.state]} />
            </span>
            <Badge tone={STATE_TONE[tile.state]}>
              <span data-testid="health-state">{t(`console.health.state.${tile.state}`)}</span>
            </Badge>
          </span>
          {tile.reasons.length === 0 ? null : (
            <ul className={styles.reasons}>
              {tile.reasons.map((reason) => (
                <li key={reason}>{t(`console.health.reason.${reason}`)}</li>
              ))}
            </ul>
          )}
        </Stack>
        {hasMore ? (
          <Stack>
            <Button
              size="sm"
              aria-expanded={open}
              aria-controls={detailsId}
              onClick={() => setOpen(!open)}
            >
              {open ? t("console.health.less") : t("console.health.more")}
            </Button>
            {open ? (
              <div id={detailsId}>
                <Stack>
                  <Facts
                    language={language}
                    label={t(`console.health.tile.${tile.key}`)}
                    facts={tile.facts}
                  />
                  {tile.key === "events" ? <Busiest language={language} busiest={busiest} /> : null}
                </Stack>
              </div>
            ) : null}
          </Stack>
        ) : null}
      </Tile>
    </div>
  );
}

/**
 * The console's health view (T-709, FR-1783): six equal tiles, each with its main figure and a state shown by an icon
 * and a word (OK, Warning, Down), the facts behind View more. Read only, counts and flags only; platform admins only.
 * It rereads every 30 seconds while open.
 */
export function ConsoleHealth({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const { state, reload } = useConsoleRead(HEALTH_API, readHealthView, REFRESH_MS);
  return (
    <Stack as="section" aria-labelledby="console-health-title">
      <PageHeader
        titleId="console-health-title"
        title={t("console.health.title")}
        actions={<Button onClick={() => void reload()}>{t("console.health.refresh")}</Button>}
      />
      {state.kind === "loading" ? <Muted role="status">{t("common.loading")}</Muted> : null}
      {state.kind === "failed" ? (
        <Notice tone="danger" role="alert">
          {t("console.health.loadFailed")}{" "}
          <Button size="sm" onClick={() => void reload()}>
            {t("common.retry")}
          </Button>
        </Notice>
      ) : null}
      {state.kind === "ready" ? (
        <>
          <Muted>{t("console.health.updated", { time: clockOf(state.value.at, language) })}</Muted>
          <PanelGrid>
            {state.value.tiles.map((tile) => (
              <HealthTileCard
                key={tile.key}
                language={language}
                tile={tile}
                busiest={state.value.busiest}
              />
            ))}
          </PanelGrid>
        </>
      ) : null}
    </Stack>
  );
}
