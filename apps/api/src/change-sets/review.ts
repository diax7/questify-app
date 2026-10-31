import type { ApiErrorEnvelope } from "@questify/shared";
import { notFound } from "#src/auth/http-errors";
import { categoryKind } from "#src/change-sets/category-kind";
import type { Reader, Seen, TargetKind } from "#src/change-sets/kinds";
import { questKind } from "#src/change-sets/quest-kind";
import { rewardKind } from "#src/change-sets/reward-kind";
import type { ItemRecord, ItemStatus, ItemTarget, JsonObject } from "#src/change-sets/store";
import { changes } from "#src/quests/builder";
import type { Bilingual } from "#src/quests/store";

export const KINDS: Readonly<Record<ItemTarget, TargetKind>> = {
  quest: questKind,
  category: categoryKind,
  reward: rewardKind,
};

/** What the review found about one item against the event as it is now. */
export type Evaluation = Readonly<{
  state: "ready" | "invalid" | "stale";
  problem: ApiErrorEnvelope | null;
  name: Bilingual | null;
  diff: Readonly<{ before: JsonObject; after: JsonObject }> | null;
  /** The body as the route's schema reads it; undefined when the body failed the schema. */
  input: unknown;
}>;

/** One item as the review page shows it. */
export type ItemView = Readonly<{
  id: string;
  position: number;
  op: ItemRecord["op"];
  target: ItemTarget;
  targetId: string | null;
  name: Bilingual | null;
  /** `discarded`: still undecided when the set was closed, so it was never applied. */
  state: "ready" | "invalid" | "stale" | "discarded" | ItemStatus;
  /** What the item changes, in the audit log's own words: only the fields that differ. */
  diff: Evaluation["diff"];
  /** The choices the body carries about points and quests, so the page can say them. */
  choices: Readonly<Record<string, string>>;
  problem: ApiErrorEnvelope | null;
  decidedAt: string | null;
}>;

/** A value with its object keys in a fixed order, so two views compare equal whatever order a store gave them. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    typeof inner === "object" && inner !== null && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).toSorted(([a], [b]) => (a < b ? -1 : 1)))
      : inner,
  );
}

export const sameView = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);

const bilingualOf = (value: unknown): Bilingual | null => {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const { ar, en } = value as Record<string, unknown>;
  return { ar: text(ar), en: text(en) };
};

/** The name the item's saved view or body carries, for an item whose target is no longer there to read. */
function savedName(item: ItemRecord): Bilingual | null {
  const { target, before, body } = item;
  const named = bilingualOf(body[target === "quest" ? "title" : "name"]);
  if (item.op === "add" || before === null) {
    return named;
  }
  if (target === "reward") {
    return bilingualOf(before["name"]);
  }
  const [ar, en] = target === "quest" ? ["titleAr", "titleEn"] : ["nameAr", "nameEn"];
  return { ar: text(before[ar as string]), en: text(before[en as string]) };
}

const CHOICES = ["apply", "points", "quests"] as const;

const choicesOf = (body: JsonObject): Record<string, string> =>
  Object.fromEntries(
    CHOICES.flatMap((key) => (typeof body[key] === "string" ? [[key, body[key] as string]] : [])),
  );

const early = (
  state: "invalid",
  problem: ApiErrorEnvelope,
  name: Bilingual | null,
): Evaluation => ({ state, problem, name, diff: null, input: undefined });

/** Whether the target no longer looks as it did when the set was made; an item that never saw its target is stale. */
const isStale = (item: ItemRecord, seen: Seen | undefined): boolean =>
  seen !== undefined && (item.before === null || !sameView(item.before, seen.view));

/** What the item would leave behind (the audit log's before and after) and why it would be refused. */
async function previewed(
  reader: Reader,
  item: ItemRecord,
  seen: Seen | undefined,
  checked: Readonly<{ input: unknown; stale: boolean; name: Bilingual | null }>,
): Promise<Evaluation> {
  const after = await KINDS[item.target].after(reader, item.op, seen, checked.input);
  if (!after.ok) {
    const state = checked.stale ? "stale" : "invalid";
    return { state, problem: after.problem, name: checked.name, diff: null, input: checked.input };
  }
  return {
    state: checked.stale ? "stale" : "ready",
    problem: null,
    name: after.name,
    diff: after.view === null ? null : changes(seen?.view ?? {}, after.view),
    input: checked.input,
  };
}

/** The target as it is now (undefined for an add, or when it is gone) and the name to show for the item. */
async function lookup(
  reader: Reader,
  item: ItemRecord,
): Promise<Readonly<{ seen: Seen | undefined; name: Bilingual | null }>> {
  const seen =
    item.targetId === null ? undefined : await KINDS[item.target].read(reader, item.targetId);
  return { seen, name: seen?.name ?? savedName(item) };
}

/**
 * Checks one pending item against the event now: its target must exist, its body must pass the route's schema, and
 * the target must still look as it did when the set was made (else the item is stale). With `preview`, also what the
 * item would leave behind and why it would be refused. No write happens, and the builder's own service stays the final
 * judge when the item is applied.
 */
export async function evaluate(
  reader: Reader,
  item: ItemRecord,
  preview: boolean,
): Promise<Evaluation> {
  const { seen, name } = await lookup(reader, item);
  if (item.op !== "add" && seen === undefined) {
    return early("invalid", notFound().envelope, name);
  }
  const parsed = KINDS[item.target].parse(item.op, item.body);
  if (!parsed.ok) {
    return early("invalid", KINDS[item.target].invalid(parsed.field), name);
  }
  const checked = { input: parsed.input, stale: isStale(item, seen), name };
  if (preview) {
    return previewed(reader, item, seen, checked);
  }
  const state = checked.stale ? "stale" : "ready";
  return { state, problem: null, name, diff: null, input: parsed.input };
}

/**
 * One item as the page shows it: decided items by what happened, pending ones of an open set by the review now, and
 * pending ones of a finished set as discarded (they can no longer be applied, so "ready" would mislead).
 */
export async function viewOf(
  reader: Reader,
  item: ItemRecord,
  setStatus: "open" | "applied" | "closed",
): Promise<ItemView> {
  const base = {
    id: item.id,
    position: item.position,
    op: item.op,
    target: item.target,
    targetId: item.targetId,
    choices: choicesOf(item.body),
    decidedAt: item.decidedAt?.toISOString() ?? null,
  };
  if (item.status === "applied" || item.status === "failed") {
    return {
      ...base,
      name: savedName(item),
      state: item.status,
      diff: null,
      problem: item.error as ApiErrorEnvelope | null,
    };
  }
  if (setStatus !== "open" && item.status === "pending") {
    return { ...base, name: savedName(item), state: "discarded", diff: null, problem: null };
  }
  const found = await evaluate(reader, item, true);
  return {
    ...base,
    name: found.name,
    state: item.status === "stale" ? "stale" : found.state,
    diff: found.diff,
    problem: found.problem,
  };
}
