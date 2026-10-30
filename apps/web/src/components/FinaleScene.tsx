"use client";

import { formatNumber, type Language } from "@questify/shared";
import { useEffect, useState, type CSSProperties } from "react";
import { Avatar, CommunityScene } from "#src/components/BigScreenParts.tsx";
import {
  clockParts,
  remainingMs,
  type FinaleView,
  type FinaleWinner,
} from "#src/lib/big-screen.ts";
import type { translatorFor } from "#src/lib/language.ts";
import styles from "#src/components/device.module.css";

type Translate = ReturnType<typeof translatorFor>;

/** The page's clock in milliseconds, moved on every second while `running`. */
export function useClock(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) {
      return undefined;
    }
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}

/** Hours, minutes and seconds to the finale, always left to right so the digits keep their order in Arabic. */
function Countdown({
  startsAt,
  clockOffset,
  t,
}: Readonly<{ startsAt: number; clockOffset: number; t: Translate }>) {
  const now = useClock(true);
  const left = remainingMs(startsAt, clockOffset, now);
  if (left <= 0) {
    return <p className={styles.finaleStarting}>{t("screen.finale.starting")}</p>;
  }
  const { hours, minutes, seconds } = clockParts(left);
  const units = [
    [hours, "screen.finale.hours"],
    [minutes, "screen.finale.minutes"],
    [seconds, "screen.finale.seconds"],
  ] as const;
  return (
    <>
      <p className={styles.goalTitle}>{t("screen.finale.countdown")}</p>
      <p className={styles.finaleClock} dir="ltr" role="timer" aria-live="off">
        {units.map(([value, label]) => (
          <span key={label} className={styles.finaleUnit}>
            <span className={styles.finaleDigits}>{value}</span>
            <span className={styles.finaleLabel}>{t(label)}</span>
          </span>
        ))}
      </p>
    </>
  );
}

function Winners({
  winners,
  language,
  t,
}: Readonly<{ winners: readonly FinaleWinner[]; language: Language; t: Translate }>) {
  return (
    <>
      <p className={styles.goalTitle}>{t("screen.finale.winners")}</p>
      <ol className={styles.board}>
        {winners.map((winner, index) => {
          const name = winner.username ?? t("player.deleted");
          return (
            <li
              key={winner.place}
              className={`${styles.boardRow} ${styles.winnerRow} ${winner.place === 1 ? styles.boardLeader : ""}`}
              style={{ "--rank": index } as CSSProperties}
            >
              <span className={styles.boardPlace}>{formatNumber(winner.place, language)}</span>
              <Avatar row={{ avatar: winner.avatar, username: name }} />
              <span className={styles.boardName} dir="auto">
                {name}
              </span>
            </li>
          );
        })}
      </ol>
    </>
  );
}

/**
 * The finale scene (T-307b, FR-254, FR-255, FR-1621): the countdown, then the last push (the attached goal's bar, and
 * "not reached" when it was missed), then the winners once the owner revealed them, each with a username and an avatar
 * and no score. `clockOffset` keeps the countdown on the server's clock.
 */
export function FinaleScene({
  finale,
  clockOffset,
  language,
  t,
}: Readonly<{ finale: FinaleView; clockOffset: number; language: Language; t: Translate }>) {
  switch (finale.phase) {
    case "countdown":
      return <Countdown startsAt={finale.startsAt} clockOffset={clockOffset} t={t} />;
    case "push":
      return (
        <>
          <p className={styles.sceneTitle}>{t("screen.finale.push")}</p>
          <CommunityScene goal={finale.goal} language={language} t={t} />
          {finale.goal.status === "running" ? null : (
            <p className={styles.muted}>{t("screen.finale.soon")}</p>
          )}
        </>
      );
    case "waiting":
      return <p className={styles.message}>{t("screen.finale.soon")}</p>;
    case "reveal":
      return <Winners winners={finale.winners} language={language} t={t} />;
  }
}
