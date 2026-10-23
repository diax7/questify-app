"use client";

import { formatEventTime, type Language } from "@questify/shared";
import { useEffect, useState } from "react";
import { VoteCounts } from "#src/components/VoteCounts.tsx";
import { translatorFor } from "#src/lib/language.ts";
import { pollStateOf } from "#src/lib/polls.ts";
import type { QuestView } from "#src/lib/quests.ts";
import styles from "#src/components/layout.module.css";

/** How often an open poll's state and counts are read again on the quest list. */
const REFRESH_MS = 5000;

export type PollActions = Readonly<{
  sendPoll: (quest: QuestView) => void;
  closePoll: (quest: QuestView) => void;
  /** Where the quest's counts are read (the team's vote counts). */
  votesUrl: (quest: QuestView) => string;
}>;

/**
 * A live poll on the quest list (T-306, FR-239): Draft, Open (closes …) or Closed; Send now on a draft, Close now while
 * open, each asked for first by the page; and the counts, read every 5 seconds while it is open.
 */
export function PollControls({
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
  actions: PollActions;
}>) {
  const t = translatorFor(language);
  const [now, setNow] = useState(() => Date.now());
  const state = pollStateOf(quest, now);
  useEffect(() => {
    if (state !== "open") {
      return undefined;
    }
    const timer = setInterval(() => setNow(Date.now()), REFRESH_MS);
    return () => clearInterval(timer);
  }, [state]);
  if (state === null) {
    return null;
  }
  return (
    <>
      <span className={styles.badge}>
        {state === "open" && quest.closesAt !== null
          ? t("quests.poll.open", {
              time: formatEventTime(new Date(quest.closesAt), timeZone, language),
            })
          : t(state === "draft" ? "quests.poll.draft" : "quests.poll.closed")}
      </span>
      {readOnly || state === "closed" ? null : (
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.button}
            disabled={busy}
            onClick={() => (state === "draft" ? actions.sendPoll(quest) : actions.closePoll(quest))}
          >
            {t(state === "draft" ? "quests.poll.send" : "quests.poll.close")}
          </button>
        </div>
      )}
      {state === "draft" ? null : (
        <VoteCounts
          language={language}
          url={actions.votesUrl(quest)}
          {...(state === "open" ? { refreshMs: REFRESH_MS } : {})}
        />
      )}
    </>
  );
}
