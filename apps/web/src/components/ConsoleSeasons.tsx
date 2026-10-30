"use client";

import { AVATARS, formatLocalMonth, type Language, type QuestifySeason } from "@questify/shared";
import { useEffect, useState } from "react";
import { problemOf } from "#src/components/PlayerAwards.tsx";
import {
  SEASONS_API,
  openingMonth,
  readSeason,
  readSeasons,
  seasonPath,
  type SeasonListing,
} from "#src/lib/console-seasons.ts";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { Button } from "#src/ui/Button.tsx";
import { Badge, Muted, Notice } from "#src/ui/Feedback.tsx";
import { NavItem } from "#src/ui/Nav.tsx";
import { PageHeader } from "#src/ui/PageHeader.tsx";
import { Card, CardList, Stack, SubHeading, Toolbar } from "#src/ui/Section.tsx";
import { InfoTip } from "#src/ui/InfoTip.tsx";

type Read<T> =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "failed"; body: unknown }>
  | Readonly<{ kind: "ready"; value: T }>;

/** One read of the API, shown as loading, failed (the answer, or "network") or ready once the shape is checked. */
function useRead<T>(path: string, read: (body: unknown) => T | undefined): Read<T> {
  const [state, setState] = useState<Read<T>>({ kind: "loading" });
  useEffect(() => {
    let current = true;
    void requestJson("GET", path).then((result) => {
      const value = result.ok ? read(result.body) : undefined;
      if (current) {
        setState(
          value === undefined
            ? { kind: "failed", body: result.body ?? "network" }
            : { kind: "ready", value },
        );
      }
    });
    return () => {
      current = false;
    };
  }, [path, read]);
  return state;
}

function Problem({ language, body }: Readonly<{ language: Language; body: unknown }>) {
  const t = translatorFor(language);
  return (
    <Notice tone="danger" role="alert">
      {body === "network" ? t("join.network") : problemOf(body, language, t)}
    </Notice>
  );
}

function Avatar({ avatar }: Readonly<{ avatar: string }>) {
  const known = AVATARS.find((name) => name === avatar);
  return known === undefined ? null : (
    <img
      src={`/avatars/${known}.png`}
      alt=""
      width={32}
      height={32}
      style={{ borderRadius: "50%" }}
    />
  );
}

function TopTen({ language, season }: Readonly<{ language: Language; season: QuestifySeason }>) {
  const t = translatorFor(language);
  const month = formatLocalMonth(season.month, language);
  if (season.rows.length === 0) {
    return <Muted>{t("console.seasons.empty", { month })}</Muted>;
  }
  return (
    <>
      <SubHeading as="h2">{t("console.seasons.top", { month })}</SubHeading>
      <CardList>
        {season.rows.map((row) => (
          <Card as="li" key={row.rank} data-testid="season-row">
            <Toolbar>
              <strong>{row.rank}</strong>
              <Avatar avatar={row.avatar} />
              <span dir="auto">{row.username}</span>
              <Muted as="span">{t("console.seasons.xp", { xp: row.xp })}</Muted>
              <Muted as="span">{t("console.seasons.level", { level: row.level })}</Muted>
            </Toolbar>
          </Card>
        ))}
      </CardList>
    </>
  );
}

/** A season's top 10, read when its header opens. */
function SeasonTop({ language, month }: Readonly<{ language: Language; month: string }>) {
  const t = translatorFor(language);
  const state = useRead(seasonPath(month), readSeason);
  return (
    <div id={`season-${month}`} data-testid="season-top">
      <Stack>
        {state.kind === "loading" ? <Muted role="status">{t("common.loading")}</Muted> : null}
        {state.kind === "failed" ? <Problem language={language} body={state.body} /> : null}
        {state.kind === "ready" ? <TopTen language={language} season={state.value} /> : null}
      </Stack>
    </div>
  );
}

function SeasonItem({
  language,
  season,
  open,
  toggle,
}: Readonly<{
  language: Language;
  season: SeasonListing;
  open: boolean;
  toggle: () => void;
}>) {
  const t = translatorFor(language);
  return (
    <Card as="li" data-testid="season" data-month={season.month}>
      <Button wide aria-expanded={open} aria-controls={`season-${season.month}`} onClick={toggle}>
        <span>
          {formatLocalMonth(season.month, language)}{" "}
          {season.current ? <Badge>{t("console.seasons.current")}</Badge> : null}
        </span>
        <span>{t("console.seasons.players", { count: season.players })}</span>
      </Button>
      {open ? <SeasonTop language={language} month={season.month} /> : null}
    </Card>
  );
}

/**
 * The console's Ranking seasons (T-408c, FR-1786, ADR-323): every Questify month newest first with its ranked count,
 * the current one marked, and the open month's top 10. The page opens on the current month. Read only: seasons turn
 * over by themselves, so there is no reset (Q-292).
 */
export function ConsoleSeasons({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  const list = useRead(SEASONS_API, readSeasons);
  const [chosen, setChosen] = useState<string | null | undefined>(undefined);
  const opening = list.kind === "ready" ? openingMonth(list.value) : null;
  const open = chosen === undefined ? opening : chosen;
  return (
    <Stack as="section" aria-labelledby="console-seasons-title">
      <PageHeader
        titleId="console-seasons-title"
        title={t("console.seasons.title")}
        info={<InfoTip label={t("common.info")}>{t("console.seasons.intro")}</InfoTip>}
      />
      {list.kind === "loading" ? <Muted role="status">{t("common.loading")}</Muted> : null}
      {list.kind === "failed" ? <Problem language={language} body={list.body} /> : null}
      {list.kind === "ready" ? (
        <CardList>
          {list.value.map((season) => (
            <SeasonItem
              key={season.month}
              language={language}
              season={season}
              open={open === season.month}
              toggle={() => setChosen(open === season.month ? null : season.month)}
            />
          ))}
        </CardList>
      ) : null}
    </Stack>
  );
}

/** This page's item in the console's navigation. */
export function ConsoleSeasonsLink({
  language,
  current,
}: Readonly<{ language: Language; current: boolean }>) {
  const t = translatorFor(language);
  return (
    <NavItem href={`/${language}/console/seasons`} icon="sun" current={current}>
      {t("console.seasons.title")}
    </NavItem>
  );
}
