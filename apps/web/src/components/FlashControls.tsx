"use client";

import { formatEventTime, type Language } from "@questify/shared";
import { useEffect, useState } from "react";
import { useTranslator } from "#src/components/TermsScope.tsx";
import {
  FLASH_DEFAULT_MINUTES,
  FLASH_MAX_MINUTES,
  flashMinutesValid,
  flashStateOf,
} from "#src/lib/flash.ts";
import type { QuestView } from "#src/lib/quests.ts";
import { Button } from "#src/ui/Button.tsx";
import { Badge } from "#src/ui/Feedback.tsx";
import { Field, Input } from "#src/ui/Field.tsx";
import { Dialog } from "#src/ui/Dialog.tsx";
import { Toolbar } from "#src/ui/Section.tsx";

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
  const t = useTranslator(language);
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
      <Badge>{t(LABEL[state], { time })}</Badge>
      {readOnly || (state !== "draft" && state !== "running") ? null : (
        <Toolbar>
          <Button
            variant="secondary"

            disabled={busy}
            onClick={() =>
              state === "draft" ? actions.launchFlash(quest) : actions.endFlash(quest)
            }
          >
            {t(state === "draft" ? "quests.flash.launch" : "quests.flash.end")}
          </Button>
        </Toolbar>
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
  const t = useTranslator(language);
  const [minutes, setMinutes] = useState(FLASH_DEFAULT_MINUTES);
  const valid = flashMinutesValid(minutes);
  return (
    <Dialog
      titleId="flash-title"
      describedById="flash-body"
      title={t("quests.flash.launchTitle")}
      busy={busy}
      cancel={cancel}
      actions={
        <>
          <Button variant="secondary" disabled={busy} onClick={cancel}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" disabled={busy || !valid} onClick={() => confirm(minutes)}>
            {t("quests.flash.launch")}
          </Button>
        </>
      }
    >
      <p id="flash-body">{t("quests.flash.launchBody")}</p>
      <Field label={t("quests.flash.minutes")}>
        <Input
          type="number"
          dir="ltr"
          min={1}
          max={FLASH_MAX_MINUTES}
          value={minutes}
          disabled={busy}
          aria-invalid={!valid}
          onChange={(event) => setMinutes(Number(event.target.value))}
        />
      </Field>
    </Dialog>
  );
}
