"use client";

import {
  formatNumber,
  termFor,
  type EventTerms,
  type Language,
  type MessageKey,
  type NameDisplay,
} from "@questify/shared";
import { useEffect, useMemo, useRef, useState } from "react";
import { Avatar, CommunityScene, ScreenName } from "#src/components/BigScreenParts.tsx";
import { CheersScene } from "#src/components/CheersScene.tsx";
import { DevicePairing } from "#src/components/DevicePairing.tsx";
import { FinaleScene } from "#src/components/FinaleScene.tsx";
import { PhotoScene } from "#src/components/PhotoScene.tsx";
import { useWakeLock } from "#src/components/StationScreen.tsx";
import {
  EMPTY_SKIP_MS,
  SCENE_MS,
  SCENE_POLL_MS,
  SLOWED_MS,
  isEmpty,
  nextScene,
  runningOf,
  sceneAnswerOf,
  shareOf,
  type Known,
  type PollView,
  type RankingRow,
  type RunningScene,
  type SceneAnswer,
} from "#src/lib/big-screen.ts";
import type { PairedView } from "#src/lib/device.ts";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { textFor } from "#src/lib/quests.ts";
import { errorCodeOf } from "#src/lib/sign-in-errors.ts";
import styles from "#src/components/device.module.css";

type Translate = ReturnType<typeof translatorFor>;
type Answers = Readonly<Partial<Record<RunningScene, SceneAnswer>>>;

const SCENE_TITLES: Readonly<Record<RunningScene, MessageKey>> = {
  ranking: "screen.ranking.title",
  community: "screen.community.title",
  poll: "screen.poll.title",
  photo: "screen.photo.title",
  finale: "screen.finale.title",
  cheers: "screen.cheers.title",
};

/**
 * Reads the open scene every 3 seconds (6 after a 429) and keeps the last answer of each scene, so a scene comes back
 * showing what it showed while its fresh read is on the way. A 401 hands back to pairing.
 */
function useSceneAnswers(open: RunningScene | undefined, restart: () => void): Answers {
  const [answers, setAnswers] = useState<Answers>({});
  useEffect(() => {
    if (open === undefined) {
      return undefined;
    }
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const read = await requestJson("GET", `/v1/device/screen/${open}`);
      if (stopped) {
        return;
      }
      const code = errorCodeOf(read.body);
      if (code === "device_unpaired") {
        restart();
        return;
      }
      const answer = read.ok ? sceneAnswerOf(open, read.body) : undefined;
      if (answer !== undefined) {
        setAnswers((before) => ({ ...before, [open]: answer }));
      }
      timer = setTimeout(
        () => void load(),
        code === "too_many_attempts" ? SLOWED_MS : SCENE_POLL_MS,
      );
    };
    void load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [open, restart]);
  return answers;
}

/**
 * The scene that is up and its latest answer. The first picked scene opens; every 15 seconds the next one in the picked
 * order takes over, passing by one found empty in the last 20 seconds (no community goal running, no poll sent). A scene
 * found empty while it is up is left after a second when another has something to show.
 */
function useBigScreen(scenes: readonly RunningScene[], restart: () => void) {
  const [current, setCurrent] = useState<RunningScene | undefined>(scenes[0]);
  const open = current !== undefined && scenes.includes(current) ? current : scenes[0];
  const answers = useSceneAnswers(open, restart);
  const known = useRef<Partial<Record<RunningScene, Known>>>({});
  const answer = open === undefined ? undefined : answers[open];
  const emptyHere = answer !== undefined && isEmpty(answer);
  useEffect(() => {
    if (open !== undefined && answer !== undefined) {
      known.current[open] = { empty: isEmpty(answer), at: Date.now() };
    }
  }, [open, answer]);
  useEffect(() => {
    if (open === undefined || scenes.length < 2) {
      return undefined;
    }
    const wait = emptyHere ? EMPTY_SKIP_MS : SCENE_MS;
    const timer = setTimeout(
      () => setCurrent(nextScene(scenes, open, known.current, Date.now())),
      wait,
    );
    return () => clearTimeout(timer);
  }, [scenes, open, emptyHere]);
  return { open, answer };
}

