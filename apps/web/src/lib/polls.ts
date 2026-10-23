import { isLivePoll, POLL_MINUTES } from "@questify/shared";

/** Where a live poll stands on the quest list (T-306): a draft, open until its close, or closed. */
export type PollState = "draft" | "open" | "closed";

/** A quest's poll state at `now`, or null when the quest is not a live poll. */
export function pollStateOf(
  quest: Readonly<{
    type: string;
    config: Readonly<Record<string, unknown>>;
    pollSentAt: string | null;
    closesAt: string | null;
  }>,
  now: number,
): PollState | null {
  if (!isLivePoll(quest.type, quest.config)) {
    return null;
  }
  if (quest.pollSentAt === null) {
    return "draft";
  }
  return quest.closesAt !== null && Date.parse(quest.closesAt) > now ? "open" : "closed";
}

/** A live poll's minutes from its config, for Send's confirmation; the default when unreadable. */
export function pollMinutesOf(config: Readonly<Record<string, unknown>>): number {
  const live = config["live"];
  const minutes =
    typeof live === "object" && live !== null ? (live as { minutes?: unknown }).minutes : undefined;
  return typeof minutes === "number" ? minutes : POLL_MINUTES.default;
}

/** The live block a vote gets when Live poll is ticked: one choice, results after voting, the default minutes. */
export const NEW_LIVE_BLOCK = {
  choices: "one",
  results: "after_vote",
  minutes: POLL_MINUTES.default,
} as const;
