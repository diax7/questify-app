"use client";

import { formatEventTime, type Language } from "@questify/shared";
import { useEffect, useState } from "react";
import { VoteCounts } from "#src/components/VoteCounts.tsx";
import { translatorFor } from "#src/lib/language.ts";
import { pollStateOf } from "#src/lib/polls.ts";
import type { QuestView } from "#src/lib/quests.ts";
import { Button } from "#src/ui/Button.tsx";
import { Badge } from "#src/ui/Feedback.tsx";
import { Toolbar } from "#src/ui/Section.tsx";

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
  // Read against the clock at every render, so a reload after Close shows Closed at once; the timer only makes an
  // open poll render again when its time runs out on its own.
  const [, setTick] = useState(0);
  const state = pollStateOf(quest, Date.now());
  useEffect(() => {
    if (state !== "open") {
      return undefined;
    }
    const timer = setInterval(() => setTick((tick) => tick + 1), REFRESH_MS);
    return () => clearInterval(timer);
  }, [state]);
  if (state === null) {
    return null;
  }
  return (
    <>
      <Badge>
        {state === "open" && quest.closesAt !== null
          ? t("quests.poll.open", {
              time: formatEventTime(new Date(quest.closesAt), timeZone, language),
            })
          : t(state === "draft" ? "quests.poll.draft" : "quests.poll.closed")}
      </Badge>
      {readOnly || state === "closed" ? null : (
        <Toolbar>
          <Button
            variant="secondary"

            disabled={busy}
            onClick={() => (state === "draft" ? actions.sendPoll(quest) : actions.closePoll(quest))}
          >
            {t(state === "draft" ? "quests.poll.send" : "quests.poll.close")}
          </Button>
        </Toolbar>
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
