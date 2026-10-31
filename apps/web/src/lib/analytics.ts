import type { Language, Participation, QuestsAnalytics } from "@questify/shared";
import type { Bilingual } from "#src/lib/quests.ts";

/** How many rows a panel lists before "View more" opens the rest (every list panel keeps one size). */
export const PANEL_ROWS = 5;

/** A whole percent of `part` in `whole`, never over 100; null when there is no whole to take it of. */
export function percentOf(part: number, whole: number): number | null {
  return whole <= 0 ? null : Math.min(100, Math.max(0, Math.round((part * 100) / whole)));
}

export type SourceKey = "code" | "qr" | "link" | "publicList" | "invite" | "other";

/**
 * The six rows of "Joined by" (FR-1202): the five join sources, then everything else (added by staff, rehearsal accounts,
 * enrollments older than the join source) in one row, so the rows always add up to the players joined.
 */
export function sourceRows(
  sources: Participation["sources"],
): readonly Readonly<{ key: SourceKey; count: number }>[] {
  return [
    { key: "code", count: sources.code },
    { key: "qr", count: sources.qr },
    { key: "link", count: sources.link },
    { key: "publicList", count: sources.public_list },
    { key: "invite", count: sources.invite },
    { key: "other", count: sources.operator + sources.rehearsal + sources.other },
  ];
}

type Category = QuestsAnalytics["categories"][number];

/** One step of a category's funnel (FR-1204). */
export type FunnelStep = Readonly<{
  id: string;
  title: Bilingual;
  /** Players who completed the step. */
  done: number;
  /** The share of the players joined, as a whole percent. */
  percent: number | null;
  /** Players who completed the step before and stopped there; null for the first step and for an unordered category. */
  lost: number | null;
  lostPercent: number | null;
  skipped: boolean;
  /** The step with the largest drop of its category (the first one on a tie); none when nobody stopped. */
  largest: boolean;
}>;

/**
 * The funnel of a category: its steps in the builder's order with how many players completed each. A category in
 * order also gets each step's drop from the step before it, a skipped step being passed over (players move on without
 * it) and a flash quest or live poll left out (they take no part in the order). Where nobody was lost there is no
 * largest drop.
 */
export function funnelOf(category: Category, joined: number): readonly FunnelStep[] {
  const steps = category.quests.filter((quest) => quest.step);
  let before: number | undefined;
  const made = steps.map((step): FunnelStep => {
    const counted = category.inOrder && !step.skipped;
    const lost =
      category.inOrder && before !== undefined && !step.skipped
        ? Math.max(0, before - step.done)
        : null;
    const lostPercent = lost === null || before === undefined ? null : percentOf(lost, before);
    if (counted) {
      before = step.done;
    }
    return {
      id: step.id,
      title: step.title,
      done: step.done,
      percent: percentOf(step.done, joined),
      lost,
      lostPercent,
      skipped: step.skipped,
      largest: false,
    };
  });
  const biggest = Math.max(0, ...made.map((step) => step.lost ?? 0));
  const at = biggest === 0 ? -1 : made.findIndex((step) => step.lost === biggest);
  return made.map((step, index) => (index === at ? { ...step, largest: true } : step));
}

/** The step that lost the most players, and the step they had completed before it; none when nobody was lost. */
export function largestDrop(
  steps: readonly FunnelStep[],
): Readonly<{ step: FunnelStep; after: FunnelStep }> | undefined {
  const at = steps.findIndex((step) => step.largest);
  const step = steps[at];
  const after = at > 0 ? steps.slice(0, at).findLast((one) => !one.skipped) : undefined;
  return step === undefined || after === undefined ? undefined : { step, after };
}

/** One place where players stop: the step that lost the most of its category (FR-1204, "where players drop off"). */
export type Stop = Readonly<{
  categoryId: string;
  category: Bilingual;
  /** The step players completed and then went no further. */
  after: Bilingual;
  lost: number;
  lostPercent: number;
}>;

