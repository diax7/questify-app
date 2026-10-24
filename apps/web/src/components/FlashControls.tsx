"use client";

import { formatEventTime, type Language } from "@questify/shared";
import { useEffect, useState } from "react";
import { translatorFor } from "#src/lib/language.ts";
import { useFocusOnMount } from "#src/components/QuestBuilderParts.tsx";
import {
  FLASH_DEFAULT_MINUTES,
  FLASH_MAX_MINUTES,
  flashMinutesValid,
  flashStateOf,
} from "#src/lib/flash.ts";
import type { QuestView } from "#src/lib/quests.ts";
import styles from "#src/components/layout.module.css";

/** How often a flash quest's state is read against the clock on the quest list. */
const TICK_MS = 5000;

export type FlashActions = Readonly<{
  launchFlash: (quest: QuestView) => void;
  endFlash: (quest: QuestView) => void;
}>;

const LABEL = {
  draft: "quests.flash.draft",
  scheduled: "quests.flash.scheduled",
  running: "quests.flash.running",
  ended: "quests.flash.ended",
} as const;

/**
 * A flash quest on the quest list (T-307, FR-251): not launched, starts …, ends … or ended; Launch now on a draft and
 * End now while it runs, each asked for first by the page (as a live poll's Send and Close).
 */
export function FlashControls({
  language,
  timeZone,
  quest,
  busy,
  readOnly,
  actions,
}: Readonly<{
  language: Language;
  timeZone: string;
  quest: QuestView;
  busy: boolean;
  readOnly: boolean;
  actions: FlashActions;
}>) {
  const t = translatorFor(language);
  const [, setTick] = useState(0);
  const state = flashStateOf({ ...quest, flash: quest.flash === true }, Date.now());
  useEffect(() => {
    if (state !== "running" && state !== "scheduled") {
      return undefined;
    }
    const timer = setInterval(() => setTick((tick) => tick + 1), TICK_MS);
    return () => clearInterval(timer);
  }, [state]);
  if (state === null) {
    return null;
  }
  const at = state === "scheduled" ? quest.opensAt : quest.closesAt;
  const time = at === null ? "" : formatEventTime(new Date(at), timeZone, language);
  return (
    <>
      <span className={styles.badge}>{t(LABEL[state], { time })}</span>
      {readOnly || (state !== "draft" && state !== "running") ? null : (
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.button}
            disabled={busy}
            onClick={() =>
              state === "draft" ? actions.launchFlash(quest) : actions.endFlash(quest)
            }
          >
            {t(state === "draft" ? "quests.flash.launch" : "quests.flash.end")}
          </button>
        </div>
      )}
    </>
  );
}

/**
 * Launch's confirmation (T-307): what happens, the minutes (1 to 1,440, starting at 15), Cancel and Launch now. Escape
 * cancels; the heading takes focus when it opens.
 */
export function FlashLaunchDialog({
  language,
  busy,
  cancel,
  confirm,
}: Readonly<{
  language: Language;
  busy: boolean;
  cancel: () => void;
  confirm: (minutes: number) => void;
}>) {
  const t = translatorFor(language);
  const heading = useFocusOnMount<HTMLHeadingElement>();
  const [minutes, setMinutes] = useState(FLASH_DEFAULT_MINUTES);
  const valid = flashMinutesValid(minutes);
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="flash-title"
      aria-describedby="flash-body"
      className={styles.card}
      onKeyDown={(pressed) => {
        if (pressed.key === "Escape" && !busy) {
          cancel();
        }
      }}
    >
      <h2 id="flash-title" ref={heading} tabIndex={-1} className={styles.subtitle}>
        {t("quests.flash.launchTitle")}
      </h2>
      <p id="flash-body">{t("quests.flash.launchBody")}</p>
      <label className={styles.field}>
        {t("quests.flash.minutes")}
        <input
          className={styles.input}
          type="number"
          dir="ltr"
          min={1}
          max={FLASH_MAX_MINUTES}
          value={minutes}
          disabled={busy}
          aria-invalid={!valid}
          onChange={(event) => setMinutes(Number(event.target.value))}
        />
      </label>
      <div className={styles.actions}>
        <button type="button" className={styles.quiet} disabled={busy} onClick={cancel}>
          {t("common.cancel")}
        </button>
        <button
          type="button"
          className={styles.button}
          disabled={busy || !valid}
          onClick={() => confirm(minutes)}
        >
          {t("quests.flash.launch")}
        </button>
      </div>
    </div>
  );
}
