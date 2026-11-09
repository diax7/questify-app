import {
  MESSAGES,
  createTranslator,
  formatNumber,
  type Language,
  type MessageKey,
} from "@questify/shared";
import { describe, expect, it } from "vitest";
import { textIn } from "#src/i18n/text.ts";
import { actionLabel, type DeskItem, type ItemAction } from "#src/operator/desk.ts";
import { controlsOf, itemLines, type Done } from "#src/operator/item-row.ts";

const translate = createTranslator(MESSAGES);
const tIn =
  (language: Language) => (key: MessageKey, params?: Readonly<Record<string, string | number>>) =>
    translate(key, language, params);

const item = (fields: Partial<DeskItem> = {}): DeskItem => ({
  id: "i1",
  kind: "item",
  name: { ar: "قميص", en: "T-shirt" },
  reservedUntil: null,
  ready: false,
  offered: false,
  offerUntil: null,
  rank: null,
  questReward: false,
  ...fields,
});

const ACTIONS: readonly ItemAction[] = [
  "blocked",
  "paused",
  "held",
  "closed",
  "hand_over",
  "not_ready",
  "offer",
  "waiting",
];
const DONES: readonly (Done | undefined)[] = [
  undefined,
  "handed_over",
  "cancelled",
  "ended",
  "lapsed",
];

type Seen = Readonly<{ text: string; muted: boolean; role: string; live: string; variant: string }>;
type Old = Readonly<{ lines: Seen[]; handOver: MessageKey | null; cancel: boolean }>;

const seen = (text: string, extra: Partial<Seen> = {}): Seen => ({
  text,
  muted: false,
  role: "",
  live: "",
  variant: "",
  ...extra,
});

// ItemRow's JSX as it read before the lines moved out of it: every conditional child in order, then the buttons.
function oldRow(
  language: Language,
  entry: DeskItem,
  action: ItemAction,
  done: Done | undefined,
  minutes: number | null,
  player: string,
): Old {
  const t = tIn(language);
  const lines: Seen[] = [seen(textIn(entry.name, language), { variant: "label" })];
  if (entry.rank !== null) {
    lines.push(
      seen(t("win.rankPrize", { rank: formatNumber(entry.rank, language) }), { muted: true }),
    );
  }
  if (entry.questReward) {
    lines.push(seen(t("win.questReward"), { muted: true }));
  }
  if (entry.kind === "experience") {
    lines.push(seen(t("operator.desk.experience"), { muted: true }));
  }
  if (done === "handed_over") {
    lines.push(
      seen(t(entry.kind === "experience" ? "operator.desk.doneExperience" : "operator.desk.done"), {
        role: "alert",
      }),
    );
  }
  if (done === "cancelled") {
    lines.push(seen(t("operator.desk.cancelled")));
  }
  if (done === "ended") {
    lines.push(seen(t("operator.desk.ended")));
  }
  let handOver: MessageKey | null = null;
  let cancel = false;
  if (done === undefined || done === "lapsed") {
    if (done === "lapsed") {
      lines.push(seen(t("operator.desk.notAccepted")));
    }
    if (action === "held") {
      lines.push(seen(t("operator.desk.held"), { role: "alert" }));
    }
    if (minutes !== null) {
      lines.push(
        seen(t("operator.desk.pickupLeft", { minutes: String(minutes) }), { muted: true }),
      );
    }
    if (action === "not_ready") {
      lines.push(seen(t("operator.desk.notReady", { player })));
    }
    if (action === "waiting") {
      lines.push(seen(t("operator.desk.waitingAccept", { player }), { live: "polite" }));
    }
    if (action === "hand_over" || action === "offer") {
      handOver = actionLabel(entry, action);
    }
    cancel = action !== "blocked";
  }
  return { lines, handOver, cancel };
}

