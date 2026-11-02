import { z } from "zod";

/**
 * The go-live readiness checklist (T-618, FR-1845, ADR-403). The database answers facts (flags and counts over rows the
 * dashboard's pages already write: `event_readiness`, `readiness_soon`, migration 0112) and `evaluateReadiness` turns
 * them into items, so the owner's Overview and the console's list always show the same checklist.
 *
 * An item is done, a warning (the event works, but look at this) or blocking (without it players cannot use the event:
 * no dates, no activation, no playable quest, no prize desk place for an item reward, nobody to scan for an operator-only
 * quest, a guest list nobody is on). The checklist itself blocks nothing: the owner may still request activation and
 * Questify may still activate.
 */

export const READINESS_STATUSES = ["done", "warning", "blocking"] as const;
export type ReadinessStatus = (typeof READINESS_STATUSES)[number];

/** Every state an item can read, in the order the checklist lists its items; the text of each is `readiness.line.<line>`. */
export const READINESS_LINES = [
  "dates.missing",
  "dates.past",
  "dates.set",
  "activation.none",
  "activation.pending",
  "activation.rejected",
  "activation.active",
  "quests.none",
  "quests.unplayable",
  "quests.ready",
  "rewards.none",
  "rewards.soldOut",
  "rewards.ready",
  "desk.missing",
  "desk.set",
  "operators.none",
  "operators.one",
  "operators.ready",
  "join.emptyGuests",
  "join.guestList",
  "join.private",
  "join.open",
  "rules.missing",
  "rules.set",
  "bigScreen.unpaired",
  "bigScreen.paired",
  "devices.none",
  "devices.paired",
  "rehearsal.missing",
  "rehearsal.done",
  "branding.default",
  "branding.set",
  "setup.notStarted",
  "setup.partial",
  "setup.finished",
] as const;
export type ReadinessLine = (typeof READINESS_LINES)[number];

type KeyOf<Line extends string> = Line extends `${infer Key}.${string}` ? Key : never;

/** The checklist's items in order: the part of a line before its dot. */
export const READINESS_KEYS = [
  "dates",
  "activation",
  "quests",
  "rewards",
  "desk",
  "operators",
  "join",
  "rules",
  "bigScreen",
  "devices",
  "rehearsal",
  "branding",
  "setup",
] as const satisfies readonly KeyOf<ReadinessLine>[];
export type ReadinessKey = (typeof READINESS_KEYS)[number];

const count = z.number().int().min(0);
const eventStatus = z.enum(["draft", "scheduled", "live", "ended", "archived"]);

/** What the database knows of an event (`readiness_facts`): flags and counts only, never a player, a name or a text. */
export const readinessFactsSchema = z.strictObject({
  status: eventStatus,
  /** missing: no start or no end; past: the end has passed; set: both, in the future. */
  dates: z.enum(["missing", "past", "set"]),
  /** none: not requested; pending: waiting for Questify; rejected: declined with a note; active: approved. */
  activation: z.enum(["none", "pending", "rejected", "active"]),
  quests: z.strictObject({
    /** Every quest not removed. */
    total: count,
    /** Published, not paused, not skipped, not closed. */
    playable: count,
    /** Playable quests whose one proof is the player's My QR, scanned by an operator. */
    stationOnly: count,
    /** Playable quests only a paired kiosk or big screen can finish. */
    deviceOnly: count,
  }),
  rewards: z.strictObject({
    active: count,
    /** Active rewards with stock left and inside their window. */
    inStock: count,
    items: count,
    experiences: count,
  }),
  desk: z.strictObject({ place: z.boolean() }),
  operators: count,
  /** Paired devices that are not revoked. */
  devices: z.strictObject({ stations: count, kiosks: count, screens: count }),
  join: z.strictObject({
    access: z.enum(["public", "unlisted", "private"]),
    guestListOnly: z.boolean(),
    guests: count,
  }),
  rules: z.boolean(),
  /** The big screen add-on is granted and the event has not switched it off. */
  bigScreen: z.boolean(),
  rehearsed: z.boolean(),
  branding: z.boolean(),
  setup: z.strictObject({ decided: count, finished: z.boolean() }),
});
export type ReadinessFacts = z.infer<typeof readinessFactsSchema>;

