import type { DailyChallenge, DailyWordGame, MessageKey } from "@questify/shared";
import { MAX_ATTEMPTS } from "#src/daily/daily-state.ts";
import type { Translate } from "#src/i18n/words.ts";

const DAY_MS = 86_400_000;
/** Riyadh is UTC+3 all year and the Questify day starts at 04:00 (ADR-307). */
const QUESTIFY_DAY_SHIFT_MS = (3 - 4) * 3_600_000;

/** The Questify day (`YYYY-MM-DD`) at this moment; only for wording, the server decides what counts. */
export const questifyDayOf = (now: Date): string =>
  new Date(now.getTime() + QUESTIFY_DAY_SHIFT_MS).toISOString().slice(0, 10);

const WEEKDAYS: readonly MessageKey[] = [
  "events.streak.sunday",
  "events.streak.monday",
  "events.streak.tuesday",
  "events.streak.wednesday",
  "events.streak.thursday",
  "events.streak.friday",
  "events.streak.saturday",
];

const dayNumber = (day: string): number => Date.parse(`${day}T00:00:00Z`) / DAY_MS;

type GameKind = "challenge" | "word";
const NEXT: Readonly<
  Record<GameKind, Readonly<{ tomorrow: MessageKey; on: MessageKey; nextWeek: MessageKey }>>
> = {
  challenge: {
    tomorrow: "daily.challenge.nextTomorrow",
    on: "daily.challenge.nextOn",
    nextWeek: "daily.challenge.nextOnNextWeek",
  },
  word: {
    tomorrow: "daily.word.nextTomorrow",
    on: "daily.word.nextOn",
    nextWeek: "daily.word.nextOnNextWeek",
  },
};

/**
 * When the next one comes: a date, never a timer (ADR-300). The next period starts the day after this one ends:
 * "tomorrow", else the weekday ("on Sunday", or "next Sunday" when that is the weekday of today).
 */
export function nextLine(
  kind: GameKind,
  period: Readonly<{ endsOn: string }>,
  now: Date,
  t: Translate,
): string {
  const next = dayNumber(period.endsOn) + 1;
  const away = next - dayNumber(questifyDayOf(now));
  const keys = NEXT[kind];
  if (away <= 1) return t(keys.tomorrow);
  const weekday = t(WEEKDAYS[new Date(next * DAY_MS).getUTCDay()] ?? "events.streak.sunday");
  return t(away >= 7 ? keys.nextWeek : keys.on, { weekday });
}

/** The challenge card's one line: where the player is in it. */
export function challengeCardLine(challenge: DailyChallenge, t: Translate): string {
  const total = challenge.questions.length;
  if (challenge.finished !== null) {
    return t("daily.challenge.cardDone", {
      correct: challenge.finished.correct,
      total,
      xp: challenge.finished.xp,
    });
  }
  const answered = challenge.questions.filter((question) => question.answered !== null).length;
  return answered === 0
    ? t("daily.challenge.cardNew")
    : t("daily.challenge.cardProgress", { answered, total });
}

/** The word card's one line: new, under way, or how it ended. */
export function wordCardLine(game: DailyWordGame, t: Translate): string {
  const play = game.play;
  if (play === null) return t("daily.word.cardNew");
  if (play.finished === null) {
    return t("daily.word.cardProgress", { used: play.guesses.length, total: MAX_ATTEMPTS });
  }
  return play.finished.solved
    ? t("daily.word.cardSolved", { attempts: play.finished.attempts, xp: play.finished.xp })
    : t("daily.word.cardMissed");
}
