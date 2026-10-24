"use client";

import { formatNumber, type Language } from "@questify/shared";
import { useEffect, useState } from "react";
import { DevicePairing } from "#src/components/DevicePairing.tsx";
import {
  codeGraceMs,
  nextCodeDelayMs,
  screenCodeOf,
  shutKey,
  type PairedView,
  type ScreenCodeView,
} from "#src/lib/device.ts";
import { qrDrawing } from "#src/lib/qr.ts";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { textFor } from "#src/lib/quests.ts";
import { errorCodeOf } from "#src/lib/sign-in-errors.ts";
import styles from "#src/components/device.module.css";

/** What the station shows now: a code (with when it was fetched), a shut reason, or why there is no code. */
type Shown =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "code"; code: Extract<ScreenCodeView, { state: "open" }>; at: number }>
  | Readonly<{ kind: "shut"; shut: string }>
  | Readonly<{ kind: "reconnecting" }>
  | Readonly<{ kind: "off" }>;

const RETRY_MS = 3000;

/** Asks the screen to stay on where the browser can (Screen Wake Lock); a refusal changes nothing. */
function useWakeLock(): void {
  useEffect(() => {
    let lock: { release: () => Promise<void> } | undefined;
    const ask = () => {
      const wake = (
        navigator as { wakeLock?: { request: (type: "screen") => Promise<typeof lock> } }
      ).wakeLock;
      void wake
        ?.request("screen")
        .then((granted) => {
          lock = granted;
        })
        .catch(() => undefined);
    };
    ask();
    document.addEventListener("visibilitychange", ask);
    return () => {
      document.removeEventListener("visibilitychange", ask);
      void lock?.release().catch(() => undefined);
    };
  }, []);
}

/**
 * The code loop (FR-314): fetch, show, and fetch again when it changes (plus jitter), timed from each answer and never
 * from this screen's clock. Offline or on an error the current code stays only until its grace ends, then
 * "Reconnecting…" and no code (never a dead one). A 401 hands back to pairing.
 */
function useScreenCode(restart: () => void): Shown {
  const [shown, setShown] = useState<Shown>({ kind: "loading" });
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let held: Extract<Shown, { kind: "code" }> | undefined;
    const later = (ms: number) => {
      timer = setTimeout(() => void fetchCode(), ms);
    };
    const fetchCode = async () => {
      const read = await requestJson("GET", "/v1/device/screen-code");
      if (stopped) {
        return;
      }
      const code = errorCodeOf(read.body);
      if (code === "device_unpaired") {
        restart();
        return;
      }
      if (code === "feature_off") {
        setShown({ kind: "off" });
        later(RETRY_MS * 10);
        return;
      }
      const answer = read.ok ? screenCodeOf(read.body) : undefined;
      if (answer === undefined) {
        const alive =
          held !== undefined && Date.now() - held.at < codeGraceMs(held.code.changesInMs);
        setShown(alive && held !== undefined ? held : { kind: "reconnecting" });
        later(RETRY_MS);
        return;
      }
      if (answer.state === "shut") {
        held = undefined;
        setShown({ kind: "shut", shut: answer.shut });
        later(RETRY_MS);
        return;
      }
      held = { kind: "code", code: answer, at: Date.now() };
      setShown(held);
      later(nextCodeDelayMs(answer.changesInMs, Math.random()));
    };
    void fetchCode();
    return () => {
      stopped = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, [restart]);
  return shown;
}

/** The big code with its emptying bar, keyed by the code so each new one starts a full bar. */
function BigCode({ url, ms, label }: Readonly<{ url: string; ms: number; label: string }>) {
  const { size, path } = qrDrawing(url);
  return (
    <div className={styles.codeBox}>
      <svg
        className={styles.code}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={label}
        shapeRendering="crispEdges"
      >
        <rect width={size} height={size} fill="white" />
        <path d={path} fill="black" />
      </svg>
      <div className={styles.bar} aria-hidden="true">
        <div key={url} className={styles.barFill} style={{ animationDuration: `${ms}ms` }} />
      </div>
    </div>
  );
}

function Station({
  view,
  language,
  restart,
}: Readonly<{ view: PairedView; language: Language; restart: () => void }>) {
  const t = translatorFor(language);
  useWakeLock();
  const shown = useScreenCode(restart);
  const shut = view.shut ?? (shown.kind === "shut" ? shown.shut : null);
  const quest = view.quest;
  if (shut === "event_ended") {
    return (
      <main className={styles.screen}>
        <p className={styles.mark}>Questify</p>
      </main>
    );
  }
  return (
    <main className={styles.screen}>
      <p className={styles.event} dir="auto">
        {textFor(view.event.name, language)}
      </p>
      {quest === null ? null : (
        <>
          <h1 className={styles.title} dir="auto">
            {textFor(quest.title, language)}
          </h1>
          <p className={styles.points}>
            {t("station.points", { points: formatNumber(quest.points, language) })}
          </p>
        </>
      )}
      {shut !== null ? (
        <p className={styles.message} role="status">
          {t(shutKey(shut))}
        </p>
      ) : shown.kind === "code" ? (
        <>
          <BigCode url={shown.code.url} ms={shown.code.changesInMs} label={t("station.scan")} />
          <p className={styles.muted}>{t("station.scan")}</p>
        </>
      ) : shown.kind === "off" ? (
        <p className={styles.message} role="status">
          {t("device.notAvailable")}
        </p>
      ) : (
        <p className={styles.message} role="status">
          {t(shown.kind === "reconnecting" ? "device.reconnecting" : "device.pair.starting")}
        </p>
      )}
      <p className={styles.corner} dir="auto">
        {view.label}
      </p>
    </main>
  );
}

/** The station page (T-309, FR-314): pairing first, then the quest's rotating code in big type for a TV or tablet. */
export function StationScreen({ language }: Readonly<{ language: Language }>) {
  return (
    <DevicePairing kind="station" language={language}>
      {(view, restart) => <Station view={view} language={language} restart={restart} />}
    </DevicePairing>
  );
}