/** One line of the checklist: which item, what it reads, its status and the number its words may show (0 when none). */
export const readinessItemSchema = z
  .strictObject({
    key: z.enum(READINESS_KEYS),
    line: z.enum(READINESS_LINES),
    status: z.enum(READINESS_STATUSES),
    count,
  })
  .refine((item) => item.line.startsWith(`${item.key}.`), {
    message: "the line belongs to another item",
  });
export type ReadinessItem = z.infer<typeof readinessItemSchema>;

export const readinessCountsSchema = z.strictObject({
  done: count,
  warning: count,
  blocking: count,
});
export type ReadinessCounts = z.infer<typeof readinessCountsSchema>;

/** `GET …/events/{id}/readiness`: the event's status now, its items in order and how many items hold each status. */
export const readinessSchema = z.strictObject({
  status: eventStatus,
  items: z.array(readinessItemSchema).max(READINESS_KEYS.length),
  counts: readinessCountsSchema,
});
export type Readiness = z.infer<typeof readinessSchema>;

const text = z.strictObject({ ar: z.string().nullable(), en: z.string().nullable() });

/** One event of the console's list, as the database answers it. */
export const readinessSoonRowSchema = z.strictObject({
  id: z.uuid(),
  name: text,
  organizer: z.strictObject({ id: z.uuid(), name: z.string() }),
  timezone: z.string(),
  startsAt: z.string(),
  endsAt: z.string(),
  facts: readinessFactsSchema,
});
export const readinessSoonRowsSchema = z.strictObject({ events: z.array(readinessSoonRowSchema) });

/** One event of `GET /v1/admin/readiness`: who and when, with the same checklist the owner reads. */
export const readinessSoonEventSchema = readinessSoonRowSchema
  .omit({ facts: true })
  .extend({ readiness: readinessSchema });
export type ReadinessSoonEvent = z.infer<typeof readinessSoonEventSchema>;

/** `GET /v1/admin/readiness`: up to 100 events starting within 14 days that are not live yet, soonest first. */
export const readinessSoonSchema = z.strictObject({
  events: z.array(readinessSoonEventSchema).max(100),
});
export type ReadinessSoon = z.infer<typeof readinessSoonSchema>;

const keyOf = (line: ReadinessLine): ReadinessKey =>
  line.slice(0, line.indexOf(".")) as ReadinessKey;

const item = (line: ReadinessLine, status: ReadinessStatus, shown = 0): ReadinessItem => ({
  key: keyOf(line),
  line,
  status,
  count: shown,
});

type Check = (facts: ReadinessFacts) => ReadinessItem | undefined;

const checkDates: Check = ({ dates: state }) => {
  if (state === "set") {
    return item("dates.set", "done");
  }
  return item(state === "past" ? "dates.past" : "dates.missing", "blocking");
};

const ACTIVATION: Readonly<Record<ReadinessFacts["activation"], [ReadinessLine, ReadinessStatus]>> =
  {
    none: ["activation.none", "blocking"],
    pending: ["activation.pending", "warning"],
    rejected: ["activation.rejected", "blocking"],
    active: ["activation.active", "done"],
  };

const checkActivation: Check = ({ activation: state }) => item(...ACTIVATION[state]);

const checkQuests: Check = ({ quests: found }) => {
  if (found.total === 0) {
    return item("quests.none", "blocking");
  }
  if (found.playable === 0) {
    return item("quests.unplayable", "blocking", found.total);
  }
  return item("quests.ready", "done", found.playable);
};

