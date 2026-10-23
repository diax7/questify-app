import { PASSPORT_STEPS_MAX, type QuestType } from "@questify/shared";
import type { PoolClient } from "pg";
import { bilingual, NO_TEXT, type QuestInput, type Refused } from "#src/quests/builder";
import {
  stampedSteps,
  type QuestFields,
  type QuestRecord,
  type StepInput,
} from "#src/quests/store";

type Checked = Readonly<{ kind: "steps"; steps: readonly StepInput[] | undefined }>;
const NOTHING: Checked = { kind: "steps", steps: undefined };

/**
 * A passport's steps after this input (T-304b, ADR-203), checked as one whole, or the refusal. `steps` is undefined
 * when there is nothing to write: another type, or an edit that leaves the steps alone.
 *
 * Every step has a name in at least one language; an id names one of this quest's own steps, once; there are 1 to 30
 * steps and at least `needed`. Once players stamped it, a stamped step stays and `needed` never falls (the database
 * holds both too, migration 0045).
 */
export async function passportSteps(
  client: PoolClient,
  current: QuestRecord | undefined,
  type: QuestType,
  fields: QuestFields,
  input: QuestInput["steps"],
): Promise<Checked | Refused> {
  if (type !== "passport") {
    return input === undefined ? NOTHING : { kind: "invalid", field: "steps" };
  }
  const steps =
    input?.map((step) => ({ id: step.id, name: bilingual(step.name, NO_TEXT) })) ??
    current?.steps.map((step) => ({ id: step.id, name: step.name }));
  if (steps === undefined || !wellFormed(steps, current)) {
    return { kind: "invalid", field: "steps" };
  }
  const needed = Number(fields.config["needed"]);
  if (needed > steps.length) {
    return { kind: "invalid", field: "needed" };
  }
  if (current === undefined) {
    return { kind: "steps", steps };
  }
  const stamped = await stampedSteps(client, current.id);
  if (stamped.size > 0 && needed < Number(current.config["needed"])) {
    return { kind: "invalid", field: "needed" };
  }
  const kept = new Set(steps.map((step) => step.id));
  if ([...stamped].some((id) => !kept.has(id))) {
    return { kind: "step_in_use" };
  }
  return input === undefined ? NOTHING : { kind: "steps", steps };
}

function wellFormed(steps: readonly StepInput[], current: QuestRecord | undefined): boolean {
  const own = new Set(current?.steps.map((step) => step.id));
  const ids = steps.flatMap((step) => (step.id === undefined ? [] : [step.id]));
  return (
    steps.length >= 1 &&
    steps.length <= PASSPORT_STEPS_MAX &&
    steps.every((step) => step.name.ar !== null || step.name.en !== null) &&
    new Set(ids).size === ids.length &&
    ids.every((id) => own.has(id))
  );
}
