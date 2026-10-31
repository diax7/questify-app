import { z } from "zod";
import type { ConfigIssue, Validation } from "#src/config/validate";
import {
  BAR_KEYS,
  BAR_PROTECTED,
  HOME_KEYS,
  HOME_PROTECTED,
  MAX_BAR_SLOTS,
  type EventLayout,
} from "#src/layout/layout";
import { presetLayout } from "#src/layout/presets";

const list = z.strictObject({ order: z.array(z.string()), hidden: z.array(z.string()) });
const custom = z.strictObject({ bar: list, home: list });
const preset = z.strictObject({ preset: z.string() });

type RawList = Readonly<{ order: readonly string[]; hidden: readonly string[] }>;

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
  const issues = [
    ...slotIssues(input.bar.order),
    ...orderIssues("bar", input.bar.order, BAR_KEYS),
    ...orderIssues("home", input.home.order, HOME_KEYS),
    ...hiddenIssues("bar", input.bar, BAR_PROTECTED),
    ...hiddenIssues("home", input.home, HOME_PROTECTED),
  ];
  return issues.length > 0
    ? { ok: false, issues }
    : { ok: true, value: input as unknown as EventLayout };
}

/**
 * Checks what an organizer saves as an event's layout (FR-1749, FR-1750, FR-1764): either `{ preset }`, one of the team's
 * approved presets by name, or `{ bar, home }`, each an order that lists every item of the app once and a hidden set. A layout
 * that hides Home, the scan button, Profile or a protected Home block, or that has more than five bar slots, is refused; an
 * issue for a protected item carries its name in `protectedItem`.
 */
export function validateLayoutRequest(input: unknown): Validation<EventLayout> {
  const named = preset.safeParse(input);
  if (named.success) {
    const found = presetLayout(named.data.preset);
    return found === undefined
      ? { ok: false, issues: [{ path: "preset", message: "is not an approved preset" }] }
      : { ok: true, value: found };
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
  return checkCustom(parsed.data);
}