const checkRewards: Check = ({ rewards: found }) => {
  if (found.active === 0) {
    return item("rewards.none", "warning");
  }
  if (found.inStock === 0) {
    return item("rewards.soldOut", "warning", found.active);
  }
  return item("rewards.ready", "done", found.inStock);
};

/** The prize desk: only an event with an item or experience reward needs one, and an item reward cannot do without. */
const checkDesk: Check = ({ rewards: found, desk: chosen }) => {
  if (found.items + found.experiences === 0) {
    return undefined;
  }
  if (chosen.place) {
    return item("desk.set", "done");
  }
  return item("desk.missing", found.items > 0 ? "blocking" : "warning");
};

/** Operators: needed when a quest only an operator can finish, a paired station or a prize to hand over exists. */
const checkOperators: Check = ({
  operators: assigned,
  quests: found,
  devices,
  rewards: prizes,
}) => {
  const needed = found.stationOnly + devices.stations + prizes.items + prizes.experiences > 0;
  if (!needed) {
    return undefined;
  }
  if (assigned >= 2) {
    return item("operators.ready", "done", assigned);
  }
  if (assigned === 1) {
    return item("operators.one", "warning", 1);
  }
  return item("operators.none", found.stationOnly > 0 ? "blocking" : "warning");
};

const checkJoin: Check = ({ join: how }) => {
  if (how.guestListOnly) {
    return how.guests === 0
      ? item("join.emptyGuests", "blocking")
      : item("join.guestList", "done", how.guests);
  }
  return item(how.access === "private" ? "join.private" : "join.open", "done");
};

const checkRules: Check = ({ rules: written }) =>
  written ? item("rules.set", "done") : item("rules.missing", "warning");

const checkBigScreen: Check = ({ bigScreen: on, devices }) => {
  if (!on) {
    return undefined;
  }
  return devices.screens > 0
    ? item("bigScreen.paired", "done", devices.screens)
    : item("bigScreen.unpaired", "warning");
};

const checkDevices: Check = ({ quests: found, devices: paired }) => {
  if (found.deviceOnly === 0) {
    return undefined;
  }
  const reachable = paired.kiosks + paired.screens;
  return reachable > 0
    ? item("devices.paired", "done", reachable)
    : item("devices.none", "warning");
};

/** A rehearsal can only be run before go-live, so after it a missing one is not listed. */
const checkRehearsal: Check = ({ rehearsed, status }) => {
  if (rehearsed) {
    return item("rehearsal.done", "done");
  }
  return status === "draft" || status === "scheduled"
    ? item("rehearsal.missing", "warning")
    : undefined;
};

const checkBranding: Check = ({ branding: chosen }) =>
  chosen ? item("branding.set", "done") : item("branding.default", "warning");

const checkSetup: Check = ({ setup: progress }) => {
  if (progress.finished) {
    return item("setup.finished", "done");
  }
  return progress.decided > 0
    ? item("setup.partial", "warning", progress.decided)
    : item("setup.notStarted", "warning");
};

const CHECKS: readonly Check[] = [
  checkDates,
  checkActivation,
  checkQuests,
  checkRewards,
  checkDesk,
  checkOperators,
  checkJoin,
  checkRules,
  checkBigScreen,
  checkDevices,
  checkRehearsal,
  checkBranding,
  checkSetup,
];

/** How many items hold each status. */
export function countReadiness(items: readonly ReadinessItem[]): ReadinessCounts {
  const counts = { done: 0, warning: 0, blocking: 0 };
  for (const entry of items) {
    counts[entry.status] += 1;
  }
  return counts;
}

/** The checklist for these facts: the items that apply to the event, in order, with their counts. Blocks nothing. */
export function evaluateReadiness(facts: ReadinessFacts): Readiness {
  const items = CHECKS.flatMap((check) => check(facts) ?? []);
  return { status: facts.status, items, counts: countReadiness(items) };
}
