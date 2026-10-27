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
import styles from "#src/components/layout.module.css";

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
    <p role="alert" className={styles.alert}>
      {body === "network" ? t("join.network") : problemOf(body, language, t)}
    </p>
  );
}

function Avatar({ avatar }: Readonly<{ avatar: string }>) {
  const known = AVATARS.find((name) => name === avatar);
  return known === undefined ? null : (
    <img
      className={styles.rankAvatar}
      src={`/avatars/${known}.png`}
      alt=""
      width={32}
      height={32}
    />
  );
}

function TopTen({ language, season }: Readonly<{ language: Language; season: QuestifySeason }>) {
  const t = translatorFor(language);
  const month = formatLocalMonth(season.month, language);
  if (season.rows.length === 0) {
    return <p className={styles.muted}>{t("console.seasons.empty", { month })}</p>;
  }
  return (
    <>
      <h2 className={styles.subtitle}>{t("console.seasons.top", { month })}</h2>
      <ol className={styles.list}>
        {season.rows.map((row) => (
          <li key={row.rank} className={styles.card} data-testid="season-row">
            <span className={styles.who}>
              <span className={styles.rankNumber}>{row.rank}</span>
              <Avatar avatar={row.avatar} />
              <span dir="auto">{row.username}</span>
            </span>
            <span className={`${styles.who} ${styles.muted}`}>
              <span>{t("explore.xp", { xp: row.xp })}</span>
              <span>{t("level.number", { level: row.level })}</span>
            </span>
          </li>
        ))}
      </ol>
    </>
  );
}

/** A season's top 10, read when its header opens. */
function SeasonTop({ language, month }: Readonly<{ language: Language; month: string }>) {
  const t = translatorFor(language);
  const state = useRead(seasonPath(month), readSeason);
  return (
    <div id={`season-${month}`} className={styles.stack} data-testid="season-top">
      {state.kind === "loading" ? <p className={styles.muted}>{t("common.loading")}</p> : null}
      {state.kind === "failed" ? <Problem language={language} body={state.body} /> : null}
      {state.kind === "ready" ? <TopTen language={language} season={state.value} /> : null}
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
    <li className={styles.stack} data-testid="season" data-month={season.month}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`season-${season.month}`}
        className={`${styles.card} ${styles.disclosure}`}
        onClick={toggle}
      >
        <span className={styles.who}>
          <span>{formatLocalMonth(season.month, language)}</span>
          {season.current ? (
            <span className={styles.badge}>{t("console.seasons.current")}</span>
          ) : null}
        </span>
        <span>{t("console.seasons.players", { count: season.players })}</span>
      </button>
      {open ? <SeasonTop language={language} month={season.month} /> : null}
    </li>
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
    <section className={styles.stack} aria-labelledby="console-seasons-title">
      <h1 id="console-seasons-title" className={styles.title}>
        {t("console.seasons.title")}
      </h1>
      <p className={styles.muted}>{t("console.seasons.intro")}</p>
      {list.kind === "loading" ? <p className={styles.muted}>{t("common.loading")}</p> : null}
      {list.kind === "failed" ? <Problem language={language} body={list.body} /> : null}
      {list.kind === "ready" ? (
        <ul className={styles.list} aria-label={t("console.seasons.choose")}>
          {list.value.map((season) => (
            <SeasonItem
              key={season.month}
              language={language}
              season={season}
              open={open === season.month}
              toggle={() => setChosen(open === season.month ? null : season.month)}
            />
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** The console home's link to this page. */
export function ConsoleSeasonsLink({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  return (
    <p>
      <a className={styles.textLink} href={`/${language}/console/seasons`}>
        {t("console.seasons.title")}
      </a>
    </p>
  );
}
