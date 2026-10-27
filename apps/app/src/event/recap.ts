import { formatLocalDate, formatNumber, type EventRecap, type Language } from "@questify/shared";
import { textIn } from "#src/i18n/text.ts";
import type { Translate } from "#src/i18n/words.ts";

/** How many souvenirs the card names; the rest show as "+N" (ADR-339). */
export const SOUVENIRS_ON_CARD = 3;

/** A left-to-right mark, so "+2" keeps its sign in front of the number inside an Arabic line. */
const LTR_MARK = "‎";

/** Everything the recap card writes, in the screen's language. */
export type RecapView = Readonly<{
  title: string;
  /** The local start date, and the city when the event has one. */
  where: string;
  /** The final place, or the words that it comes with the results; null when the member has no place. */
  rank: Readonly<{ kind: "final" | "pending"; text: string }> | null;
  /** The count of quests done, or "Thanks for joining" when there are none. */
  quests: string;
  /** Up to three souvenir names and "+N" for the rest; null when the event gave none. */
  souvenirs: Readonly<{ heading: string; names: readonly string[]; more: string | null }> | null;
  /** The card read as one line for a screen reader. */
  summary: string;
}>;

function rankOf(recap: EventRecap, language: Language, t: Translate): RecapView["rank"] {
  switch (recap.rank.state) {
    case "final":
      return {
        kind: "final",
        text: t("recap.rank", { rank: formatNumber(recap.rank.value, language) }),
      };
    case "pending":
      return { kind: "pending", text: t("recap.rankPending") };
    case "unranked":
      return null;
  }
}

function souvenirsOf(recap: EventRecap, language: Language, t: Translate): RecapView["souvenirs"] {
  if (recap.souvenirs.length === 0) {
    return null;
  }
  const extra = recap.souvenirs.length - SOUVENIRS_ON_CARD;
  return {
    heading: t("recap.souvenirs"),
    names: recap.souvenirs.slice(0, SOUVENIRS_ON_CARD).map((item) => item.name[language]),
    more:
      extra > 0 ? `${LTR_MARK}${t("recap.more", { count: formatNumber(extra, language) })}` : null,
  };
}

function spokenSouvenirs(souvenirs: NonNullable<RecapView["souvenirs"]>): string {
  const more = souvenirs.more === null ? [] : [souvenirs.more];
  return [souvenirs.heading, ...souvenirs.names, ...more].join(" ");
}

/**
 * The recap card's lines (FR-752, ADR-339): the event's name, date and city, the rank by the passport's rule, the
 * quests done or a thank-you for none, and the souvenirs. Nothing else is on it: no username, score or balance.
 */
export function recapView(recap: EventRecap, language: Language, t: Translate): RecapView {
  const title = textIn(recap.event.name, language);
  const city = recap.event.city === null ? "" : textIn(recap.event.city, language);
  const date = formatLocalDate(recap.event.date, language);
  const quests =
    recap.questsDone === 0
      ? t("recap.thanks")
      : t("recap.quests", { count: formatNumber(recap.questsDone, language) });
  const rank = rankOf(recap, language, t);
  const souvenirs = souvenirsOf(recap, language, t);
  const spoken = [
    title,
    city === "" ? date : `${date}, ${city}`,
    rank?.text,
    quests,
    souvenirs === null ? undefined : spokenSouvenirs(souvenirs),
  ];
  return {
    title,
    where: city === "" ? date : `${date} · ${city}`,
    rank,
    quests,
    souvenirs,
    summary: spoken.filter((line) => line !== undefined && line !== "").join(". "),
  };
}

/** The one fixed line a text share sends when the image cannot be made: no link, no number (ADR-339). */
export const recapShareText = (recap: EventRecap, language: Language, t: Translate): string =>
  t("recap.shareText", { event: textIn(recap.event.name, language) });
