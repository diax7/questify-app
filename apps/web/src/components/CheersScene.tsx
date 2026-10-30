"use client";

import {
  CHEER_EMOJI,
  CHEER_NAME_KEYS,
  CHEER_REACTIONS,
  formatNumber,
  type Language,
} from "@questify/shared";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useClock } from "#src/components/FinaleScene.tsx";
import {
  SCENE_POLL_MS,
  clockParts,
  floatersFor,
  freshCheers,
  remainingMs,
  type CheersView,
  type Floater,
} from "#src/lib/big-screen.ts";
import type { translatorFor } from "#src/lib/language.ts";
import styles from "#src/components/device.module.css";

type Translate = ReturnType<typeof translatorFor>;

/** How long a floating reaction lives (its animation is 5 seconds), after its start delay. */
const FLOAT_LIFE_MS = 8000;

type Live = Readonly<Floater & { until: number }>;

/**
 * The reactions to float: each answer's cheers the page has not shown yet, placed across the stage and started over the
 * next poll interval. What it showed is remembered by sequence number, so a repeated answer floats nothing twice, and the
 * list drops reactions whose animation is over.
 */
function useFloaters(cheers: CheersView): readonly Floater[] {
  const seen = useRef(-1);
  const [floating, setFloating] = useState<readonly Live[]>([]);
  useEffect(() => {
    const fresh = freshCheers(cheers.recent, seen.current);
    const now = Date.now();
    seen.current = fresh.at(-1)?.seq ?? seen.current;
    setFloating((before) => [
      ...before.filter((floater) => floater.until > now),
      ...floatersFor(fresh, SCENE_POLL_MS).map((floater) => ({
        ...floater,
        until: now + floater.delay + FLOAT_LIFE_MS,
      })),
    ]);
  }, [cheers]);
  return floating;
}

/** The time left in the moment as minutes and seconds in Western digits (a colon between two digits keeps their order). */
function Remaining({
  endsAt,
  clockOffset,
  t,
}: Readonly<{ endsAt: number; clockOffset: number; t: Translate }>) {
  const now = useClock(true);
  const { minutes, seconds } = clockParts(remainingMs(endsAt, clockOffset, now));
  return (
    <p className={styles.cheersClock} role="timer" aria-live="off">
      {t("screen.cheers.endsIn", { time: `${minutes}:${seconds}` })}
    </p>
  );
}

/**
 * The Cheers scene (T-509, FR-1841): an invitation, the time left, each of the five reactions with its running count, and
 * the reactions floating up the stage as players send them. Nothing names a player.
 */
export function CheersScene({
  cheers,
  clockOffset,
  language,
  t,
}: Readonly<{ cheers: CheersView; clockOffset: number; language: Language; t: Translate }>) {
  const floating = useFloaters(cheers);
  return (
    <>
      <div className={styles.cheersSky} aria-hidden="true">
        {floating.map((floater) => (
          <span
            key={floater.key}
            className={styles.cheersFloater}
            style={{ "--left": floater.left, "--delay": floater.delay } as CSSProperties}
          >
            {CHEER_EMOJI[floater.reaction]}
          </span>
        ))}
      </div>
      <p className={styles.cheersPrompt}>{t("screen.cheers.prompt")}</p>
      <Remaining endsAt={cheers.endsAt} clockOffset={clockOffset} t={t} />
      <ul className={styles.cheersTotals}>
        {CHEER_REACTIONS.map((reaction) => (
          <li key={reaction} className={styles.cheersTotal}>
            <span
              className={styles.cheersEmoji}
              role="img"
              aria-label={t(CHEER_NAME_KEYS[reaction])}
            >
              {CHEER_EMOJI[reaction]}
            </span>
            <span className={styles.cheersCount}>
              {formatNumber(cheers.totals[reaction], language)}
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}
