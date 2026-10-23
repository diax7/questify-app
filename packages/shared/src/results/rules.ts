import type { Language } from "#src/i18n/digits";
import { MESSAGES, type MessageKey } from "#src/i18n/messages";
import { interpolate } from "#src/i18n/placeholders";
import { formatEventTime } from "#src/time/event-time";

/** One rank prize as the rules list it. */
export type RulesPrize = Readonly<{
  rankFrom: number;
  rankTo: number;
  name: Readonly<{ ar: string | null; en: string | null }>;
}>;

/** What an event's official rules are built from (migration 0034, `rules_of`). */
export type RulesData = Readonly<{
  rankPrizes: boolean;
  prizes: readonly RulesPrize[];
  organizer: string;
  endsAt: Date;
  timezone: string;
  /** The claim deadline the owner set at the reveal; null before it. */
  claimUntil: Date | null;
  text: Readonly<{ ar: string | null; en: string | null }>;
}>;

/** An event's official rules in both languages: the fixed block (null without prizes), then the organizer's text. */
export type OfficialRules = Readonly<{
  block: Readonly<Record<Language, readonly string[]>> | null;
  text: Readonly<{ ar: string | null; en: string | null }>;
}>;

const say = (key: MessageKey, language: Language, values: Record<string, string> = {}): string =>
  interpolate(MESSAGES[key][language], values, language);

const nameIn = (name: RulesPrize["name"], language: Language): string =>
  name[language] ?? name[language === "ar" ? "en" : "ar"] ?? "";

function prizeLine(prize: RulesPrize, language: Language): string {
  const name = nameIn(prize.name, language);
  return prize.rankFrom === prize.rankTo
    ? say("rules.prizeOne", language, { rank: String(prize.rankFrom), prize: name })
    : say("rules.prizeRange", language, {
        from: String(prize.rankFrom),
        to: String(prize.rankTo),
        prize: name,
      });
}

function blockIn(data: RulesData, language: Language): string[] {
  const winners = data.prizes.reduce((sum, prize) => sum + prize.rankTo - prize.rankFrom + 1, 0);
  const claim =
    data.claimUntil === null
      ? say("rules.claimLater", language)
      : say("rules.claimBy", language, {
          deadline: formatEventTime(data.claimUntil, data.timezone, language),
        });
  return [
    say("rules.administrator", language, { organizer: data.organizer }),
    say("rules.notSponsors", language),
    say("rules.free", language),
    say("rules.howWinners", language),
    say("rules.winnerCount", language, { count: String(winners) }),
    ...data.prizes.map((prize) => prizeLine(prize, language)),
    say("rules.ends", language, {
      time: formatEventTime(data.endsAt, data.timezone, language),
    }),
    claim,
  ];
}

/**
 * The official rules of an event with rank prizes (STORE_COMPLIANCE §1.12, ADR-165): a fixed block written from the
 * event's data that no organizer can edit (who runs the contest and who gives the prizes, that Apple and Google are
 * not involved, how winners are picked, the prizes, the end and the claim deadline), then the organizer's own text.
 * The block is null while prizes are off or none are set; the whole answer is null when there is nothing to show.
 */
export function officialRules(data: RulesData): OfficialRules | null {
  const hasBlock = data.rankPrizes && data.prizes.length > 0;
  if (!hasBlock && data.text.ar === null && data.text.en === null) {
    return null;
  }
  return {
    block: hasBlock ? { ar: blockIn(data, "ar"), en: blockIn(data, "en") } : null,
    text: data.text,
  };
}
