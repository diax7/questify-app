import { z } from "zod";
import type { ConfigIssue, Validation } from "#src/config/validate";
import { checkHomeContent, type HomeContent } from "#src/layout/home-content";
import {
  BAR_KEYS,
  BAR_PROTECTED,
  HOME_PROTECTED,
  INFO_KEYS,
  INFO_PROTECTED,
  MAX_BAR_SLOTS,
  homeKeysOf,
  type EventLayout,
} from "#src/layout/layout";
import { checkLooks } from "#src/layout/looks";
import { applyPreset, presetLayout } from "#src/layout/presets";

const list = z.strictObject({ order: z.array(z.string()), hidden: z.array(z.string()) });
const custom = z.strictObject({
  bar: list,
  home: list,
  info: list,
  content: z.unknown(),
  looks: z.unknown(),
});
const preset = z.strictObject({ preset: z.string() });

type RawList = Readonly<{ order: readonly string[]; hidden: readonly string[] }>;

/** What a save asks for: a preset to lay over the event's layout, or the whole layout. */
export type LayoutChange =
  | Readonly<{ kind: "preset"; layout: EventLayout }>
  | Readonly<{ kind: "custom"; layout: EventLayout }>;

function orderIssues(
  path: string,
  order: readonly string[],
  keys: readonly string[],
): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const seen = new Set<string>();
  order.forEach((item, index) => {
    if (!keys.includes(item)) {
      issues.push({ path: `${path}.order.${index}`, message: "is not an item of the app" });
    } else if (seen.has(item)) {
      issues.push({ path: `${path}.order.${index}`, message: "is listed twice" });
    }
    seen.add(item);
  });
  const missing = keys.filter((key) => !seen.has(key));
  if (missing.length > 0) {
    issues.push({
      path: `${path}.order`,
      message: `must list every item; missing ${missing.join(", ")}`,
    });
  }
  return issues;
}

function hiddenIssues(
  path: string,
  part: RawList,
  protectedKeys: ReadonlySet<string>,
): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  part.hidden.forEach((item, index) => {
    const where = `${path}.hidden.${index}`;
    if (protectedKeys.has(item)) {
      issues.push({
        path: where,
        message: "is always shown and cannot be hidden",
        protectedItem: item,
      });
    } else if (!part.order.includes(item)) {
      issues.push({ path: where, message: "is not an item of the list" });
    } else if (part.hidden.indexOf(item) !== index) {
      issues.push({ path: where, message: "is listed twice" });
    }
  });
  return issues;
}

function slotIssues(order: readonly string[]): ConfigIssue[] {
  return order.length > MAX_BAR_SLOTS
    ? [{ path: "bar.order", message: `has more than ${MAX_BAR_SLOTS} slots` }]
    : [];
}

function checkCustom(input: z.infer<typeof custom>): Validation<EventLayout> {
  const written = checkHomeContent(input.content);
  if (!written.ok) {
    return { ok: false, issues: written.issues };
  }
  const looks = checkLooks(input.looks);
  if (!looks.ok) {
    return { ok: false, issues: looks.issues };
  }
  const content: HomeContent = written.value;
  const issues = [
    ...slotIssues(input.bar.order),
    ...orderIssues("bar", input.bar.order, BAR_KEYS),
    ...orderIssues("home", input.home.order, homeKeysOf(content)),
    ...orderIssues("info", input.info.order, INFO_KEYS),
    ...hiddenIssues("bar", input.bar, BAR_PROTECTED),
    ...hiddenIssues("home", input.home, HOME_PROTECTED),
    ...hiddenIssues("info", input.info, INFO_PROTECTED),
  ];
  return issues.length > 0
    ? { ok: false, issues }
    : { ok: true, value: { ...(input as unknown as EventLayout), content, looks: looks.value } };
}

/**
 * Checks what an organizer saves as an event's layout (FR-1749, FR-1750, FR-1764, FR-1828 to FR-1831): either `{ preset }`,
 * one of the team's approved presets by name, or `{ bar, home, info, content, looks }`, each list an order that names every item
 * once and a hidden set (`info` is the event info page's sections), the content written for Home and the info page (cleaned and bounded) and the looks of the ranking, Quests
 * and Rewards screens (every choice named, each one allowed). A layout that hides Home, the scan button,
 * Profile or a protected Home block, or that has more than five bar slots, is refused; an issue for a protected item carries
 * its name in `protectedItem`.
 */
export function validateLayoutRequest(input: unknown): Validation<LayoutChange> {
  const named = preset.safeParse(input);
  if (named.success) {
    const found = presetLayout(named.data.preset);
    return found === undefined
      ? { ok: false, issues: [{ path: "preset", message: "is not an approved preset" }] }
      : { ok: true, value: { kind: "preset", layout: found } };
  }
  const parsed = custom.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.map(String).join("."),
        message: issue.message,
      })),
    };
  }
  const checked = checkCustom(parsed.data);
  return checked.ok ? { ok: true, value: { kind: "custom", layout: checked.value } } : checked;
}

/** The layout a checked change leaves an event with: a preset keeps the event's cards and words, a custom layout replaces all. */
export function layoutAfter(change: LayoutChange, current: EventLayout): EventLayout {
  return change.kind === "preset" ? applyPreset(current, change.layout) : change.layout;
}