function RankingScene({
  rows,
  names,
  terms,
  language,
  t,
}: Readonly<{
  rows: readonly RankingRow[];
  names: NameDisplay;
  terms: EventTerms;
  language: Language;
  t: Translate;
}>) {
  if (rows.length === 0) {
    return <p className={styles.message}>{t("screen.ranking.empty")}</p>;
  }
  return (
    <ol className={styles.board}>
      {rows.map((row) => (
        <li
          key={row.place}
          className={`${styles.boardRow} ${row.place === 1 ? styles.boardLeader : ""}`}
        >
          <span className={styles.boardPlace}>{formatNumber(row.place, language)}</span>
          <Avatar row={row} />
          <span className={styles.boardName} dir="auto">
            <ScreenName username={row.username} fullName={row.fullName} names={names} />
          </span>
          {row.score === null ? null : (
            <span className={styles.boardScore}>
              {t("screen.score", {
                score: formatNumber(row.score, language),
                currency: termFor(terms.currency, language, row.score),
              })}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

function PollScene({
  poll,
  language,
  t,
}: Readonly<{ poll: PollView; language: Language; t: Translate }>) {
  const options = poll.options;
  return (
    <>
      <p className={styles.goalTitle} dir="auto">
        {textFor(poll.title, language)}
      </p>
      {options === null ? (
        <p className={styles.message}>
          {t(poll.closed ? "screen.poll.closed" : "screen.poll.open")}
        </p>
      ) : (
        options.map((option, index) => {
          const share = shareOf(option.votes, options);
          return (
            <div key={index} className={styles.pollOption}>
              <p className={styles.pollLine}>
                <span dir="auto">{textFor(option.text, language)}</span>
                <span>
                  {formatNumber(option.votes, language)} · {formatNumber(share, language)}%
                </span>
              </p>
              <div className={styles.pollTrack}>
                <div className={styles.pollFill} style={{ inlineSize: `${share}%` }} />
              </div>
            </div>
          );
        })
      )}
      {options !== null && poll.closed ? (
        <p className={styles.muted}>{t("screen.poll.final")}</p>
      ) : null}
      <p className={styles.points}>
        {t("screen.poll.voters", { count: formatNumber(poll.voters, language) })}
      </p>
    </>
  );
}

function SceneBody({
  answer,
  terms,
  language,
  t,
}: Readonly<{ answer: SceneAnswer; terms: EventTerms; language: Language; t: Translate }>) {
  switch (answer.scene) {
    case "ranking":
      return (
        <RankingScene
          rows={answer.rows}
          names={answer.names}
          terms={terms}
          language={language}
          t={t}
        />
      );
    case "finale":
    case "cheers":
      return <TimedSceneBody answer={answer} language={language} t={t} />;
    default:
      return <ContentSceneBody answer={answer} language={language} t={t} />;
  }
}

/** The scenes that show what the event made: the community goal, the live poll and the photo wall (T-504b). */
function ContentSceneBody({
  answer,
  language,
  t,
}: Readonly<{
  answer: Extract<SceneAnswer, { scene: "community" | "poll" | "photo" }>;
  language: Language;
  t: Translate;
}>) {
  switch (answer.scene) {
    case "community":
      return answer.goal === null ? null : (
        <CommunityScene goal={answer.goal} language={language} t={t} />
      );
    case "poll":
      return answer.poll === null ? null : (
        <PollScene poll={answer.poll} language={language} t={t} />
      );
    case "photo":
      return <PhotoScene photos={answer.photos} t={t} />;
  }
}

/** The scenes that run on the server's clock: the finale (T-307b) and Cheers (T-509). */
function TimedSceneBody({
  answer,
  language,
  t,
}: Readonly<{
  answer: Extract<SceneAnswer, { clockOffset: number }>;
  language: Language;
  t: Translate;
}>) {
  if (answer.scene === "finale") {
    return answer.finale === null ? null : (
      <FinaleScene
        finale={answer.finale}
        clockOffset={answer.clockOffset}
        language={language}
        t={t}
      />
    );
  }
  return answer.cheers === null ? null : (
    <CheersScene
      cheers={answer.cheers}
      clockOffset={answer.clockOffset}
      language={language}
      t={t}
    />
  );
}

/** A paired big screen that is open: the event's name on top, the open scene below, its label in a corner. */
function Scenes({
  view,
  language,
  restart,
}: Readonly<{ view: PairedView; language: Language; restart: () => void }>) {
  const t = translatorFor(language, view.terms);
  useWakeLock();
  const list = (view.scenes ?? []).join(",");
  const scenes = useMemo(() => runningOf(list === "" ? [] : list.split(",")), [list]);
  const { open, answer } = useBigScreen(scenes, restart);
  const showing = answer !== undefined && !isEmpty(answer);
  return (
    <main className={styles.stage}>
      <div className={styles.stageHead}>
        <h1 className={styles.event} dir="auto">
          {textFor(view.event.name, language)}
        </h1>
        {open === undefined || !showing ? null : (
          <h2 className={styles.sceneTitle}>{t(SCENE_TITLES[open])}</h2>
        )}
      </div>
      <div className={styles.scene} key={open}>
        {open === undefined ? null : showing ? (
          <SceneBody answer={answer} terms={view.terms} language={language} t={t} />
        ) : (
          <p className={styles.message}>{t("screen.waiting")}</p>
        )}
      </div>
      <p className={styles.corner} dir="auto">
        {view.label}
      </p>
    </main>
  );
}

/**
 * The big screen (T-504, FR-630 to FR-634): pairing first (a code, nothing of the event), then the scenes the team
 * picked, in their order. A shut screen shows the Questify mark (the event ended) or a sentence (the add-on is off).
 */
export function BigScreen({ language }: Readonly<{ language: Language }>) {
  const t = translatorFor(language);
  return (
    <DevicePairing kind="screen" language={language}>
      {(view, restart) =>
        view.shut === "event_ended" ? (
          <main className={styles.screen}>
            <h1 className={styles.mark}>Questify</h1>
          </main>
        ) : view.shut === "feature_off" ? (
          <main className={styles.screen}>
            <h1 className={styles.event} dir="auto">
              {textFor(view.event.name, language)}
            </h1>
            <p className={styles.message}>{t("screen.off")}</p>
            <p className={styles.corner} dir="auto">
              {view.label}
            </p>
          </main>
        ) : (
          <Scenes view={view} language={language} restart={restart} />
        )
      }
    </DevicePairing>
  );
}
