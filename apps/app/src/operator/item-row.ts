import { formatNumber, type Language, type MessageKey } from "@questify/shared";
import type { TextLine } from "#src/components/text-lines.ts";
import { textIn } from "#src/i18n/text.ts";
import { actionLabel, type DeskItem, type ItemAction } from "#src/operator/desk.ts";

type Translate = (key: MessageKey, params?: Readonly<Record<string, string | number>>) => string;

/** What happened to a row on this desk since the scan. */
export type Done = "handed_over" | "cancelled" | "ended" | "lapsed";

/** A row still offers its actions until it is handed over, cancelled or ended; a lapsed offer offers them again. */
const isOpen = (done: Done | undefined): boolean => done === undefined || done === "lapsed";

/** The item's name, and what makes it special: a rank prize, a quest's reward, an experience. */
function headLines(t: Translate, language: Language, item: DeskItem): TextLine[] {
  const lines: TextLine[] = [
    { key: "name", text: textIn(item.name, language), props: { variant: "label" } },
  ];
  if (item.rank !== null) {
    const rank = formatNumber(item.rank, language);
    lines.push({ key: "rank", text: t("win.rankPrize", { rank }), props: { muted: true } });
  }
  if (item.questReward) {
    lines.push({ key: "questReward", text: t("win.questReward"), props: { muted: true } });
  }
  if (item.kind === "experience") {
    lines.push({ key: "experience", text: t("operator.desk.experience"), props: { muted: true } });
  }
  return lines;
}

/** What became of the row on this desk: handed over (said as an alert), cancelled or ended. */
function doneLines(t: Translate, item: DeskItem, done: Done | undefined): TextLine[] {
  if (done === "handed_over") {
    const key = item.kind === "experience" ? "operator.desk.doneExperience" : "operator.desk.done";
    return [{ key: "done", text: t(key), props: { accessibilityRole: "alert" } }];
  }
  if (done === "cancelled") {
    return [{ key: "cancelled", text: t("operator.desk.cancelled"), props: {} }];
  }
  return done === "ended" ? [{ key: "ended", text: t("operator.desk.ended"), props: {} }] : [];
}

/** What the desk says about an open row: a lapsed offer, a hold, the pickup time left, who it waits for. */
function stateLines(
  t: Translate,
  action: ItemAction,
  done: Done | undefined,
  facts: Readonly<{ player: string; minutes: number | null }>,
): TextLine[] {
  const { player, minutes } = facts;
  const lines: TextLine[] = [];
  if (done === "lapsed") {
    lines.push({ key: "notAccepted", text: t("operator.desk.notAccepted"), props: {} });
  }
  if (action === "held") {
    const props = { accessibilityRole: "alert" } as const;
    lines.push({ key: "held", text: t("operator.desk.held"), props });
  }
  if (minutes !== null) {
    const text = t("operator.desk.pickupLeft", { minutes: String(minutes) });
    lines.push({ key: "pickupLeft", text, props: { muted: true } });
  }
  if (action === "not_ready") {
    lines.push({ key: "notReady", text: t("operator.desk.notReady", { player }), props: {} });
  }
  if (action === "waiting") {
    const text = t("operator.desk.waitingAccept", { player });
    lines.push({ key: "waiting", text, props: { accessibilityLiveRegion: "polite" } });
  }
  return lines;
}

/** The row's buttons: the hand-over (or offer) button with its words, and Cancel. */
export function controlsOf(
  item: DeskItem,
  action: ItemAction,
  done: Done | undefined,
): Readonly<{ handOver: MessageKey | null; cancel: boolean }> {
  if (!isOpen(done)) {
    return { handOver: null, cancel: false };
  }
  return {
    handOver: action === "hand_over" || action === "offer" ? actionLabel(item, action) : null,
    cancel: action !== "blocked",
  };
}

/** Every line of a waiting item's row, in the order the desk shows them. */
export function itemLines(
  t: Translate,
  language: Language,
  row: Readonly<{
    item: DeskItem;
    action: ItemAction;
    done: Done | undefined;
    player: string;
    minutes: number | null;
  }>,
): TextLine[] {
  const { item, action, done, player, minutes } = row;
  return [
    ...headLines(t, language, item),
    ...doneLines(t, item, done),
    ...(isOpen(done) ? stateLines(t, action, done, { player, minutes }) : []),
  ];
}
