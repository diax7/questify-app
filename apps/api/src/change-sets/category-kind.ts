import type { ApiErrorEnvelope } from "@questify/shared";
import type { z } from "zod";
import { invalidCategory } from "#src/auth/http-errors";
import {
  envelopeOf,
  parseWith,
  type After,
  type Parsed,
  type Reader,
  type Seen,
  type TargetKind,
} from "#src/change-sets/kinds";
import type { ItemOp } from "#src/change-sets/store";
import { NO_TEXT, bilingual, timeOf, type Done } from "#src/quests/builder";
import {
  categoryView,
  createCategory,
  deleteCategory,
  updateCategory,
} from "#src/quests/categories";
import { answer, categoryBody, categoryDelete, categoryPatch } from "#src/quests/routes";
import { readCategory, type Bilingual, type CategoryRecord } from "#src/quests/store";

type AddInput = z.infer<typeof categoryBody>;
type EditInput = z.infer<typeof categoryPatch>;
type DeleteInput = z.infer<typeof categoryDelete>;

const refusalOf = (result: Done<unknown>): ApiErrorEnvelope | null =>
  envelopeOf(() => answer(result, (value) => value, "category"));

const problem = (field: string): After => ({
  ok: false,
  problem: invalidCategory({ field }).envelope,
});

async function read({ client, event }: Reader, id: string): Promise<Seen | undefined> {
  const category = await readCategory(client, event.id, id);
  return category === undefined
    ? undefined
    : { view: categoryView(category), name: category.name, record: category };
}

function parse(op: ItemOp, body: Record<string, unknown>): Parsed {
  return parseWith(
    op === "add" ? categoryBody : op === "edit" ? categoryPatch : categoryDelete,
    body,
  );
}

function addAfter(input: AddInput): After {
  const name = bilingual(input.name, NO_TEXT);
  return name.ar === null && name.en === null
    ? problem("name")
    : { ok: true, view: { nameAr: name.ar, nameEn: name.en }, name };
}

type Resolved = Readonly<{ name: Bilingual; opensAt: Date | null; unlockAfter: string | null }>;

/** The edit's name, opening time and unlock as the builder reads them, or the field the builder would refuse. */
async function resolve(
  { client, event }: Reader,
  current: CategoryRecord,
  input: EditInput,
): Promise<Resolved | string> {
  const name = bilingual(input.name, current.name);
  if (name.ar === null && name.en === null) {
    return "name";
  }
  const opensAt = timeOf(input.opensAt, current.opensAt, event.timezone);
  if (opensAt === "invalid") {
    return "opensAt";
  }
  const unlockAfter = input.unlockAfter === undefined ? current.unlockAfter : input.unlockAfter;
  const unlockable =
    unlockAfter === null ||
    (unlockAfter !== current.id &&
      (await readCategory(client, event.id, unlockAfter)) !== undefined);
  return unlockable ? { name, opensAt, unlockAfter } : "unlockAfter";
}

async function editAfter(
  reader: Reader,
  current: CategoryRecord,
  input: EditInput,
): Promise<After> {
  const resolved = await resolve(reader, current, input);
  if (typeof resolved === "string") {
    return problem(resolved);
  }
  const edited: CategoryRecord = {
    ...current,
    ...resolved,
    orderMode: input.orderMode ?? current.orderMode,
    completionBonus: input.completionBonus ?? current.completionBonus,
    refresh: input.refresh ?? current.refresh,
    hidden: input.hidden ?? current.hidden,
    itemId: input.itemId === undefined ? current.itemId : input.itemId,
  };
  return { ok: true, view: categoryView(edited), name: resolved.name };
}

function after(reader: Reader, op: ItemOp, seen: Seen | undefined, input: unknown): Promise<After> {
  if (op === "add") {
    return Promise.resolve(addAfter(input as AddInput));
  }
  const current = seen?.record as CategoryRecord;
  return op === "edit"
    ? editAfter(reader, current, input as EditInput)
    : Promise.resolve({ ok: true, view: null, name: current.name });
}

export const categoryKind: TargetKind = {
  invalid: (field) => invalidCategory({ field }).envelope,
  read,
  parse,
  after,
  async run({ pool, actor, caller, eventId }, item, input) {
    if (item.op === "add") {
      const body = { ...(input as AddInput), confirm: true };
      return refusalOf(await createCategory({ pool }, actor, eventId, body, caller));
    }
    const target = { eventId, id: item.targetId as string };
    if (item.op === "edit") {
      const edit = { ...(input as EditInput), confirm: true };
      return refusalOf(await updateCategory({ pool }, actor, target, edit, caller));
    }
    const choice = { ...(input as DeleteInput), confirm: true };
    return refusalOf(await deleteCategory({ pool }, actor, target, choice, caller));
  },
};
