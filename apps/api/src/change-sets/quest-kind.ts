import { isQuestType, type ApiErrorEnvelope } from "@questify/shared";
import { z } from "zod";
import type { ItemOp } from "#src/change-sets/store";
import { invalidQuest, platformFeatureOff } from "#src/auth/http-errors";
import {
  envelopeOf,
  parseWith,
  type After,
  type Parsed,
  type Reader,
  type Seen,
  type TargetKind,
} from "#src/change-sets/kinds";
import { locationQuestsOn } from "#src/completions/complete";
import { auditView, isInvalid, mergeQuest, type Done, type Refused } from "#src/quests/builder";
import { createQuest, deleteQuest, updateQuest } from "#src/quests/quests";
import { answer, questBody, questPatch } from "#src/quests/routes";
import { readCategory, readQuest, type QuestRecord } from "#src/quests/store";

const deleteChoice = z.strictObject({ points: z.enum(["keep", "remove"]).optional() });

type AddInput = z.infer<typeof questBody>;
type EditInput = z.infer<typeof questPatch>;
type DeleteInput = z.infer<typeof deleteChoice>;

/** The route's answer for a result as an error envelope, or null when the result is done. */
const refusalOf = (result: Done<unknown>) => envelopeOf(() => answer(result, (value) => value));

/** The envelope of a refusal, which the route always answers with an error. */
function refusedBy(result: Refused): ApiErrorEnvelope {
  const envelope = refusalOf(result);
  if (envelope === null) {
    throw new Error(`The route answered the refusal ${result.kind} as done.`);
  }
  return envelope;
}

const problem = (field: string): After => ({
  ok: false,
  problem: invalidQuest({ field }).envelope,
});

async function read({ client, event }: Reader, id: string): Promise<Seen | undefined> {
  const quest = await readQuest(client, event.id, id);
  return quest === undefined
    ? undefined
    : { view: auditView(quest), name: quest.title, record: quest };
}

function parse(op: ItemOp, body: Record<string, unknown>): Parsed {
  return parseWith(op === "add" ? questBody : op === "edit" ? questPatch : deleteChoice, body);
}

async function addAfter({ client, event }: Reader, input: AddInput): Promise<After> {
  if (!isQuestType(input.type)) {
    return problem("type");
  }
  if ((await readCategory(client, event.id, input.categoryId)) === undefined) {
    return problem("categoryId");
  }
  const fields = mergeQuest(undefined, input.type, input, event.timezone);
  if (isInvalid(fields)) {
    return { ok: false, problem: refusedBy(fields) };
  }
  return {
    ok: true,
    view: auditView({ ...fields, type: input.type, steps: [] }),
    name: fields.title,
  };
}

async function editAfter(
  { client, event }: Reader,
  current: QuestRecord,
  input: EditInput,
): Promise<After> {
  if (
    input.categoryId !== undefined &&
    (await readCategory(client, event.id, input.categoryId)) === undefined
  ) {
    return problem("categoryId");
  }
  const fields = mergeQuest(current, current.type, input, event.timezone);
  if (isInvalid(fields)) {
    return { ok: false, problem: refusedBy(fields) };
  }
  return {
    ok: true,
    view: auditView({ ...fields, type: current.type, steps: current.steps }),
    name: fields.title,
  };
}

function after(reader: Reader, op: ItemOp, seen: Seen | undefined, input: unknown): Promise<After> {
  if (op === "add") {
    return addAfter(reader, input as AddInput);
  }
  const current = seen?.record as QuestRecord;
  return op === "edit"
    ? editAfter(reader, current, input as EditInput)
    : Promise.resolve({ ok: true, view: null, name: current.title });
}

export const questKind: TargetKind = {
  invalid: (field) => invalidQuest({ field }).envelope,
  read,
  parse,
  after,
  async run(context, item, input) {
    const { pool, actor, caller, eventId } = context;
    if (item.op === "add") {
      const body = input as AddInput;
      if (body.type === "location" && !(await locationQuestsOn(context.settings))) {
        return platformFeatureOff().envelope;
      }
      return refusalOf(await createQuest({ pool }, actor, eventId, body, caller));
    }
    const target = { eventId, id: item.targetId as string };
    if (item.op === "edit") {
      const edit = { ...(input as EditInput), confirm: true };
      return refusalOf(
        await updateQuest({ pool }, actor, { ...target, key: `cs:${item.id}` }, edit, caller),
      );
    }
    const choice = { ...(input as DeleteInput), confirm: true };
    return refusalOf(await deleteQuest({ pool }, actor, target, choice, caller));
  },
};