/** The largest drop of every category in order, largest first. */
export function stopsOf(data: QuestsAnalytics): readonly Stop[] {
  const stops: Stop[] = [];
  for (const category of data.categories.filter((one) => one.inOrder)) {
    const drop = largestDrop(funnelOf(category, data.joined));
    if (drop?.step.lost != null) {
      stops.push({
        categoryId: category.id,
        category: category.name,
        after: drop.after.title,
        lost: drop.step.lost,
        lostPercent: drop.step.lostPercent ?? 0,
      });
    }
  }
  return stops.toSorted(
    (first, second) => second.lost - first.lost || second.lostPercent - first.lostPercent,
  );
}

/** A quest in the popularity lists. */
export type QuestRow = Readonly<{
  id: string;
  title: Bilingual;
  category: Bilingual;
  done: number;
  percent: number | null;
}>;

/**
 * Every visible quest by how many players completed it, most first (the builder's order breaks a tie), and the two
 * short lists of FR-1204: the most popular, and the least popular among the rest.
 */
export function popularity(data: QuestsAnalytics): Readonly<{
  all: readonly QuestRow[];
  most: readonly QuestRow[];
  least: readonly QuestRow[];
}> {
  const rows = data.categories.flatMap((category) =>
    category.quests.map((quest): QuestRow => ({
      id: quest.id,
      title: quest.title,
      category: category.name,
      done: quest.done,
      percent: percentOf(quest.done, data.joined),
    })),
  );
  const all = rows.toSorted((first, second) => second.done - first.done);
  const most = all.slice(0, PANEL_ROWS);
  const least = all.slice(PANEL_ROWS).slice(-PANEL_ROWS).toReversed();
  return { all, most, least };
}

/** The ticks of a count axis: whole numbers from 0 up past `max`, at most five, with a step of 1, 2 or 5 times a power of ten. */
export function axisTicks(max: number): readonly number[] {
  const top = Math.max(1, max);
  const rough = top / 4;
  const power = Math.max(1, 10 ** Math.floor(Math.log10(rough)));
  const lead = rough / power;
  const step = (lead <= 1 ? 1 : lead <= 2 ? 2 : lead <= 5 ? 5 : 10) * power;
  const ticks = [0];
  while ((ticks.at(-1) ?? 0) < top) {
    ticks.push((ticks.at(-1) ?? 0) + step);
  }
  return ticks;
}

const LOCALES: Readonly<Record<Language, string>> = {
  // Gregorian dates and Western digits in Arabic too (ADR-018).
  ar: "ar-u-ca-gregory-nu-latn",
  en: "en-GB",
};

const utcOf = (at: string): number =>
  Date.UTC(
    Number(at.slice(0, 4)),
    Number(at.slice(5, 7)) - 1,
    Number(at.slice(8, 10)),
    Number(at.slice(11, 13)),
    Number(at.slice(14, 16)),
  );

/** A bucket's start as the event's own clock shows it: with the year when `long`, with the time for an hourly bucket. */
export function bucketLabel(
  at: string,
  unit: Participation["unit"],
  language: Language,
  long: boolean,
): string {
  return new Intl.DateTimeFormat(LOCALES[language], {
    timeZone: "UTC",
    day: "numeric",
    month: "short",
    ...(long ? { year: "numeric" } : {}),
    ...(unit === "hour" ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" } : {}),
  }).format(utcOf(at));
}

/** One point of the players-over-time line. */
export type SeriesPoint = Readonly<{ x: number; value: number; label: string; short: string }>;

/** The running count of joined players as chart points, placed by the time they were counted. */
export function seriesPoints(
  participation: Pick<Participation, "series" | "unit">,
  language: Language,
): readonly SeriesPoint[] {
  return participation.series.map((entry) => ({
    x: utcOf(entry.at),
    value: entry.joined,
    label: bucketLabel(entry.at, participation.unit, language, true),
    short: bucketLabel(entry.at, participation.unit, language, false),
  }));
}
