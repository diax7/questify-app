"use client";

import type { Language } from "@questify/shared";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { QrImage } from "#src/components/CodesPanel.tsx";
import {
  deviceAnswerOf,
  deviceKindKey,
  devicePagePath,
  pairUrl,
  pollDelayMs,
  type DeviceAnswer,
  type DeviceKind,
  type PairedView,
} from "#src/lib/device.ts";
import { translatorFor } from "#src/lib/language.ts";
import { requestJson } from "#src/lib/post-json.ts";
import { errorCodeOf } from "#src/lib/sign-in-errors.ts";
import styles from "#src/components/device.module.css";

/** What the page shows while it is not yet a paired device of its kind. */
type Phase =
  | Readonly<{ kind: "starting" }>
  | Readonly<{ kind: "pending"; code: string | null; expiresAt: string }>
  | Readonly<{ kind: "busy" }>
  | Readonly<{ kind: "paired"; view: PairedView }>;

type Step = Readonly<{ phase: Phase; slowed: boolean }>;

/** Asks the API to start pairing this browser (the cookie is set by the answer), or reads the state it already has. */
async function startPairing(kind: DeviceKind): Promise<Step> {
  const made = await requestJson("POST", "/v1/device/pairing", { kind });
  const answer = deviceAnswerOf(made.body);
  if (!made.ok || answer === undefined) {
    return { phase: { kind: "busy" }, slowed: errorCodeOf(made.body) === "too_many_attempts" };
  }
  return settle(answer);
}

/** Turns an answer into the next phase: a pending page without its code renews it; a paired one activates. */
async function settle(answer: DeviceAnswer): Promise<Step> {
  if (answer.state === "pending") {
    if (answer.code !== null) {
      return {
        phase: { kind: "pending", code: answer.code, expiresAt: answer.expiresAt },
        slowed: false,
      };
    }
    const renewed = deviceAnswerOf(
      (await requestJson("POST", "/v1/device/pairing/renew", {})).body,
    );
    return renewed?.state === "pending"
      ? {
          phase: { kind: "pending", code: renewed.code, expiresAt: renewed.expiresAt },
          slowed: false,
        }
      : { phase: { kind: "starting" }, slowed: false };
  }
  if (answer.state === "waiting") {
    // Paired: the secret this browser held while it waited is replaced before anything of the event is shown.
    await requestJson("POST", "/v1/device/activate", {});
    return { phase: { kind: "starting" }, slowed: false };
  }
  return { phase: { kind: "paired", view: answer.view }, slowed: false };
}

/** One poll: the device's state, a fresh start when it is not (or no longer) paired. */
async function poll(kind: DeviceKind, current: Phase): Promise<Step> {
  const read = await requestJson("GET", "/v1/device");
  const code = errorCodeOf(read.body);
  if (code === "device_unpaired") {
    return startPairing(kind);
  }
  if (code === "too_many_attempts") {
    return { phase: current, slowed: true };
  }
  const answer = deviceAnswerOf(read.body);
  if (!read.ok || answer === undefined) {
    return { phase: current, slowed: false };
  }
  if (answer.state === "pending" && current.kind === "pending" && current.code !== null) {
    const expired = Date.parse(answer.expiresAt) <= Date.now() + 1000;
    return expired ? settle({ ...answer, code: null }) : { phase: current, slowed: false };
  }
  return settle(answer);
}

/**
 * The pairing every station, kiosk and big-screen page shares (T-309, ADR-239): it asks for a code, shows it as text
 * and as a QR for staff mode, polls every 3 seconds (5 after a 429), renews an expired code under the same cookie,
 * activates once paired, and hands the paired view to `children`. It shows nothing of any event before that. A device
 * that stops being paired (revoked, ended) drops everything and starts over.
 */
export function DevicePairing({
  kind,
  language,
  children,
}: Readonly<{
  kind: DeviceKind;
  language: Language;
  children: (view: PairedView, restart: () => void) => ReactNode;
}>) {
  const t = translatorFor(language);
  const [phase, setPhase] = useState<Phase>({ kind: "starting" });
  const latest = useRef<Phase>(phase);
  const [tick, setTick] = useState(0);
  const restart = useCallback(() => {
    latest.current = { kind: "starting" };
    setPhase(latest.current);
    setTick((value) => value + 1);
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async (first: boolean) => {
      const step = first
        ? await poll(kind, { kind: "starting" })
        : await poll(kind, latest.current);
      if (stopped) {
        return;
      }
      latest.current = step.phase;
      setPhase(step.phase);
      timer = setTimeout(
        () => void run(false),
        step.phase.kind === "starting" ? 300 : pollDelayMs(step.slowed),
      );
    };
    void run(true);
    return () => {
      stopped = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, [kind, tick]);

  if (phase.kind === "paired") {
    if (phase.view.kind !== kind) {
      return (
        <main className={styles.screen}>
          <p className={styles.message}>
            {t("device.pair.otherKind", { kind: t(deviceKindKey(phase.view.kind)) })}
          </p>
          <a className={styles.muted} href={devicePagePath(phase.view.kind, language)}>
            {t("device.pair.openOther")}
          </a>
        </main>
      );
    }
    return <>{children(phase.view, restart)}</>;
  }
  return <PairingCode kind={kind} language={language} phase={phase} />;
}

/** The waiting page: the kind, the code in big type and as a QR, and what to do. Never anything of an event. */
function PairingCode({
  kind,
  language,
  phase,
}: Readonly<{ kind: DeviceKind; language: Language; phase: Exclude<Phase, { kind: "paired" }> }>) {
  const t = translatorFor(language);
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  const code = phase.kind === "pending" ? phase.code : null;
  return (
    <main className={styles.screen}>
      <p className={styles.event}>{t(deviceKindKey(kind))}</p>
      {code === null ? (
        <p className={styles.message} role="status">
          {t(phase.kind === "busy" ? "device.pair.busy" : "device.pair.starting")}
        </p>
      ) : (
        <>
          <p className={styles.message}>{t("device.pair.waiting")}</p>
          <div className={styles.codeBox}>
            <p className={styles.pairCode} dir="ltr" aria-label={code.split("").join(" ")}>
              {code}
            </p>
            {origin === "" ? null : (
              <QrImage text={pairUrl(origin, language, code)} label={t("device.pair.scanHint")} />
            )}
          </div>
          <p className={styles.muted}>{t("device.pair.howTo")}</p>
          <p className={styles.muted}>{t("device.pair.scanHint")}</p>
        </>
      )}
      <p className={styles.mark}>Questify</p>
    </main>
  );
}
