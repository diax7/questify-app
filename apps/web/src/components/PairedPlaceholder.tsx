"use client";

import type { Language } from "@questify/shared";
import { DevicePairing } from "#src/components/DevicePairing.tsx";
import type { DeviceKind } from "#src/lib/device.ts";
import { translatorFor } from "#src/lib/language.ts";
import { textFor } from "#src/lib/quests.ts";
import styles from "#src/components/device.module.css";

const READY = { screen: "screen.ready", kiosk: "kiosk.ready" } as const;

/**
 * The big-screen page up to "paired" (T-309, ADR-241) and the kiosk page's pairing (its scanner is T-309b): pairing,
 * then the event's name and the label, and nothing read from the ranking or any player. T-504 replaces the big screen's
 * paired state with its scenes; T-309b the kiosk's.
 */
export function PairedPlaceholder({
  kind,
  language,
}: Readonly<{ kind: Exclude<DeviceKind, "station">; language: Language }>) {
  const t = translatorFor(language);
  return (
    <DevicePairing kind={kind} language={language}>
      {(view) =>
        view.shut === "event_ended" ? (
          <main className={styles.screen}>
            <p className={styles.mark}>Questify</p>
          </main>
        ) : (
          <main className={styles.screen}>
            <p className={styles.title} dir="auto">
              {t("device.paired", { event: textFor(view.event.name, language) })}
            </p>
            <p className={styles.message}>{t(READY[kind])}</p>
            <p className={styles.corner} dir="auto">
              {view.label}
            </p>
          </main>
        )
      }
    </DevicePairing>
  );
}
