import type { ApiErrorEnvelope } from "@questify/shared";
import { z } from "zod";
import { invalidReward } from "#src/auth/http-errors";
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
import {
  auditView,
  createReward,
  mergeReward,
  readReward,
  removeReward,
  updateReward,
  type RewardDone,
  type RewardRecord,
} from "#src/rewards/builder";
import { answer, rewardBody, rewardPatch } from "#src/rewards/routes";

type AddInput = z.infer<typeof rewardBody>;
type EditInput = z.infer<typeof rewardPatch>;

const refusalOf = (result: RewardDone<unknown>): ApiErrorEnvelope | null =>
  envelopeOf(() => answer(result, (value) => value));

/** The envelope of a refusal, which the route always answers with an error. */
function refusedBy(result: Exclude<RewardDone<unknown>, { kind: "done" }>): ApiErrorEnvelope {
  const envelope = refusalOf(result);
  if (envelope === null) {
    throw new Error(`The route answered the refusal ${result.kind} as done.`);
  }
  return envelope;
}

async function read({ client, event }: Reader, id: string): Promise<Seen | undefined> {
  const reward = await readReward(client, event.id, id, false);
  return reward === undefined
    ? undefined
    : { view: auditView(reward), name: reward.name, record: reward };
}

const emptyBody = z.strictObject({});

function parse(op: ItemOp, body: Record<string, unknown>): Parsed {
  return parseWith(op === "add" ? rewardBody : op === "edit" ? rewardPatch : emptyBody, body);
}

/** What the builder would refuse about the stock of an existing reward, or null. */
function stockProblem(
  current: RewardRecord | undefined,
  input: EditInput,
  stock: number,
): ApiErrorEnvelope | null {
  if (current === undefined) {
    return null;
  }
  if (stock < current.unitsOut) {
    return refusedBy({ kind: "stock_below_reserved", unitsOut: current.unitsOut });
  }
  return current.kind === "digital" && input.stock !== undefined && input.stock !== current.stock
    ? refusedBy({ kind: "stock_from_codes" })
    : null;
}

function mergedAfter(
  { event }: Reader,
  current: RewardRecord | undefined,
  input: EditInput & { kind?: RewardRecord["kind"] },
): After {
  const fields = mergeReward(current, input, event.timezone);
  if ("kind" in fields) {
    return { ok: false, problem: refusedBy(fields) };
  }
  const problem = stockProblem(current, input, fields.stock);
  if (problem !== null) {
    return { ok: false, problem };
  }
  const kind = current?.kind ?? input.kind ?? "item";
  return {
    ok: true,
    view: auditView({ ...fields, kind, id: "", unitsOut: 0, position: 0 }),
    name: fields.name,
  };
}

function after(reader: Reader, op: ItemOp, seen: Seen | undefined, input: unknown): Promise<After> {
  if (op === "add") {
    return Promise.resolve(mergedAfter(reader, undefined, input as AddInput));
  }
  const current = seen?.record as RewardRecord;
  return Promise.resolve(
    op === "edit"
      ? mergedAfter(reader, current, input as EditInput)
      : { ok: true, view: null, name: current.name },
  );
}

export const rewardKind: TargetKind = {
  invalid: (field) => invalidReward({ field }).envelope,
  read,
  parse,
  after,
  async run({ pool, codeKey, actor, caller, eventId }, item, input) {
    const deps = { pool, codeKey };
    if (item.op === "add") {
      return refusalOf(await createReward(deps, actor, eventId, input as AddInput, caller));
    }
    const target = { eventId, id: item.targetId as string };
    return refusalOf(
      item.op === "edit"
        ? await updateReward(deps, actor, target, input as EditInput, caller)
        : await removeReward(deps, actor, target, caller),
    );
  },
};