const seenOf = (line: { text: string; props: Record<string, unknown> }): Seen =>
  seen(line.text, {
    muted: line.props["muted"] === true,
    role: (line.props["accessibilityRole"] as string | undefined) ?? "",
    live: (line.props["accessibilityLiveRegion"] as string | undefined) ?? "",
    variant: (line.props["variant"] as string | undefined) ?? "",
  });

describe("itemLines", () => {
  it("is the name alone for a plain item with nothing to say", () => {
    expect(
      itemLines(tIn("en"), "en", {
        item: item(),
        action: "closed",
        done: undefined,
        player: "sara",
        minutes: null,
      }),
    ).toEqual([{ key: "name", text: "T-shirt", props: { variant: "label" } }]);
  });

  it("says a rank prize, a quest reward and an experience, with Western digits", () => {
    const lines = itemLines(tIn("ar"), "ar", {
      item: item({ rank: 3, questReward: true, kind: "experience" }),
      action: "closed",
      done: undefined,
      player: "sara",
      minutes: null,
    });
    expect(lines.map((line) => line.key)).toEqual(["name", "rank", "questReward", "experience"]);
    expect(lines[1]?.text).toBe(tIn("ar")("win.rankPrize", { rank: "3" }));
    expect(lines[1]?.text).not.toMatch(/[٠-٩]/);
  });

  it("names the player a waiting or not-ready row is about, and the pickup time left", () => {
    const row = { item: item(), done: undefined, player: "sara", minutes: 7 } as const;
    expect(
      itemLines(tIn("en"), "en", { ...row, action: "waiting" }).map((line) => line.key),
    ).toEqual(["name", "pickupLeft", "waiting"]);
    expect(
      itemLines(tIn("en"), "en", { ...row, action: "not_ready" }).map((line) => line.key),
    ).toEqual(["name", "pickupLeft", "notReady"]);
    const waiting = itemLines(tIn("en"), "en", { ...row, action: "waiting" }).at(-1);
    expect(waiting?.props).toEqual({ accessibilityLiveRegion: "polite" });
    expect(waiting?.text).toContain("sara");
  });

  it("matches the old inline rows for every combination, in both languages", () => {
    const items = [
      item(),
      item({ rank: 1 }),
      item({ questReward: true }),
      item({ kind: "experience", rank: 12, questReward: true }),
    ];
    for (const language of ["ar", "en"] as const) {
      for (const entry of items) {
        for (const action of ACTIONS) {
          for (const done of DONES) {
            for (const minutes of [null, 0, 5]) {
              const before = oldRow(language, entry, action, done, minutes, "sara");
              const lines = itemLines(tIn(language), language, {
                item: entry,
                action,
                done,
                player: "sara",
                minutes,
              });
              expect(lines.map(seenOf)).toEqual(before.lines);
              expect(new Set(lines.map((line) => line.key)).size).toBe(lines.length);
              const controls = controlsOf(entry, action, done);
              expect(controls).toEqual({ handOver: before.handOver, cancel: before.cancel });
            }
          }
        }
      }
    }
  });
});

describe("controlsOf", () => {
  it.each<[string, DeskItem, ItemAction, Done | undefined, string | null, boolean]>([
    ["hand over", item(), "hand_over", undefined, "operator.desk.handedOver", true],
    ["an offer", item(), "offer", undefined, "operator.desk.handOver", true],
    [
      "an experience is confirmed",
      item({ kind: "experience" }),
      "hand_over",
      undefined,
      "operator.confirm",
      true,
    ],
    ["a held row can only be cancelled", item(), "held", undefined, null, true],
    ["a blocked row has no buttons", item(), "blocked", undefined, null, false],
    ["a lapsed offer offers again", item(), "offer", "lapsed", "operator.desk.handOver", true],
    ["a handed-over row has none", item(), "hand_over", "handed_over", null, false],
    ["a cancelled row has none", item(), "offer", "cancelled", null, false],
    ["an ended row has none", item(), "offer", "ended", null, false],
  ])("%s", (_name, entry, action, done, handOver, cancel) => {
    expect(controlsOf(entry, action, done)).toEqual({ handOver, cancel });
  });
});
